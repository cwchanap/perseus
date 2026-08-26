#!/usr/bin/env bun

import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessHeaders, hasAccessCredentials, throwOnProbeFailure } from './startup/upload';
import {
	resolveAccessToken,
	probeAccessToken,
	probeServiceToken,
	loadDotEnvMap
} from './startup/token';
import {
	FatalError,
	applyDotenvOverrides,
	isLocalServer,
	type AccessCredentials
} from './startup/types';

// This CLI targets local dev by default (ad-hoc single uploads). The bulk
// uploader (admin:startup:*) defaults to production via DEFAULT_SERVER, but
// here a localhost default matches the usage text and the runbook (§11 Local API).
// PERSEUS_SERVER (arg or dotenv) still overrides.
const LOCAL_SERVER = 'http://127.0.0.1:4690';

interface Options extends AccessCredentials {
	server: string;
	imagePath: string;
	name: string;
	pieceCount: number;
	aspectRatio?: string;
	category?: string;
}

function usage(exitCode = 1): never {
	console.error(`Usage:
  bun run admin:upload -- --image ./puzzle.jpg --name "Puzzle Name" --pieces 48 --aspect 3:4

Options:
  --server <url>              API server base URL (default: http://127.0.0.1:4690)
  --image <path>              Image file to upload
  --name <value>              Puzzle name
  --pieces <count>            Piece count
  --aspect <ratio>            Optional aspect ratio: 1:1, 4:3, or 3:4
  --category <name>           Optional category
  --cf-access-token <jwt>     Access JWT (or set CF_ACCESS_TOKEN)
  --skip-access               Local API only (no Access headers)

Production Access (automated):
  Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET env vars (from Pulumi
  stack outputs) — same as the bulk uploader. See the perseus-operations skill §11.
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

function contentTypeForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	if (ext === '.png') return 'image/png';
	if (ext === '.webp') return 'image/webp';
	return 'application/octet-stream';
}

async function parseOptions(): Promise<Options> {
	const args = Bun.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) usage(0);

	const imagePath = readArg(args, '--image');
	const name = readArg(args, '--name');
	const pieceCountRaw = readArg(args, '--pieces');

	// Load the same dotenv map (apps/api/.env) used by the bulk uploader so
	// credentials kept there are available without exporting them to the shell.
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const dotenv = await loadDotEnvMap(root);
	applyDotenvOverrides(dotenv);

	const server = (readArg(args, '--server') ?? dotenv.PERSEUS_SERVER ?? LOCAL_SERVER).replace(
		/\/+$/,
		''
	);
	const aspectRatio = readArg(args, '--aspect');
	const category = readArg(args, '--category');
	const cfAccessToken = readArg(args, '--cf-access-token') ?? process.env.CF_ACCESS_TOKEN;
	const cfClientId = process.env.CF_ACCESS_CLIENT_ID ?? dotenv.CF_ACCESS_CLIENT_ID;
	const cfClientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? dotenv.CF_ACCESS_CLIENT_SECRET;
	const wantSkipAccess = args.includes('--skip-access');
	if (wantSkipAccess && !isLocalServer(server)) {
		console.error(
			'--skip-access is only valid with a local --server (localhost/127.0.0.1). ' +
				'Remote targets always require Cloudflare Access credentials.'
		);
		process.exit(1);
	}
	const skipAccess = wantSkipAccess || isLocalServer(server);

	if (!imagePath || !name || !pieceCountRaw) usage();

	const pieceCount = Number.parseInt(pieceCountRaw, 10);
	if (!Number.isInteger(pieceCount) || String(pieceCount) !== pieceCountRaw) {
		console.error('--pieces must be a base-10 integer');
		process.exit(1);
	}

	return {
		server,
		imagePath,
		name,
		pieceCount,
		aspectRatio,
		category,
		cfAccessToken,
		cfClientId,
		cfClientSecret,
		skipAccess
	};
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
	return `${response.status} ${response.statusText}`;
}

async function resolveAndProbeAccess(options: Options): Promise<void> {
	if (options.skipAccess) return;

	const hasServiceToken = !!(options.cfClientId && options.cfClientSecret);

	// Skip JWT resolution when service tokens are available (same logic as
	// the bulk uploader — service tokens are the recommended automation path).
	if (!hasServiceToken) {
		options.cfAccessToken = await resolveAccessToken({
			explicit: options.cfAccessToken,
			tokenCachePath: '',
			skipAccess: false,
			server: options.server
		});
	}

	if (!hasAccessCredentials(options)) {
		throw new FatalError(`Cloudflare Access credentials missing.

For production, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (from Pulumi
stack outputs), or use --cf-access-token with a CF_Authorization JWT.

For local API, use --skip-access or a localhost --server URL.`);
	}

	if (options.cfAccessToken && !hasServiceToken) {
		await throwOnProbeFailure(probeAccessToken(options.server, options.cfAccessToken), {
			blocked:
				'Access JWT is present but rejected by Cloudflare Access (302/403).\n' +
				'Run: bun run admin:startup:set-token',
			unhealthy:
				'Access accepted the JWT, but the backend returned 5xx.\n' +
				'The API is unhealthy — uploads will fail. Investigate the backend before retrying.',
			error:
				'Access JWT probe failed (network error or unexpected response).\n' +
				'Cannot verify Access credentials — aborting.'
		});
	}

	if (hasServiceToken) {
		await throwOnProbeFailure(
			probeServiceToken(options.server, options.cfClientId!, options.cfClientSecret!),
			{
				blocked:
					'Cloudflare Access service token rejected (302/403).\n' +
					'Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are valid and not expired.',
				unhealthy:
					'Access accepted the service token, but the backend returned 5xx.\n' +
					'The API is unhealthy — uploads will fail. Investigate the backend before retrying.',
				error:
					'Access service token probe failed (network error or unexpected response).\n' +
					'Cannot verify Access credentials — aborting.'
			}
		);
	}
}

async function main() {
	const options = await parseOptions();
	const image = Bun.file(options.imagePath, { type: contentTypeForPath(options.imagePath) });
	if (!(await image.exists())) {
		throw new Error(`Image file not found: ${options.imagePath}`);
	}

	await resolveAndProbeAccess(options);

	const baseHeaders = accessHeaders(options);

	const formData = new FormData();
	formData.append('name', options.name);
	formData.append('pieceCount', String(options.pieceCount));
	if (options.aspectRatio) formData.append('aspectRatio', options.aspectRatio);
	if (options.category) formData.append('category', options.category);
	formData.append('image', image, basename(options.imagePath));

	const uploadResponse = await fetch(`${options.server}/api/admin/puzzles`, {
		method: 'POST',
		headers: baseHeaders,
		body: formData,
		redirect: 'manual'
	});
	if (!uploadResponse.ok) {
		throw new Error(`Puzzle upload failed: ${await readError(uploadResponse)}`);
	}

	const puzzle = (await uploadResponse.json()) as { id?: string; name?: string; status?: string };
	console.log(JSON.stringify(puzzle, null, 2));
}

main().catch((error) => {
	if (error instanceof FatalError) {
		console.error(error.message);
		process.exit(error.exitCode);
	}
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
