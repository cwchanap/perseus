/**
 * Cloudflare Access token management: resolve, cache, probe, interactive prompt.
 *
 * Supports three token sources (tried in order):
 *  1. Explicit --cf-access-token arg / CF_ACCESS_TOKEN env
 *  2. Cached token from `set-token` command
 *  3. cloudflared access token (best-effort, often fails on this setup)
 *
 * Service tokens (CF_ACCESS_CLIENT_ID/SECRET) are handled separately in the
 * HTTP helpers — they don't go through this module.
 */

import { join, dirname } from 'node:path';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { $ } from 'bun';
import { WORKER_AUTH_ERROR_CODE } from '@perseus/types';
import { ACCESS_AUD, PROBE_TIMEOUT_MS, accessAppFor, tokenBasenameFor } from './types';

function homeCloudflaredDir(): string {
	// os.homedir() is cross-platform: it returns USERPROFILE on Windows and
	// HOME on POSIX. The previous `process.env.HOME ?? ''` fallback was unset
	// on Windows, resolving `.cloudflared` to the filesystem root.
	return join(homedir(), '.cloudflared');
}

export function cloudflaredTokenPath(server: string): string | undefined {
	if (!ACCESS_AUD) return undefined;
	return join(homeCloudflaredDir(), tokenBasenameFor(server, ACCESS_AUD));
}

export function cloudflaredLockPath(server: string): string | undefined {
	const tokenPath = cloudflaredTokenPath(server);
	return tokenPath ? `${tokenPath}.lock` : undefined;
}

function normalizeToken(raw: string): string {
	return raw
		.trim()
		.replace(/^CF_Authorization=/i, '')
		.replace(/^Bearer\s+/i, '');
}

function isJwtLike(token: string): boolean {
	// Normalize first so "Bearer <jwt>" and "CF_Authorization=<jwt>" paste
	// forms are accepted on the explicit/env paths (not only file reads).
	const t = normalizeToken(token);
	return (
		t.split('.').length >= 3 && t.length > 40 && !/\s/.test(t) && !t.includes('Unable to find')
	);
}

function unquoteEnvValue(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export async function loadDotEnvMap(root: string): Promise<Record<string, string>> {
	const envPath = join(root, 'apps/api/.env');
	const file = Bun.file(envPath);
	if (!(await file.exists())) return {};
	const text = await file.text();
	const map: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		map[key] = unquoteEnvValue(trimmed.slice(eq + 1));
	}
	return map;
}

function readTokenFile(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const token = normalizeToken(readFileSync(path, 'utf8'));
		return isJwtLike(token) ? token : undefined;
	} catch (err) {
		// A missing file is the normal "no cached token" case — return
		// undefined so the caller falls through to the next source. Other
		// errors (EACCES on a misconfigured 0600 owned by another user, a
		// transient read failure) would otherwise be silently masked as "no
		// cached token" and send the operator down the wrong debugging path.
		// Surface those as a warning but still return undefined so the CLI
		// can degrade gracefully to the interactive prompt instead of
		// aborting mid-flow.
		if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		console.warn(`Failed to read token cache at ${path}:`, err);
		return undefined;
	}
}

export function clearStaleAccessLock(server: string): void {
	const lockPath = cloudflaredLockPath(server);
	if (!lockPath || !existsSync(lockPath)) return;
	try {
		const raw = readFileSync(lockPath, 'utf8').trim();
		const parsed = JSON.parse(raw) as { pid?: number };
		const pid = parsed.pid;
		if (typeof pid === 'number' && pid > 0) {
			try {
				process.kill(pid, 0);
				console.log(`cloudflared login still running (pid ${pid}). Stop it first if stuck.`);
				return;
			} catch {
				// dead
			}
		}
		unlinkSync(lockPath);
		console.log(`Removed stale Access lock: ${lockPath}`);
	} catch {
		// ignore
	}
}

/** Max wall time for `cloudflared access token` before treating it as unavailable. */
export const CLOUDFLARED_TOKEN_TIMEOUT_MS = 15_000;

