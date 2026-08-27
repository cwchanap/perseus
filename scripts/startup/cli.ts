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
	applyDotenvOverrides,
	isLocalServer,
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
	probeServiceToken,
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
  status      Check Access readiness
  upload      Upload catalog images

Options:
  --server <url>           API base (default: ${DEFAULT_SERVER})
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
  # Browser: open ${accessAppFor(DEFAULT_SERVER)} with WARP connected, complete Access
  # DevTools → Application → Cookies → CF_Authorization → copy value
  # (Must be the CLI Access app JWT — broad /admin audience is rejected on upload)
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
	// Apply dotenv overrides for deployment-specific constants before any code
	// reads DEFAULT_SERVER or ACCESS_AUD (e.g. cloudflaredTokenPath below).
	applyDotenvOverrides(dotenv);
	// Warn about hardcoded defaults using the resolved dotenv map so values
	// provided in apps/api/.env are recognized and don't trigger false warnings.
	warnHardcodedDefaults(dotenv);

	const server = (readArg(args, '--server') ?? dotenv.PERSEUS_SERVER ?? DEFAULT_SERVER).replace(
		/\/+$/,
		''
	);
	// Local servers always skip Access. --skip-access on a remote target is a
	// hard error (not a silent ignore) so a mis-set flag cannot look like it
	// bypassed production Access while still sending headers — or worse, skip
	// them when the operator thought the flag was local-only documentation.
	const wantSkipAccess = args.includes('--skip-access');
	if (wantSkipAccess && !isLocalServer(server)) {
		throw new FatalError(
			'--skip-access is only valid with a local --server (localhost/127.0.0.1). ' +
				'Remote targets always require Cloudflare Access credentials.'
		);
	}
	const skipAccess = wantSkipAccess || isLocalServer(server);
	const tokenCachePath = join(root, 'data/startup-puzzles/.cf-access-token');
	// Store only the raw explicit token here. Each command resolves the full
	// token (cache → cloudflared) itself via resolveAccessToken — resolving here
	// would spawn cloudflared (subprocess + network) even for --dry-run, and
	// cmdUpload/cmdStatus re-resolve anyway, so it was both redundant and a
	// dry-run latency hit. See token.ts resolveAccessToken.
	const cfAccessToken = readArg(args, '--cf-access-token') ?? process.env.CF_ACCESS_TOKEN;

	const cfClientId = process.env.CF_ACCESS_CLIENT_ID ?? dotenv.CF_ACCESS_CLIENT_ID;
	const cfClientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? dotenv.CF_ACCESS_CLIENT_SECRET;

	validateNoLeftoverArgs(args);

	return {
		command,
		server,
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

const VALUE_FLAGS = new Set([
	'--server',
	'--cf-access-token',
	'--catalog',
	'--images',
	'--from',
	'--to',
	'--limit',
	'--delay-ms'
]);
const BOOLEAN_FLAGS = new Set(['--skip-access', '--dry-run', '--help', '-h']);

function validateNoLeftoverArgs(args: string[]): void {
	const seenValueFlags = new Set<string>();
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (BOOLEAN_FLAGS.has(arg)) continue;
		if (VALUE_FLAGS.has(arg)) {
			if (seenValueFlags.has(arg)) {
				console.error(`Repeated option: ${arg}`);
				usage();
			}
			seenValueFlags.add(arg);
			i++;
			continue;
		}
		if (arg.startsWith('--')) {
			console.error(`Unknown option: ${arg}`);
			usage();
		}
		console.error(`Unexpected argument: ${arg}`);
		usage();
	}
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
	if (probe !== 'ok') {
		// Do not cache rejected/unhealthy tokens — the next run would re-read
		// a known-bad JWT and fail the same way (or worse, skip re-prompting).
		console.error(
			probe === 'blocked'
				? 'Access still blocks requests (401/302/403). Token was NOT cached.\n' +
						'Make sure you copied CF_Authorization after a successful Access login with WARP connected.'
				: `Access probe failed (${probe}). Token was NOT cached.`
		);
		throw new FatalError('Re-copy the cookie after a fresh browser login and run set-token again.');
	}
	cacheToken(options.tokenCachePath, token);
	console.log(`\nSaved Access token → ${options.tokenCachePath}`);
	console.log('Probe: Access accepts token ✓');
	console.log('\nNext: bun run admin:startup:upload -- --limit 5');
}

