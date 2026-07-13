#!/usr/bin/env bun

/**
 * Bulk-upload startup puzzle images from scripts/startup-seed/.
 *
 * Production admin API is behind Cloudflare Access. For non-interactive CLI use,
 * Cloudflare's supported approach is Access **service tokens** (not browser cookies
 * or cloudflared access login):
 *
 *   https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
 *
 * After infra deploy provisions the CLI service token + Service Auth policy:
 *
 *   export CF_ACCESS_CLIENT_ID="$(cd packages/infrastructure && pulumi stack output adminCliAccessClientId)"
 *   export CF_ACCESS_CLIENT_SECRET="$(cd packages/infrastructure && pulumi stack output --show-secrets adminCliAccessClientSecret)"
 *   bun run admin:startup:upload -- --limit 5
 *
 * Or put CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET next to ADMIN_PASSKEY in apps/api/.env.
 */

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { $ } from 'bun';

const DEFAULT_SERVER = 'https://perseus.cwchanap.dev';
const ACCESS_APP = 'https://perseus.cwchanap.dev/api/admin';
const ADMIN_UI = 'https://perseus.cwchanap.dev/admin';
const ACCESS_AUD = '7fd50c02b28c32fe3abb938cebba2dc9dcec6c88f42969c28700e9a0a8a28e5f';
const TOKEN_BASENAME = `perseus.cwchanap.dev-${ACCESS_AUD}-token`;

export interface CatalogEntry {
	id: string;
	name: string;
	category: string;
	aspectRatio: string;
	pieceCount: number;
	prompt: string;
}

export interface Options {
	command: 'login' | 'set-token' | 'upload' | 'status';
	server: string;
	passkey: string;
	catalogPath: string;
	imagesDir: string;
	tokenCachePath: string;
	cfAccessToken?: string;
	cfClientId?: string;
	cfClientSecret?: string;
	dryRun: boolean;
	from: number;
	to: number;
	limit?: number;
	delayMs: number;
	skipAccess: boolean;
}

function usage(exitCode = 1): never {
	console.error(`Usage:
  bun scripts/admin-bulk-upload-startup.ts <command> [options]

Commands:
  set-token   Paste CF_Authorization JWT (recommended for prod)
  login       Try cloudflared Access login, then fall back to set-token
  status      Check token + passkey readiness
  upload      Upload catalog images

Options:
  --server <url>           API base (default: ${DEFAULT_SERVER})
  --passkey <value>        Admin passkey (or ADMIN_PASSKEY / apps/api/.env)
  --cf-access-token <jwt>  Access JWT (or CF_ACCESS_TOKEN / cached set-token)
  --from <n>               Start catalog id (default: 1)
  --to <n>                 End catalog id (default: all)
  --limit <n>              Upload at most N entries from --from
  --delay-ms <n>           Delay between uploads (default: 1500)
  --skip-access            Local API only (no Access headers)
  --dry-run                Plan only
  -h, --help

Recommended flow:
  # Browser: open ${ADMIN_UI} with WARP connected, complete Access
  # DevTools → Application → Cookies → CF_Authorization → copy value
  bun run admin:startup:set-token
  bun run admin:startup:status
  bun run admin:startup:upload -- --limit 5
`);
	process.exit(exitCode);
}

function readArg(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) usage();
	return value;
}

function parseIntArg(raw: string | undefined, label: string, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || String(n) !== raw) {
		console.error(`${label} must be a base-10 integer`);
		process.exit(1);
	}
	return n;
}

function homeCloudflaredDir(): string {
	return join(process.env.HOME ?? '', '.cloudflared');
}

function cloudflaredTokenPath(): string {
	return join(homeCloudflaredDir(), TOKEN_BASENAME);
}

