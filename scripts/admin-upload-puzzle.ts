#!/usr/bin/env bun

import { basename, extname } from 'node:path';

interface Options {
	server: string;
	passkey: string;
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
  --server <url>       API server base URL (default: http://127.0.0.1:3000)
  --passkey <value>    Admin passkey (or set ADMIN_PASSKEY)
  --image <path>       Image file to upload
  --name <value>       Puzzle name
  --pieces <count>     Piece count
  --aspect <ratio>     Optional aspect ratio: 1:1, 4:3, or 3:4
  --category <name>    Optional category
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

function parseOptions(): Options {
	const args = Bun.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) usage(0);

	const imagePath = readArg(args, '--image');
	const name = readArg(args, '--name');
	const pieceCountRaw = readArg(args, '--pieces');
	const passkey = readArg(args, '--passkey') ?? process.env.ADMIN_PASSKEY;
	const server = readArg(args, '--server') ?? 'http://127.0.0.1:3000';
	const aspectRatio = readArg(args, '--aspect');
	const category = readArg(args, '--category');

	if (!imagePath || !name || !pieceCountRaw || !passkey) usage();

	const pieceCount = Number.parseInt(pieceCountRaw, 10);
	if (!Number.isInteger(pieceCount) || String(pieceCount) !== pieceCountRaw) {
		console.error('--pieces must be a base-10 integer');
		process.exit(1);
	}

	return {
		server: server.replace(/\/+$/, ''),
		passkey,
		imagePath,
		name,
		pieceCount,
		aspectRatio,
		category
	};
}

function sessionCookieFrom(response: Response): string {
	const setCookie = response.headers.get('set-cookie');
	if (!setCookie) {
		throw new Error('Admin login did not return a session cookie');
	}
	return setCookie.split(';', 1)[0];
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

async function main() {
	const options = parseOptions();
	const image = Bun.file(options.imagePath, { type: contentTypeForPath(options.imagePath) });
	if (!(await image.exists())) {
		throw new Error(`Image file not found: ${options.imagePath}`);
	}

	const loginResponse = await fetch(`${options.server}/api/admin/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ passkey: options.passkey })
	});
	if (!loginResponse.ok) {
		throw new Error(`Admin login failed: ${await readError(loginResponse)}`);
	}
	const cookie = sessionCookieFrom(loginResponse);

	const formData = new FormData();
	formData.append('name', options.name);
	formData.append('pieceCount', String(options.pieceCount));
	if (options.aspectRatio) formData.append('aspectRatio', options.aspectRatio);
	if (options.category) formData.append('category', options.category);
	formData.append('image', image, basename(options.imagePath));

	const uploadResponse = await fetch(`${options.server}/api/admin/puzzles`, {
		method: 'POST',
		headers: { Cookie: cookie },
		body: formData
	});
	if (!uploadResponse.ok) {
		throw new Error(`Puzzle upload failed: ${await readError(uploadResponse)}`);
	}

	const puzzle = (await uploadResponse.json()) as { id?: string; name?: string; status?: string };
	console.log(JSON.stringify(puzzle, null, 2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
