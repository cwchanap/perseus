/**
 * CLI commands (set-token, login, status), argument parsing, and main entry.
 *
 * The command functions use FatalError instead of process.exit() so tests can
 * assert on failures. main() catches FatalError and translates it to
 * process.exit with the appropriate exit code.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
	DEFAULT_SERVER,
	type Options,
	accessAppFor,
	adminUiFor,
	sleep,
	warnHardcodedDefaults,
	FatalError
} from './types';
import {
	cacheToken,
	clearStaleAccessLock,
	cloudflaredLockPath,
	cloudflaredTokenPath,
	loadDotEnvMap,
	probeAccessToken,
	promptTokenInteractive,
	resolveAccessToken,
	resolveCloudflaredToken
} from './token';
import { cmdUpload } from './upload';

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
  --catalog <path>         Catalog JSON (default: scripts/startup-seed/catalog.json)
  --images <dir>           Image directory (default: scripts/startup-seed/images)
  --from <n>               Start catalog id (default: 1, 0 = from the very beginning)
  --to <n>                 End catalog id (default: all, 0 = no upper bound)
  --limit <n>              Upload at most N entries from --from
  --delay-ms <n>           Delay between uploads (default: 1500)
  --skip-access            Local API only (no Access headers)
  --dry-run                Plan only
  -h, --help

Recommended flow:
  # Browser: open ${adminUiFor(DEFAULT_SERVER)} with WARP connected, complete Access
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
	// Allow zero-padded digits (e.g. "01") since catalog ids are zero-padded.
	// Reject non-numeric strings or floats (e.g. "1.5", "abc").
	if (!/^\d+$/.test(raw)) {
		console.error(`${label} must be a base-10 integer`);
		process.exit(1);
	}
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n)) {
		console.error(`${label} must be a base-10 integer`);
		process.exit(1);
	}
	if (n < 0) {
		console.error(`${label} must not be negative`);
		process.exit(1);
	}
	return n;
}

async function parseOptions(): Promise<Options> {
	const args = Bun.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) usage(0);

	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const commandRaw = args[0];
	const allowed = new Set(['login', 'set-token', 'upload', 'status']);
	if (!commandRaw || commandRaw.startsWith('--') || !allowed.has(commandRaw)) {
		usage();
	}
	const command = commandRaw as Options['command'];

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
	// Store only the raw explicit token here. Each command resolves the full
	// token (cache → cloudflared) itself via resolveAccessToken — resolving here
	// would spawn cloudflared (subprocess + network) even for --dry-run, and
	// cmdUpload/cmdStatus re-resolve anyway, so it was both redundant and a
	// dry-run latency hit. See token.ts resolveAccessToken.
	const cfAccessToken = readArg(args, '--cf-access-token') ?? process.env.CF_ACCESS_TOKEN;

	const cfClientId = process.env.CF_ACCESS_CLIENT_ID ?? dotenv.CF_ACCESS_CLIENT_ID;
	const cfClientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? dotenv.CF_ACCESS_CLIENT_SECRET;

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

function runCloudflaredLogin(server: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn('cloudflared', ['access', 'login', accessAppFor(server)], {
			stdio: 'inherit'
		});
		child.on('error', () => resolve(127));
		child.on('exit', (code) => resolve(code ?? 1));
	});
}

async function cmdSetToken(options: Options): Promise<void> {
	const token = await promptTokenInteractive(options.server);
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
		throw new FatalError('Re-copy the cookie after a fresh browser login and run set-token again.');
	}
}

async function cmdLogin(options: Options): Promise<void> {
	clearStaleAccessLock(options.server);

	const existing = await resolveAccessToken({
		tokenCachePath: options.tokenCachePath,
		skipAccess: false,
		server: options.server
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
	const code = await runCloudflaredLogin(options.server);
	if (code === 0) {
		for (let i = 0; i < 10; i += 1) {
			const token = await resolveCloudflaredToken(options.server);
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
		skipAccess: options.skipAccess,
		server: options.server
	});

	console.log(`Server:            ${options.server}`);
	console.log(`Skip Access:       ${options.skipAccess}`);
	console.log(`Access token:      ${token ? `yes (${token.length} chars)` : 'no'}`);
	console.log(
		`  cache file:       ${existsSync(options.tokenCachePath) ? 'present' : 'missing'} (${options.tokenCachePath})`
	);
	console.log(
		`  cloudflared file: ${existsSync(cloudflaredTokenPath(options.server)) ? 'present' : 'missing'}`
	);
	console.log(
		`  lock file:        ${existsSync(cloudflaredLockPath(options.server)) ? 'present' : 'absent'}`
	);
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

export async function main(): Promise<void> {
	warnHardcodedDefaults();
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