export async function resolveCloudflaredToken(server: string): Promise<string | undefined> {
	const tokenPath = cloudflaredTokenPath(server);
	const fromFile = tokenPath ? readTokenFile(tokenPath) : undefined;
	if (fromFile) return fromFile;
	if (!ACCESS_AUD) {
		// Without the CLI app's AUD we can't run `cloudflared access token` —
		// cloudflared would cache the token under a filename derived from the
		// app's actual AUD, which wouldn't match our path. Skip the subprocess
		// rather than spawning a login flow that produces an unfindable cache.
		return undefined;
	}
	try {
		const accessApp = accessAppFor(server);
		// Bound wall time: cloudflared can hang indefinitely waiting for an
		// interactive browser login when no cached token exists. Use Bun.spawn
		// (not the $ shell) so we retain a Subprocess handle we can kill on
		// timeout — otherwise the orphaned cloudflared process keeps waiting
		// for a browser login that never comes.
		const proc = Bun.spawn(['cloudflared', 'access', 'token', '-app', accessApp], {
			stdout: 'pipe',
			stderr: 'pipe'
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const out = await Promise.race([
				proc.stdout.text(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('cloudflared access token timed out')),
						CLOUDFLARED_TOKEN_TIMEOUT_MS
					);
				})
			]);
			if (timer) clearTimeout(timer);
			const err = await proc.stderr.text();
			const trimmed = out.trim();
			if (
				`${trimmed}\n${err}`.includes('Unable to find') ||
				`${trimmed}\n${err}`.includes('failed to find')
			) {
				return undefined;
			}
			return isJwtLike(trimmed) ? normalizeToken(trimmed) : undefined;
		} catch {
			// Timeout or stdout read failure: clear the timer and terminate
			// the orphaned cloudflared subprocess so it can't hang waiting
			// for an interactive browser login.
			if (timer) clearTimeout(timer);
			if (!proc.killed) {
				try {
					proc.kill();
				} catch {
					// Process may have exited between the check and kill.
				}
			}
			return undefined;
		}
	} catch {
		return undefined;
	}
}

export async function resolveAccessToken(options: {
	explicit?: string;
	tokenCachePath: string;
	skipAccess: boolean;
	server: string;
}): Promise<string | undefined> {
	if (options.skipAccess) return undefined;
	if (options.explicit && isJwtLike(options.explicit)) return normalizeToken(options.explicit);
	const fromEnv = process.env.CF_ACCESS_TOKEN;
	if (fromEnv && isJwtLike(fromEnv)) return normalizeToken(fromEnv);
	const fromCache = readTokenFile(options.tokenCachePath);
	if (fromCache) return fromCache;
	return resolveCloudflaredToken(options.server);
}

export function cacheToken(tokenCachePath: string, token: string): void {
	mkdirSync(dirname(tokenCachePath), { recursive: true });
	writeFileSync(tokenCachePath, `${normalizeToken(token)}\n`, { mode: 0o600 });
	// writeFileSync applies `mode` only when creating the file. If the cache
	// already exists with permissive permissions, rewriting it leaves the new
	// JWT readable by other local users. Explicitly chmod on every write so
	// the token is always 0600 regardless of prior file state.
	chmodSync(tokenCachePath, 0o600);
}

async function promptLine(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await new Promise((resolve) => {
			rl.question(question, (answer) => resolve(answer));
		});
	} finally {
		rl.close();
	}
}

export async function promptTokenInteractive(server: string): Promise<string> {
	// Open the CLI Access app path (not /admin): JWT audience must match
	// `Perseus Admin CLI`, which protects /api/admin/puzzles and /api/admin/login.
	const accessApp = accessAppFor(server);
	console.log(`
────────────────────────────────────────────────────────────
  Set Cloudflare Access token (recommended path)
────────────────────────────────────────────────────────────
1. Ensure Cloudflare WARP is Connected
2. Open: ${accessApp}
3. Complete Access login if prompted
4. Open DevTools → Application → Cookies → ${server.replace('https://', '')}
5. Copy the value of cookie: CF_Authorization
6. Paste it below (input is visible — paste carefully)
────────────────────────────────────────────────────────────
`);
	// Try opening browser (platform-specific)
	const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
	await $`${opener} ${accessApp}`.quiet().nothrow();

	const raw = await promptLine('Paste CF_Authorization JWT: ');
	const token = normalizeToken(raw);
	if (!isJwtLike(token)) {
		throw new Error('That does not look like a JWT. Copy the full CF_Authorization cookie value.');
	}
	return token;
}

/**
 * Check whether a 401 response originated from the worker's requireAuth
 * middleware (JSON body `{"error":"unauthorized",...}`) rather than from
 * Cloudflare Access. Access can return 401 for rejected tokens when the
 * policy's "respond with 401" toggle is enabled — without this check, an
 * invalid/expired token would be indistinguishable from a valid one that
 * reached the worker without a Perseus session.
 */
async function isWorkerAuth401(res: Response): Promise<boolean> {
	try {
		const body = await res.text();
		const parsed = JSON.parse(body) as { error?: unknown };
		return parsed?.error === WORKER_AUTH_ERROR_CODE;
	} catch {
		return false;
	}
}

