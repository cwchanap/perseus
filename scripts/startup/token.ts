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
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { $ } from 'bun';
import { ACCESS_AUD, PROBE_TIMEOUT_MS, accessAppFor, adminUiFor, tokenBasenameFor } from './types';

function homeCloudflaredDir(): string {
	return join(process.env.HOME ?? '', '.cloudflared');
}

export function cloudflaredTokenPath(server: string): string {
	return join(homeCloudflaredDir(), tokenBasenameFor(server, ACCESS_AUD));
}

export function cloudflaredLockPath(server: string): string {
	return `${cloudflaredTokenPath(server)}.lock`;
}

function isJwtLike(token: string): boolean {
	const t = token.trim().replace(/^CF_Authorization=/i, '');
	return (
		t.split('.').length >= 3 && t.length > 40 && !/\s/.test(t) && !t.includes('Unable to find')
	);
}

function normalizeToken(raw: string): string {
	return raw
		.trim()
		.replace(/^CF_Authorization=/i, '')
		.replace(/^Bearer\s+/i, '');
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
	} catch {
		return undefined;
	}
}

export function clearStaleAccessLock(server: string): void {
	const lockPath = cloudflaredLockPath(server);
	if (!existsSync(lockPath)) return;
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

export async function resolveCloudflaredToken(server: string): Promise<string | undefined> {
	const fromFile = readTokenFile(cloudflaredTokenPath(server));
	if (fromFile) return fromFile;
	try {
		const accessApp = accessAppFor(server);
		const result = await $`cloudflared access token -app ${accessApp}`.quiet().nothrow();
		const out = result.stdout.toString().trim();
		const err = result.stderr.toString();
		if (
			`${out}\n${err}`.includes('Unable to find') ||
			`${out}\n${err}`.includes('failed to find')
		) {
			return undefined;
		}
		return isJwtLike(out) ? normalizeToken(out) : undefined;
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
	const adminUi = adminUiFor(server);
	console.log(`
────────────────────────────────────────────────────────────
  Set Cloudflare Access token (recommended path)
────────────────────────────────────────────────────────────
1. Ensure Cloudflare WARP is Connected
2. Open: ${adminUi}
3. Complete Access login if prompted
4. Open DevTools → Application → Cookies → ${server.replace('https://', '')}
5. Copy the value of cookie: CF_Authorization
6. Paste it below (input is visible — paste carefully)
────────────────────────────────────────────────────────────
`);
	// Try opening browser (platform-specific)
	const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
	await $`${opener} ${adminUi}`.quiet().nothrow();

	const raw = await promptLine('Paste CF_Authorization JWT: ');
	const token = normalizeToken(raw);
	if (!isJwtLike(token)) {
		throw new Error('That does not look like a JWT. Copy the full CF_Authorization cookie value.');
	}
	return token;
}

/**
 * Probe whether Access accepts this JWT by hitting an admin endpoint that does
 * NOT require a passkey (GET /api/admin/puzzles). Avoids POSTing to /login,
 * which would trip the loginRateLimit middleware and block the real upload.
 * 302/403 = Access blocked; 401/200 = passed Access (app-level auth required).
 *
 * 5xx is treated as 'ok' because it means the request reached the worker —
 * Access passed it through. The probe tests Access acceptance, not app health.
 */
export async function probeAccessToken(
	server: string,
	token: string
): Promise<'ok' | 'blocked' | 'error'> {
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
		// 401 = reached the app (no admin session), 200 = reached the app
		if (res.status === 200 || res.status === 401) return 'ok';
		// 5xx still means we reached the worker — Access accepted the token
		if (res.status >= 500) return 'ok';
		return 'error';
	} catch {
		return 'error';
	}
}