function cloudflaredLockPath(): string {
	return `${cloudflaredTokenPath()}.lock`;
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

async function loadDotEnvMap(root: string): Promise<Record<string, string>> {
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

function clearStaleAccessLock(): void {
	const lockPath = cloudflaredLockPath();
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

async function resolveCloudflaredToken(): Promise<string | undefined> {
	const fromFile = readTokenFile(cloudflaredTokenPath());
	if (fromFile) return fromFile;
	try {
		const result = await $`cloudflared access token -app ${ACCESS_APP}`.quiet().nothrow();
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

async function resolveAccessToken(options: {
	explicit?: string;
	tokenCachePath: string;
	skipAccess: boolean;
}): Promise<string | undefined> {
	if (options.skipAccess) return undefined;
	if (options.explicit && isJwtLike(options.explicit)) return normalizeToken(options.explicit);
	const fromEnv = process.env.CF_ACCESS_TOKEN;
	if (fromEnv && isJwtLike(fromEnv)) return normalizeToken(fromEnv);
	const fromCache = readTokenFile(options.tokenCachePath);
	if (fromCache) return fromCache;
	return resolveCloudflaredToken();
}

function cacheToken(tokenCachePath: string, token: string): void {
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

async function promptTokenInteractive(): Promise<string> {
	console.log(`
────────────────────────────────────────────────────────────
  Set Cloudflare Access token (recommended path)
────────────────────────────────────────────────────────────
1. Ensure Cloudflare WARP is Connected
2. Open: ${ADMIN_UI}
3. Complete Access login if prompted
4. Open DevTools → Application → Cookies → ${DEFAULT_SERVER.replace('https://', '')}
5. Copy the value of cookie: CF_Authorization
6. Paste it below (input is visible — paste carefully)
────────────────────────────────────────────────────────────
`);
	// Try opening browser
	await $`open ${ADMIN_UI}`.quiet().nothrow();

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
 */
async function probeAccessToken(
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
			redirect: 'manual'
		});
		if (res.status === 302 || res.status === 403) return 'blocked';
		// 401 = reached the app (no admin session), 200 = reached the app
		if (res.status === 200 || res.status === 401) return 'ok';
		// 5xx still means we reached the worker
		if (res.status >= 500) return 'ok';
		return 'error';
	} catch {
		return 'error';
	}
}

async function parseOptions(): Promise<Options> {
	const args = Bun.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) usage(0);

	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const commandRaw = args.find((a) => !a.startsWith('--'));
	const allowed = new Set(['login', 'set-token', 'upload', 'status']);
	const command = allowed.has(commandRaw ?? '') ? (commandRaw as Options['command']) : 'upload';

	const from = parseIntArg(readArg(args, '--from'), '--from', 1);
	const to = parseIntArg(readArg(args, '--to'), '--to', Number.MAX_SAFE_INTEGER);
	const limitRaw = readArg(args, '--limit');
	const limit = limitRaw === undefined ? undefined : parseIntArg(limitRaw, '--limit', 0);

	const dotenv = await loadDotEnvMap(root);
	const passkey =
		readArg(args, '--passkey') ?? process.env.ADMIN_PASSKEY ?? dotenv.ADMIN_PASSKEY ?? '';

	const server = (readArg(args, '--server') ?? DEFAULT_SERVER).replace(/\/+$/, '');
	const skipAccess = args.includes('--skip-access') || /localhost|127\.0\.0\.1/.test(server);
	const tokenCachePath = join(root, 'data/startup-puzzles/.cf-access-token');
	const explicitToken = readArg(args, '--cf-access-token') ?? process.env.CF_ACCESS_TOKEN;

	const cfAccessToken = await resolveAccessToken({
		explicit: explicitToken,
		tokenCachePath,
		skipAccess
	});

	const cfClientId =
		process.env.CF_Access_Client_Id ??
		process.env.CF_ACCESS_CLIENT_ID ??
		dotenv.CF_ACCESS_CLIENT_ID;
	const cfClientSecret =
		process.env.CF_Access_Client_Secret ??
		process.env.CF_ACCESS_CLIENT_SECRET ??
		dotenv.CF_ACCESS_CLIENT_SECRET;

	return {
		command,
		server,
		passkey,
		catalogPath: readArg(args, '--catalog') ?? join(root, 'scripts/startup-seed/catalog.json'),
		imagesDir: readArg(args, '--images') ?? join(root, 'scripts/startup-seed/images'),
		tokenCachePath,
		cfAccessToken,
		cfClientId,
		cfClientSecret,
		dryRun: args.includes('--dry-run'),
		from,
		to,
		limit: limit && limit > 0 ? limit : undefined,
		delayMs: parseIntArg(readArg(args, '--delay-ms'), '--delay-ms', 1500),
		skipAccess
	};
}

function accessHeaders(options: Options): Record<string, string> {
	if (options.skipAccess) return {};
	const headers: Record<string, string> = {};
	if (options.cfAccessToken) {
		headers['cf-access-token'] = options.cfAccessToken;
		headers['Cookie'] = `CF_Authorization=${options.cfAccessToken}`;
	}
	if (options.cfClientId && options.cfClientSecret) {
		headers['CF-Access-Client-Id'] = options.cfClientId;
		headers['CF-Access-Client-Secret'] = options.cfClientSecret;
	}
	return headers;
}

function hasAccessCredentials(options: Options): boolean {
	if (options.skipAccess) return true;
	if (options.cfAccessToken) return true;
	if (options.cfClientId && options.cfClientSecret) return true;
	return false;
}

function sessionCookieFrom(response: Response, priorCookie?: string): string {
	const multi =
		typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
	const setCookie = multi[0] ?? response.headers.get('set-cookie');
	if (!setCookie) {
		throw new Error('Admin login did not return a session cookie');
	}
	const session = setCookie.split(';', 1)[0];
	if (priorCookie?.includes('CF_Authorization=')) {
		const accessPart = priorCookie
			.split(';')
			.map((p) => p.trim())
			.find((p) => p.startsWith('CF_Authorization='));
		if (accessPart) return `${session}; ${accessPart}`;
	}
	return session;
}

async function readError(response: Response): Promise<string> {
	const payload = await response
		.clone()
		.json()
		.catch(() => null);
	if (payload && typeof payload === 'object' && 'message' in payload) {
		const message = (payload as { message?: unknown }).message;
		if (typeof message === 'string') return message;
	}
	const text = await response
		.clone()
		.text()
		.catch(() => '');
	if (text.includes('Cloudflare Access') || response.status === 302 || response.status === 403) {
		return `${response.status} Cloudflare Access blocked — run: bun run admin:startup:set-token`;
	}
	return `${response.status} ${response.statusText}`;
}

export function imagePathFor(entry: CatalogEntry, imagesDir: string): string | null {
	const glob = new Bun.Glob(`${entry.id}-*.{jpg,jpeg,png,webp}`);
	const matches = [...glob.scanSync({ cwd: imagesDir, absolute: true })].sort();
	return matches[0] ?? null;
}

const MIME_BY_EXT: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp'
};

export function mimeForPath(path: string): string {
	const ext = path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
	return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchExistingNames(
	server: string,
	baseHeaders: Record<string, string>,
	cookie: string
): Promise<Set<string>> {
	try {
		const res = await fetch(`${server}/api/admin/puzzles`, {
			method: 'GET',
			headers: { ...baseHeaders, Cookie: cookie },
			redirect: 'manual'
		});
		if (!res.ok) {
			console.error(
				`Warning: could not fetch existing puzzles (${res.status}). Idempotency check skipped.`
			);
			return new Set();
		}
		const payload = (await res.json()) as { puzzles?: Array<{ name?: string }> };
		const names = new Set<string>();
		for (const p of payload.puzzles ?? []) {
			if (typeof p.name === 'string' && p.name.trim()) names.add(p.name.trim());
		}
		return names;
	} catch (error) {
		console.error(
			`Warning: failed to fetch existing puzzles (${error instanceof Error ? error.message : error}). Idempotency check skipped.`
		);
		return new Set();
	}
}

export function selectEntries(catalog: CatalogEntry[], options: Options): CatalogEntry[] {
	const filtered = catalog.filter((e) => {
		const n = Number.parseInt(e.id, 10);
		return n >= options.from && n <= options.to;
	});
	if (options.limit !== undefined) return filtered.slice(0, options.limit);
	return filtered;
}

function runCloudflaredLogin(): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn('cloudflared', ['access', 'login', ACCESS_APP], {
			stdio: 'inherit'
		});
		child.on('error', () => resolve(127));
		child.on('exit', (code) => resolve(code ?? 1));
	});
}

