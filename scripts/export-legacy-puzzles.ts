#!/usr/bin/env bun

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PuzzleAspectRatio, PuzzleCategory, PuzzleListResponse } from '@perseus/types';
import { accessHeaders, hasAccessCredentials } from './startup/upload';
import { resolveAccessToken, probeAccessToken, probeServiceToken } from './startup/token';
import {
	applyDotenvOverrides,
	FatalError,
	FETCH_TIMEOUT_MS,
	isLocalServer,
	type AccessCredentials
} from './startup/types';

export const MIGRATION_DIR = '.migration/puzzle-families';
export const MANIFEST_FILE = 'manifest.json';
export const WRANGLER_CONFIG = 'apps/api/wrangler.production.toml';
export const D1_DATABASE = 'perseus-player-data';
export const R2_BUCKET = 'perseus';
export const KV_BINDING = 'PUZZLE_METADATA';

export type WranglerResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type RunWrangler = (args: string[]) => Promise<WranglerResult>;

export type LegacyExportEntry = {
	legacyId: string;
	name: string;
	category: PuzzleCategory;
	aspectRatio: PuzzleAspectRatio;
	ownerId: string;
	originalFile: string;
	contentType: string;
	byteLength: number;
};

export type LegacyExportManifest = {
	exportedAt: string;
	server: string;
	puzzles: LegacyExportEntry[];
};

export type ExportOptions = AccessCredentials & {
	server: string;
	outputDir: string;
	fetchFn?: typeof fetch;
	runWrangler?: RunWrangler;
};

type ReadyPuzzle = PuzzleListResponse['puzzles'][number];