async function cmdLogin(options: Options): Promise<void> {
	clearStaleAccessLock(options.server);

	const existing = await resolveAccessToken({
		explicit: options.cfAccessToken,
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

export type ReadinessOutcome =
	| { ready: true }
	| { ready: false; reason: 'access-probe-failed' }
	| { ready: false; reason: 'backend-unhealthy' }
	| { ready: false; reason: 'access-missing' };

/**
 * Pure readiness decision for `bun run admin:startup:status`. Extracted from
 * cmdStatus so the gate logic — specifically "do not report Ready when Access
 * credentials are present but rejected/expired, or when the backend is
 * unhealthy" — is unit-testable without network or probe mocks.
 *
 * `probeResult` is the Access probe outcome, or undefined when no probe ran
 * (skipAccess, or no credentials to probe with). 'ok' means Access accepted
 * the credentials and the backend is healthy. 'unhealthy' means Access
 * accepted but the backend returned 5xx — uploads will fail, so the gate
 * rejects. Any other non-'ok' probe result is an Access failure.
 */
export function evaluateReadiness(args: {
	skipAccess: boolean;
	hasToken: boolean;
	hasServiceToken: boolean;
	probeResult: string | undefined;
}): ReadinessOutcome {
	if (args.probeResult === 'unhealthy') {
		return { ready: false, reason: 'backend-unhealthy' };
	}
	if (args.probeResult !== undefined && args.probeResult !== 'ok') {
		return { ready: false, reason: 'access-probe-failed' };
	}
	const hasAnyAccess = args.skipAccess || args.hasToken || args.hasServiceToken;
	if (!hasAnyAccess) {
		return { ready: false, reason: 'access-missing' };
	}
	return { ready: true };
}

async function cmdStatus(options: Options): Promise<void> {
	// Skip JWT token resolution when service tokens are already available —
	// service tokens authenticate Access without needing a JWT, and
	// resolveAccessToken would fall through to spawning `cloudflared access
	// token` (unbounded subprocess) if no JWT is cached. On a headless machine
	// with cloudflared installed, that subprocess can delay or hang the
	// readiness check even though service-token probing is sufficient.
	// Mirrors the same skip in cmdUpload's resolveAndProbeAccess.
	const hasServiceToken = !!(options.cfClientId && options.cfClientSecret);
	const token = hasServiceToken
		? options.cfAccessToken
		: await resolveAccessToken({
				explicit: options.cfAccessToken,
				tokenCachePath: options.tokenCachePath,
				skipAccess: options.skipAccess,
				server: options.server
			});

	console.log(`Server:            ${options.server}`);
	console.log(`Skip Access:       ${options.skipAccess}`);
	console.log(`Access token:      ${token ? `yes (${token.length} chars)` : 'no'}`);
	const cacheStatus = existsSync(options.tokenCachePath) ? 'present' : 'missing';
	console.log(`  cache file:       ${cacheStatus} (${options.tokenCachePath})`);
	const cfTokenPath = cloudflaredTokenPath(options.server);
	const cfLockPath = cloudflaredLockPath(options.server);
	const cfTokenStatus = cfTokenPath
		? existsSync(cfTokenPath)
			? 'present'
			: 'missing'
		: 'n/a (CF_ACCESS_AUD not set)';
	console.log(`  cloudflared file: ${cfTokenStatus}`);
	const cfLockStatus = cfLockPath
		? existsSync(cfLockPath)
			? 'present'
			: 'absent'
		: 'n/a (CF_ACCESS_AUD not set)';
	console.log(`  lock file:        ${cfLockStatus}`);
	console.log(`Service token:     ${options.cfClientId && options.cfClientSecret ? 'yes' : 'no'}`);

	// Track probe outcome so the readiness check below does not print "Ready"
	// when Access credentials are present but rejected/expired. Without this,
	// an expired service token or JWT would show "blocked"/"error" on the probe
	// line but still report Ready (and exit 0), misleading callers into
	// attempting an upload that will fail. The decision itself lives in the
	// pure evaluateReadiness() helper (unit-tested in cli.test.ts).
	let probeResult: string | undefined;

	// Prefer service token probe when service tokens are available (same
	// logic as the upload path). Only probe JWT when service tokens are absent.
	if (hasServiceToken && !options.skipAccess) {
		probeResult = await probeServiceToken(
			options.server,
			options.cfClientId!,
			options.cfClientSecret!
		);
		console.log(
			`Access probe:      ${probeResult === 'ok' ? 'ok (service token accepted)' : probeResult}`
		);
	} else if (token && !options.skipAccess) {
		probeResult = await probeAccessToken(options.server, token);
		console.log(`Access probe:      ${probeResult === 'ok' ? 'ok (JWT accepted)' : probeResult}`);
	}

	const outcome = evaluateReadiness({
		skipAccess: options.skipAccess,
		hasToken: !!token,
		hasServiceToken,
		probeResult
	});

	if (outcome.ready) {
		console.log('\nReady: bun run admin:startup:upload -- --limit 5');
		return;
	}
	if (outcome.reason === 'access-probe-failed') {
		throw new FatalError(
			'Access probe failed — credentials are rejected or unreachable. ' +
				'Fix the issue above before uploading.'
		);
	}
	if (outcome.reason === 'backend-unhealthy') {
		throw new FatalError(
			'Backend is unhealthy (5xx) — Access accepted the credentials, ' +
				'but the API is not responding. Investigate the backend before uploading.'
		);
	}
	if (outcome.reason === 'access-missing') {
		console.log('\nNot ready for prod. Prefer Access service tokens (no cookie paste):');
		console.log('  1. Deploy infra (creates CLI service token + Service Auth policy)');
		console.log('  2. export CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET from Pulumi outputs');
		console.log('  3. bun run admin:startup:upload -- --limit 5');
		throw new FatalError('Access credentials missing — not ready for upload.');
	}
}

export async function main(): Promise<void> {
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