async function cmdSetToken(options: Options): Promise<void> {
	const token = await promptTokenInteractive();
	const probe = await probeAccessToken(options.server, token);
	if (probe === 'blocked') {
		console.error(
			'Token was saved format-wise, but Access still blocks requests (302/403).\n' +
				'Make sure you copied CF_Authorization for perseus.cwchanap.dev after a successful Access login with WARP connected.'
		);
		// still cache so user can inspect
	}
	cacheToken(options.tokenCachePath, token);
	console.log(`\nSaved Access token → ${options.tokenCachePath}`);
	console.log(`Probe: ${probe === 'ok' ? 'Access accepts token ✓' : probe}`);
	if (probe === 'ok') {
		console.log('\nNext: bun run admin:startup:upload -- --limit 5');
	} else {
		console.log('\nRe-copy the cookie after a fresh browser login and run set-token again.');
		process.exit(1);
	}
}

async function cmdLogin(options: Options): Promise<void> {
	clearStaleAccessLock();

	const existing = await resolveAccessToken({
		tokenCachePath: options.tokenCachePath,
		skipAccess: false
	});
	if (existing) {
		const probe = await probeAccessToken(options.server, existing);
		if (probe === 'ok') {
			cacheToken(options.tokenCachePath, existing);
			console.log('Existing Access token works. Ready to upload.');
			console.log('  bun run admin:startup:upload -- --limit 5');
			return;
		}
		console.log('Cached/cloudflared token present but Access rejects it — getting a fresh one.\n');
	}

	console.log(
		'Trying cloudflared access login (often fails to write the app token on this setup)…\n'
	);
	const code = await runCloudflaredLogin();
	if (code === 0) {
		for (let i = 0; i < 10; i += 1) {
			const token = await resolveCloudflaredToken();
			if (token) {
				const probe = await probeAccessToken(options.server, token);
				if (probe === 'ok') {
					cacheToken(options.tokenCachePath, token);
					console.log('\ncloudflared token works. Ready to upload.');
					console.log('  bun run admin:startup:upload -- --limit 5');
					return;
				}
			}
			await sleep(400);
		}
	}

	console.log('\ncloudflared did not produce a usable app token. Falling back to cookie paste.\n');
	await cmdSetToken(options);
}