export async function defaultRunWrangler(args: string[]): Promise<WranglerResult> {
	const proc = Bun.spawn(['bunx', 'wrangler', ...args], {
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	return { stdout, stderr, exitCode };
}

function extensionForContentType(contentType: string): string {
	if (contentType === 'image/jpeg') return 'jpg';
	if (contentType === 'image/png') return 'png';
	if (contentType === 'image/webp') return 'webp';
	return 'bin';
}

function sqlQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchAllReadyPuzzles(
	server: string,
	headers: Record<string, string>,
	fetchFn: typeof fetch,
	pageSize = 100
): Promise<ReadyPuzzle[]> {
	const puzzles: ReadyPuzzle[] = [];
	let offset = 0;
	let total = Number.POSITIVE_INFINITY;

	while (offset < total) {
		const url = new URL(`${server.replace(/\/+$/, '')}/api/puzzles`);
		url.searchParams.set('offset', String(offset));
		url.searchParams.set('limit', String(pageSize));

		const response = await fetchFn(url.toString(), {
			method: 'GET',
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!response.ok) {
			throw new FatalError(
				`Failed to list legacy puzzles (${response.status} ${response.statusText})`
			);
		}

		const payload = (await response.json()) as PuzzleListResponse;
		total = payload.total;
		for (const puzzle of payload.puzzles) {
			if (puzzle.status === 'ready') puzzles.push(puzzle);
		}
		if (payload.puzzles.length === 0) break;
		offset += payload.puzzles.length;
	}

	return puzzles;
}

function parseD1Results(stdout: string): Array<Record<string, unknown>> {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (Array.isArray(parsed)) {
			const rows: Array<Record<string, unknown>> = [];
			for (const batch of parsed) {
				if (
					batch &&
					typeof batch === 'object' &&
					Array.isArray((batch as { results?: unknown }).results)
				) {
					for (const row of (batch as { results: Array<Record<string, unknown>> }).results) {
						rows.push(row);
					}
				}
			}
			return rows;
		}
	} catch {
		// Fall through to empty result.
	}
	return [];
}

export async function fetchOwnerIds(
	puzzleIds: string[],
	runWrangler: RunWrangler
): Promise<Map<string, string>> {
	const owners = new Map<string, string>();
	if (puzzleIds.length === 0) return owners;

	const inList = puzzleIds.map((id) => sqlQuote(id)).join(', ');
	const command = `SELECT id, owner_id FROM puzzles WHERE id IN (${inList})`;
	const result = await runWrangler([
		'd1',
		'execute',
		D1_DATABASE,
		'--remote',
		'--config',
		WRANGLER_CONFIG,
		'--json',
		'--command',
		command
	]);
	if (result.exitCode !== 0) {
		throw new FatalError(`Failed to fetch owner IDs from D1:\n${result.stderr || result.stdout}`);
	}

	for (const row of parseD1Results(result.stdout)) {
		const id = row.id;
		const ownerId = row.owner_id;
		if (typeof id === 'string' && typeof ownerId === 'string') {
			owners.set(id, ownerId);
		}
	}
	return owners;
}

async function downloadOriginal(
	server: string,
	puzzleId: string,
	headers: Record<string, string>,
	fetchFn: typeof fetch
): Promise<{ bytes: Uint8Array; contentType: string }> {
	const response = await fetchFn(
		`${server.replace(/\/+$/, '')}/api/puzzles/${encodeURIComponent(puzzleId)}/reference`,
		{
			method: 'GET',
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		}
	);
	if (!response.ok) {
		throw new FatalError(
			`Cannot export ready puzzle ${puzzleId}: reference download failed (${response.status})`
		);
	}
	const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0) {
		throw new FatalError(`Cannot export ready puzzle ${puzzleId}: reference body is empty`);
	}
	return { bytes, contentType };
}

async function resolveAccess(options: ExportOptions): Promise<Record<string, string>> {
	if (options.skipAccess || isLocalServer(options.server)) return accessHeaders(options);
	if (!hasAccessCredentials(options)) {
		throw new FatalError('Cloudflare Access credentials are required for production export.');
	}
	if (options.cfAccessToken) {
		const outcome = await probeAccessToken(options.server, options.cfAccessToken);
		if (outcome !== 'ok') {
			throw new FatalError('Cloudflare Access JWT probe failed for export.');
		}
	}
	if (options.cfClientId && options.cfClientSecret) {
		const outcome = await probeServiceToken(
			options.server,
			options.cfClientId,
			options.cfClientSecret
		);
		if (outcome !== 'ok') {
			throw new FatalError('Cloudflare Access service token probe failed for export.');
		}
	}
	return accessHeaders(options);
}

export async function exportLegacyPuzzles(options: ExportOptions): Promise<LegacyExportManifest> {
	const fetchFn = options.fetchFn ?? fetch;
	const runWrangler = options.runWrangler ?? defaultRunWrangler;
	const headers = await resolveAccess(options);
	const readyPuzzles = await fetchAllReadyPuzzles(options.server, headers, fetchFn);
	const owners = await fetchOwnerIds(
		readyPuzzles.map((puzzle) => puzzle.id),
		runWrangler
	);

	mkdirSync(join(options.outputDir, 'originals'), { recursive: true });
	const manifest: LegacyExportManifest = {
		exportedAt: new Date().toISOString(),
		server: options.server,
		puzzles: []
	};

	for (const puzzle of readyPuzzles) {
		const ownerId = owners.get(puzzle.id);
		if (!ownerId) {
			throw new FatalError(`Cannot export ready puzzle ${puzzle.id}: missing owner_id in D1`);
		}
		if (!puzzle.category || !puzzle.aspectRatio) {
			throw new FatalError(`Cannot export ready puzzle ${puzzle.id}: missing category/aspectRatio`);
		}

		const { bytes, contentType } = await downloadOriginal(
			options.server,
			puzzle.id,
			headers,
			fetchFn
		);
		const ext = extensionForContentType(contentType);
		const originalFile = join('originals', `${puzzle.id}.${ext}`);
		writeFileSync(join(options.outputDir, originalFile), bytes);

		manifest.puzzles.push({
			legacyId: puzzle.id,
			name: puzzle.name,
			category: puzzle.category,
			aspectRatio: puzzle.aspectRatio,
			ownerId,
			originalFile,
			contentType,
			byteLength: bytes.byteLength
		});
	}

	writeFileSync(join(options.outputDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
	return manifest;
}

function readArg(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) return undefined;
	return value;
}

async function parseCliOptions(): Promise<ExportOptions> {
	const args = Bun.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`Usage:
  bun scripts/export-legacy-puzzles.ts [--server <url>] [--output <dir>]

Exports ready legacy puzzles from production into ${MIGRATION_DIR}/.
`);
		process.exit(0);
	}

	const root = join(import.meta.dir, '..');
	const dotenv = await (async () => {
		const { loadDotEnvMap } = await import('./startup/token');
		return loadDotEnvMap(root);
	})();
	applyDotenvOverrides(dotenv);

	const server = (
		readArg(args, '--server') ??
		dotenv.PERSEUS_SERVER ??
		'https://perseus.cwchanap.dev'
	).replace(/\/+$/, '');
	const outputDir = readArg(args, '--output') ?? join(root, MIGRATION_DIR);
	const skipAccess = args.includes('--skip-access') || isLocalServer(server);

	let cfAccessToken = readArg(args, '--cf-access-token') ?? process.env.CF_ACCESS_TOKEN;
	const cfClientId = readArg(args, '--cf-client-id') ?? dotenv.CF_ACCESS_CLIENT_ID;
	const cfClientSecret = readArg(args, '--cf-client-secret') ?? dotenv.CF_ACCESS_CLIENT_SECRET;

	if (!skipAccess && !cfAccessToken && !(cfClientId && cfClientSecret)) {
		cfAccessToken = await resolveAccessToken({
			explicit: undefined,
			tokenCachePath: join(root, 'apps/api/.env'),
			skipAccess: false,
			server
		});
	}

	return {
		server,
		outputDir,
		skipAccess,
		cfAccessToken,
		cfClientId,
		cfClientSecret
	};
}

if (import.meta.main) {
	parseCliOptions()
		.then(async (options) => {
			const manifest = await exportLegacyPuzzles(options);
			console.log(`Exported ${manifest.puzzles.length} ready puzzle(s) to ${options.outputDir}`);
		})
		.catch((error) => {
			if (error instanceof FatalError) {
				console.error(error.message);
				process.exit(error.exitCode);
			}
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		});
}