/**
 * Probe whether Access accepts this JWT by hitting an admin endpoint that does
 * NOT require a passkey (GET /api/admin/puzzles). Avoids POSTing to /login,
 * which would trip the loginRateLimit middleware and block the real upload.
 * 302/403 = Access blocked; 200 = passed Access; 401 = ambiguous (see below).
 *
 * 401 is disambiguated by inspecting the body: the worker's requireAuth
 * middleware returns JSON `{"error":"unauthorized",...}`, while Access
 * returns its own error page. A 401 with a non-worker body is treated as
 * 'blocked' (Access rejected the token), or 'unhealthy' (Access accepted
 * the token but the backend returned 5xx — the probe reached the worker,
 * meaning Access works, but the app itself is broken and uploads will fail).
 *
 * 5xx is treated as 'unhealthy' (not 'ok') because while it confirms Access
 * accepted the token, the readiness gate's purpose is to determine whether
 * an upload can succeed — a 5xx backend means it cannot. The probe still
 * distinguishes Access acceptance (reached the worker) from rejection.
 */
export async function probeAccessToken(
	server: string,
	token: string
): Promise<'ok' | 'blocked' | 'unhealthy' | 'error'> {
	try {
		const res = await fetch(`${server}/api/admin/puzzles`, {
			method: 'GET',
			headers: {
				'cf-access-token': token,
				Cookie: `CF_Authorization=${token}`
			},
			redirect: 'manual',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		if (res.status === 302 || res.status === 403) return 'blocked';
		if (res.status === 200) return 'ok';
		if (res.status === 401) {
			// Distinguish worker 401 (Access accepted, no session) from
			// Access 401 (token rejected with 401 toggle enabled).
			return (await isWorkerAuth401(res)) ? 'ok' : 'blocked';
		}
		// 5xx means we reached the worker — Access accepted the token — but
		// the backend is unhealthy. The readiness gate must reject this so
		// the operator investigates before attempting an upload that will
		// fail for reasons unrelated to Access.
		if (res.status >= 500) {
			console.warn(
				`probeAccessToken: ${server}/api/admin/puzzles returned ${res.status} — ` +
					`Access accepted the token, but the backend is unhealthy. ` +
					`Upload will fail until the backend recovers.`
			);
			return 'unhealthy';
		}
		return 'error';
	} catch {
		return 'error';
	}
}

/**
 * Probe whether Cloudflare Access accepts a service token (CF-Access-Client-Id
 * / CF-Access-Client-Secret) by hitting an admin endpoint that does NOT require
 * a passkey (GET /api/admin/puzzles). Mirrors probeAccessToken so the
 * service-token path gets the same live smoke check as the JWT path — without
 * it, an expired/invalid service token only surfaces as an opaque login
 * failure after the upload has already begun.
 *
 * 302/403 = Access blocked; 200 = reached the worker; 401 = ambiguous (see
 * below). 401 is disambiguated by inspecting the body: the worker's
 * requireAuth returns JSON `{"error":"unauthorized",...}`, while Access
 * returns its own error page. A 401 with a non-worker body is treated as
 * 'blocked' (Access rejected the service token, e.g. with the 401 toggle).
 * 5xx = Access accepted the service token but the backend is unhealthy.
 *
 * Avoids POSTing to /login, which would trip the loginRateLimit middleware.
 */
export async function probeServiceToken(
	server: string,
	cfClientId: string,
	cfClientSecret: string
): Promise<'ok' | 'blocked' | 'unhealthy' | 'error'> {
	try {
		const res = await fetch(`${server}/api/admin/puzzles`, {
			method: 'GET',
			headers: {
				'CF-Access-Client-Id': cfClientId,
				'CF-Access-Client-Secret': cfClientSecret
			},
			redirect: 'manual',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
		});
		if (res.status === 302 || res.status === 403) return 'blocked';
		if (res.status === 200) return 'ok';
		if (res.status === 401) {
			return (await isWorkerAuth401(res)) ? 'ok' : 'blocked';
		}
		// See probeAccessToken for the rationale on treating 5xx as
		// 'unhealthy': Access accepted the service token, but the backend
		// is broken and uploads will fail until it recovers.
		if (res.status >= 500) {
			console.warn(
				`probeServiceToken: ${server}/api/admin/puzzles returned ${res.status} — ` +
					`Access accepted the service token, but the backend is unhealthy. ` +
					`Upload will fail until the backend recovers.`
			);
			return 'unhealthy';
		}
		return 'error';
	} catch {
		return 'error';
	}
}