async function cmdStatus(options: Options): Promise<void> {
	const token = await resolveAccessToken({
		explicit: options.cfAccessToken,
		tokenCachePath: options.tokenCachePath,
		skipAccess: options.skipAccess
	});

	console.log(`Server:            ${options.server}`);
	console.log(`Skip Access:       ${options.skipAccess}`);
	console.log(`Access token:      ${token ? `yes (${token.length} chars)` : 'no'}`);
	console.log(
		`  cache file:       ${existsSync(options.tokenCachePath) ? 'present' : 'missing'} (${options.tokenCachePath})`
	);
	console.log(`  cloudflared file: ${existsSync(cloudflaredTokenPath()) ? 'present' : 'missing'}`);
	console.log(`  lock file:        ${existsSync(cloudflaredLockPath()) ? 'present' : 'absent'}`);
	console.log(`Service token:     ${options.cfClientId && options.cfClientSecret ? 'yes' : 'no'}`);
	console.log(
		`Admin passkey:     ${options.passkey ? `yes (${options.passkey.length} chars)` : 'no'}`
	);

	if (token && !options.skipAccess) {
		const probe = await probeAccessToken(options.server, token);
		console.log(`Access probe:      ${probe === 'ok' ? 'ok (JWT accepted)' : probe}`);
	}

	if (!options.skipAccess && !token && !(options.cfClientId && options.cfClientSecret)) {
		console.log('\nNot ready for prod. Prefer Access service tokens (no cookie paste):');
		console.log('  1. Deploy infra (creates CLI service token + Service Auth policy)');
		console.log('  2. export CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET from Pulumi outputs');
		console.log('  3. bun run admin:startup:upload -- --limit 5');
	} else if (!options.passkey) {
		console.log('\nSet ADMIN_PASSKEY (or apps/api/.env).');
	} else {
		console.log('\nReady: bun run admin:startup:upload -- --limit 5');
	}
}

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * POST the puzzle form with bounded retry for transient failures (5xx responses
 * and network errors). 4xx responses are not retried — they are deterministic
 * validation/authorization failures.
 */
