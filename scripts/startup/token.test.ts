import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
	probeAccessToken,
	probeServiceToken,
	resolveAccessToken,
	cacheToken,
	cloudflaredTokenPath,
	cloudflaredLockPath,
	clearStaleAccessLock,
	loadDotEnvMap
} from './token';

// Build a fake JWT that passes isJwtLike: 3+ dot-separated parts, > 40 chars,
// no whitespace, no "Unable to find".
function fakeJwt(): string {
	return `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
}

// ─── probeAccessToken ───────────────────────────────────────────────
// Covers all 5 code paths:
//   302/403 → 'blocked'
//   200/401 → 'ok'
//   5xx     → 'ok' (reached the worker — Access accepted the token)
//   other   → 'error'
//   catch   → 'error' (network failure / timeout)

describe('probeAccessToken', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns "blocked" on 302 (Access redirect)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 302 })
		) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('blocked');
	});

	it('returns "blocked" on 403 (Access denied)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 403 })
		) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('blocked');
	});

	it('returns "ok" on 200 (reached the app, admin session present)', async () => {
		globalThis.fetch = mock(
			async () => new Response('[]', { status: 200 })
		) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('ok');
	});

	it('returns "ok" on 401 (reached the app, no admin session)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 401 })
		) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('ok');
	});

	it('returns "ok" on 500 (reached the worker — Access passed it through)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 500 })
		) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('ok');
	});

	it('returns "ok" on 503 (transient worker error — Access still passed)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 503 })
		) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('ok');
	});

	it('returns "error" on unexpected status (e.g. 404)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 404 })
		) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('error');
	});

	it('returns "error" on network failure (fetch throws)', async () => {
		globalThis.fetch = mock(async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		expect(await probeAccessToken('https://example.com', 'jwt-token')).toBe('error');
	});

	it('sends cf-access-token header and CF_Authorization cookie', async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response('', { status: 200 });
		}) as unknown as typeof fetch;

		await probeAccessToken('https://example.com', 'my-jwt');
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers['cf-access-token']).toBe('my-jwt');
		expect(headers['Cookie']).toBe('CF_Authorization=my-jwt');
	});

	it('uses manual redirect (does not follow 302)', async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response('', { status: 302 });
		}) as unknown as typeof fetch;

		await probeAccessToken('https://example.com', 'jwt');
		expect(capturedInit?.redirect).toBe('manual');
	});
});

// ─── probeServiceToken ─────────────────────────────────────────────
// Mirrors probeAccessToken coverage for the service-token (CF-Access-Client-Id
// / CF-Access-Client-Secret) auth path.

describe('probeServiceToken', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns "blocked" on 302 (Access redirect)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 302 })
		) as unknown as typeof fetch;
		expect(await probeServiceToken('https://example.com', 'cid', 'csec')).toBe('blocked');
	});

	it('returns "blocked" on 403 (Access denied)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 403 })
		) as unknown as typeof fetch;
		expect(await probeServiceToken('https://example.com', 'cid', 'csec')).toBe('blocked');
	});

	it('returns "ok" on 200 (reached the app)', async () => {
		globalThis.fetch = mock(
			async () => new Response('[]', { status: 200 })
		) as unknown as typeof fetch;
		expect(await probeServiceToken('https://example.com', 'cid', 'csec')).toBe('ok');
	});

	it('returns "ok" on 401 (reached the app, no admin session)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 401 })
		) as unknown as typeof fetch;
		expect(await probeServiceToken('https://example.com', 'cid', 'csec')).toBe('ok');
	});

	it('returns "ok" on 500 (reached the worker — Access passed it through)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 500 })
		) as unknown as typeof fetch;
		expect(await probeServiceToken('https://example.com', 'cid', 'csec')).toBe('ok');
	});

	it('returns "error" on unexpected status (e.g. 404)', async () => {
		globalThis.fetch = mock(
			async () => new Response('', { status: 404 })
		) as unknown as typeof fetch;
		expect(await probeServiceToken('https://example.com', 'cid', 'csec')).toBe('error');
	});

	it('returns "error" on network failure (fetch throws)', async () => {
		globalThis.fetch = mock(async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		expect(await probeServiceToken('https://example.com', 'cid', 'csec')).toBe('error');
	});

	it('sends CF-Access-Client-Id/Secret headers', async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response('', { status: 200 });
		}) as unknown as typeof fetch;

		await probeServiceToken('https://example.com', 'the-id', 'the-secret');
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers['CF-Access-Client-Id']).toBe('the-id');
		expect(headers['CF-Access-Client-Secret']).toBe('the-secret');
	});

	it('uses manual redirect (does not follow 302)', async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response('', { status: 302 });
		}) as unknown as typeof fetch;

		await probeServiceToken('https://example.com', 'cid', 'csec');
		expect(capturedInit?.redirect).toBe('manual');
	});
});

// ─── resolveAccessToken ─────────────────────────────────────────────

describe('resolveAccessToken', () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'perseus-token-'));
		delete process.env.CF_ACCESS_TOKEN;
		// Redirect HOME to a temp dir so resolveCloudflaredToken cannot find
		// real cached credentials in ~/.cloudflared/ or invoke cloudflared
		// with real auth state. The temp dir has no .cloudflared/ so the
		// token file read fails, keeping the cloudflared fallback
		// deterministic (returns undefined) without spawning a real binary
		// or touching real credentials.
		originalHome = process.env.HOME;
		process.env.HOME = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		process.env.HOME = originalHome;
		// Restore env
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('returns undefined when skipAccess is true', async () => {
		const result = await resolveAccessToken({
			tokenCachePath: join(tmpDir, 'token'),
			skipAccess: true,
			server: 'https://example.com'
		});
		expect(result).toBeUndefined();
	});

	it('returns explicit token when it is JWT-like', async () => {
		const jwt = fakeJwt();
		const result = await resolveAccessToken({
			explicit: jwt,
			tokenCachePath: join(tmpDir, 'token'),
			skipAccess: false,
			server: 'https://example.com'
		});
		expect(result).toBe(jwt);
	});

	it('normalizes CF_Authorization= prefix from explicit token', async () => {
		const jwt = fakeJwt();
		const result = await resolveAccessToken({
			explicit: `CF_Authorization=${jwt}`,
			tokenCachePath: join(tmpDir, 'token'),
			skipAccess: false,
			server: 'https://example.com'
		});
		expect(result).toBe(jwt);
	});

	it('rejects Bearer-prefixed explicit token (isJwtLike runs before normalize)', async () => {
		// isJwtLike rejects whitespace, so "Bearer <jwt>" fails the check and
		// falls through to env/cache/cloudflared. Bearer normalization in
		// normalizeToken is only for file-read tokens, not the explicit path.
		const jwt = fakeJwt();
		const result = await resolveAccessToken({
			explicit: `Bearer ${jwt}`,
			tokenCachePath: join(tmpDir, 'nonexistent'),
			skipAccess: false,
			server: 'https://example.com'
		});
		expect(result).toBeUndefined();
	});

	it('falls through when explicit token is not JWT-like', async () => {
		// "short" is < 40 chars and doesn't have 3 parts — not JWT-like.
		// No env, no cache file, cloudflared will fail (mocked to throw).
		const result = await resolveAccessToken({
			explicit: 'short',
			tokenCachePath: join(tmpDir, 'nonexistent'),
			skipAccess: false,
			server: 'https://example.com'
		});
		expect(result).toBeUndefined();
	});

	it('returns token from CF_ACCESS_TOKEN env when JWT-like', async () => {
		const jwt = fakeJwt();
		process.env.CF_ACCESS_TOKEN = jwt;
		const result = await resolveAccessToken({
			tokenCachePath: join(tmpDir, 'nonexistent'),
			skipAccess: false,
			server: 'https://example.com'
		});
		expect(result).toBe(jwt);
	});

	it('returns cached token from file when it is JWT-like', async () => {
		const cachePath = join(tmpDir, 'cached-token');
		const jwt = fakeJwt();
		cacheToken(cachePath, jwt);
		const result = await resolveAccessToken({
			tokenCachePath: cachePath,
			skipAccess: false,
			server: 'https://example.com'
		});
		expect(result).toBe(jwt);
	});

	it('returns undefined when cache file does not exist and cloudflared fails', async () => {
		const result = await resolveAccessToken({
			tokenCachePath: join(tmpDir, 'nonexistent'),
			skipAccess: false,
			server: 'https://example.com'
		});
		expect(result).toBeUndefined();
	});
});

// ─── cacheToken ─────────────────────────────────────────────────────

describe('cacheToken', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'perseus-cache-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('writes token to file with trailing newline', () => {
		const path = join(tmpDir, 'sub', 'token');
		const jwt = fakeJwt();
		cacheToken(path, jwt);
		expect(existsSync(path)).toBe(true);
		const content = readFileSync(path, 'utf8');
		expect(content).toBe(`${jwt}\n`);
	});

	it('normalizes CF_Authorization= prefix before writing', () => {
		const path = join(tmpDir, 'token');
		const jwt = fakeJwt();
		cacheToken(path, `CF_Authorization=${jwt}`);
		expect(readFileSync(path, 'utf8').trim()).toBe(jwt);
	});

	it('creates parent directories if they do not exist', () => {
		const path = join(tmpDir, 'a', 'b', 'c', 'token');
		cacheToken(path, fakeJwt());
		expect(existsSync(path)).toBe(true);
	});
});

// ─── cloudflaredTokenPath / cloudflaredLockPath ─────────────────────

describe('cloudflaredTokenPath', () => {
	it('returns path under .cloudflared with hostname-aud-token basename', () => {
		const path = cloudflaredTokenPath('https://example.com');
		expect(path).toContain('.cloudflared');
		expect(path).toContain('example.com');
		expect(path.endsWith('-token')).toBe(true);
	});

	it('cloudflaredLockPath appends .lock', () => {
		const lockPath = cloudflaredLockPath('https://example.com');
		expect(lockPath.endsWith('.lock')).toBe(true);
	});
});

// ─── clearStaleAccessLock ───────────────────────────────────────────

describe('clearStaleAccessLock', () => {
	let tmpDir: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'perseus-lock-'));
		// Redirect HOME so cloudflaredLockPath resolves under the temp dir
		// and clearStaleAccessLock operates on a path we control.
		originalHome = process.env.HOME;
		process.env.HOME = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		process.env.HOME = originalHome;
	});

	it('does nothing when lock file does not exist', () => {
		// Should not throw
		clearStaleAccessLock('https://nonexistent-host-example.com');
	});

	it('removes lock file when pid is dead', () => {
		// Place the lock file at the function's actual cloudflared lock path
		// (resolved via HOME override above). Use a PID that definitely
		// doesn't exist (999999).
		const server = 'https://dead-pid-test-example.com';
		const lockPath = cloudflaredLockPath(server);
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
		expect(existsSync(lockPath)).toBe(true);

		clearStaleAccessLock(server);

		expect(existsSync(lockPath)).toBe(false);
	});
});

// ─── loadDotEnvMap ──────────────────────────────────────────────────

describe('loadDotEnvMap', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'perseus-dotenv-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('returns empty map when .env does not exist', async () => {
		const map = await loadDotEnvMap(tmpDir);
		expect(Object.keys(map)).toHaveLength(0);
	});

	it('parses key=value lines from apps/api/.env', async () => {
		const apiDir = join(tmpDir, 'apps', 'api');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(apiDir, { recursive: true });
		writeFileSync(join(apiDir, '.env'), 'ADMIN_PASSKEY=secret123\nCF_ACCESS_CLIENT_ID=abc\n');

		const map = await loadDotEnvMap(tmpDir);
		expect(map.ADMIN_PASSKEY).toBe('secret123');
		expect(map.CF_ACCESS_CLIENT_ID).toBe('abc');
	});

	it('skips comments and blank lines', async () => {
		const apiDir = join(tmpDir, 'apps', 'api');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(apiDir, { recursive: true });
		writeFileSync(join(apiDir, '.env'), '# comment\n\nADMIN_PASSKEY=secret\n');

		const map = await loadDotEnvMap(tmpDir);
		expect(Object.keys(map)).toEqual(['ADMIN_PASSKEY']);
		expect(map.ADMIN_PASSKEY).toBe('secret');
	});

	it('strips surrounding quotes from values', async () => {
		const apiDir = join(tmpDir, 'apps', 'api');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(apiDir, { recursive: true });
		writeFileSync(join(apiDir, '.env'), 'KEY1="double"\nKEY2=\'single\'\nKEY3=noquote\n');

		const map = await loadDotEnvMap(tmpDir);
		expect(map.KEY1).toBe('double');
		expect(map.KEY2).toBe('single');
		expect(map.KEY3).toBe('noquote');
	});
});