export async function uploadWithRetry(
	server: string,
	baseHeaders: Record<string, string>,
	cookie: string,
	formData: FormData
): Promise<Response> {
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(`${server}/api/admin/puzzles`, {
				method: 'POST',
				headers: { ...baseHeaders, Cookie: cookie },
				body: formData,
				redirect: 'manual'
			});
			if (response.ok || response.status < 500) return response;
			// 5xx — transient, retry
			lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
			if (attempt < MAX_RETRY_ATTEMPTS) {
				const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
				console.error(
					`  retry ${attempt}/${MAX_RETRY_ATTEMPTS} after ${backoff}ms (${lastError.message})`
				);
				await sleep(backoff);
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < MAX_RETRY_ATTEMPTS) {
				const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
				console.error(
					`  retry ${attempt}/${MAX_RETRY_ATTEMPTS} after ${backoff}ms (${lastError.message})`
				);
				await sleep(backoff);
			}
		}
	}
	throw lastError ?? new Error('Upload failed after retries');
}

async function cmdUpload(options: Options): Promise<void> {
	if (!options.dryRun && !options.passkey) {
		console.error('Missing admin passkey. Set ADMIN_PASSKEY or use --passkey.');
		process.exit(1);
	}

	if (!options.dryRun && !options.skipAccess) {
		options.cfAccessToken = await resolveAccessToken({
			explicit: options.cfAccessToken,
			tokenCachePath: options.tokenCachePath,
			skipAccess: false
		});
	}

	if (!options.dryRun && !hasAccessCredentials(options)) {
		console.error(`Cloudflare Access credentials missing.

For automation, Cloudflare recommends Access service tokens (not browser cookies):
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

After deploying the admin CLI service token (Pulumi exports):
  export CF_ACCESS_CLIENT_ID="$(cd packages/infrastructure && pulumi stack output adminCliAccessClientId)"
  export CF_ACCESS_CLIENT_SECRET="$(cd packages/infrastructure && pulumi stack output --show-secrets adminCliAccessClientSecret)"

Or add those two keys to apps/api/.env, then:
  bun run admin:startup:upload -- --limit 5
`);
		process.exit(1);
	}

	if (!options.dryRun && options.cfAccessToken && !options.skipAccess) {
		const probe = await probeAccessToken(options.server, options.cfAccessToken);
		if (probe === 'blocked') {
			console.error(
				'Access JWT is present but rejected by Cloudflare Access (302/403).\n' +
					'Run: bun run admin:startup:set-token'
			);
			process.exit(1);
		}
	}

	const catalog = (await Bun.file(options.catalogPath).json()) as CatalogEntry[];
	const selected = selectEntries(catalog, options);
	if (selected.length === 0) {
		console.error('No catalog entries match the selected range.');
		process.exit(1);
	}

	console.log(
		`${options.dryRun ? 'Dry-run' : 'Uploading'} ${selected.length} puzzle(s) to ${options.server}`
	);
	const toLabel = options.to === Number.MAX_SAFE_INTEGER ? 'end' : options.to;
	console.log(
		`Range: ids ${options.from}–${toLabel}${options.limit ? ` (limit ${options.limit})` : ''}`
	);

	if (options.dryRun) {
		for (const entry of selected) {
			const imagePath = imagePathFor(entry, options.imagesDir);
			console.log(
				`[dry-run] ${entry.id} ${entry.name} ${entry.pieceCount}pcs ${entry.aspectRatio} ${entry.category} -> ${imagePath ?? 'MISSING'}`
			);
		}
		return;
	}

	const baseHeaders = accessHeaders(options);
	const loginResponse = await fetch(`${options.server}/api/admin/login`, {
		method: 'POST',
		headers: { ...baseHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify({ passkey: options.passkey }),
		redirect: 'manual'
	});
	if (!loginResponse.ok) {
		throw new Error(`Admin login failed: ${await readError(loginResponse)}`);
	}
	const cookie = sessionCookieFrom(loginResponse, baseHeaders.Cookie);
	console.log('Admin session OK\n');

	// Idempotency: fetch existing puzzle names so reruns skip already-uploaded entries
	// instead of creating duplicates (the API generates a fresh UUID per upload).
	const existingNames = await fetchExistingNames(options.server, baseHeaders, cookie);
	if (existingNames.size > 0) {
		console.log(
			`Idempotency: ${existingNames.size} existing puzzle(s) on server — duplicates will be skipped.\n`
		);
	}

	const results: Array<{ id: string; name: string; ok: boolean; detail: string }> = [];
	let skipped = 0;

	for (const entry of selected) {
		if (existingNames.has(entry.name.trim())) {
			skipped++;
			results.push({
				id: entry.id,
				name: entry.name,
				ok: true,
				detail: 'already exists — skipped'
			});
			console.log(`SKIP ${entry.id} ${entry.name}: already exists on server`);
			continue;
		}

		const imagePath = imagePathFor(entry, options.imagesDir);
		if (!imagePath) {
			results.push({ id: entry.id, name: entry.name, ok: false, detail: 'image missing' });
			console.error(`FAIL ${entry.id} ${entry.name}: image missing`);
			continue;
		}

		const image = Bun.file(imagePath, { type: mimeForPath(imagePath) });
		const formData = new FormData();
		formData.append('name', entry.name);
		formData.append('pieceCount', String(entry.pieceCount));
		formData.append('aspectRatio', entry.aspectRatio);
		formData.append('category', entry.category);
		formData.append('image', image, basename(imagePath));

		try {
			const uploadResponse = await uploadWithRetry(options.server, baseHeaders, cookie, formData);
			if (!uploadResponse.ok) {
				const detail = await readError(uploadResponse);
				results.push({ id: entry.id, name: entry.name, ok: false, detail });
				console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
			} else {
				const puzzle = (await uploadResponse.json()) as { id?: string; status?: string };
				results.push({
					id: entry.id,
					name: entry.name,
					ok: true,
					detail: `${puzzle.id ?? '?'} ${puzzle.status ?? ''}`
				});
				console.log(`OK   ${entry.id} ${entry.name} -> ${puzzle.id} (${puzzle.status})`);
				existingNames.add(entry.name.trim());
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			results.push({ id: entry.id, name: entry.name, ok: false, detail });
			console.error(`FAIL ${entry.id} ${entry.name}: ${detail}`);
		}

		if (options.delayMs > 0) await sleep(options.delayMs);
	}

	const ok = results.filter((r) => r.ok && r.detail !== 'already exists — skipped').length;
	const fail = results.filter((r) => !r.ok).length;
	console.log(`\nDone: ${ok} uploaded, ${skipped} skipped, ${fail} failed`);
	if (fail > 0) process.exit(1);
}

async function main() {
	const options = await parseOptions();
	if (options.command === 'set-token') {
		await cmdSetToken(options);
		return;
	}
	if (options.command === 'login') {
		await cmdLogin(options);
		return;
	}
	if (options.command === 'status') {
		await cmdStatus(options);
		return;
	}
	await cmdUpload(options);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
