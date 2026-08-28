#!/usr/bin/env bun

import { basename, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { PuzzleFamilyListResponse } from '@perseus/types';
import {
	accessHeaders,
	hasAccessCredentials,
	idempotencyKey,
	readError,
	uploadWithRetry
} from './startup/upload';
import { resolveAccessToken, probeAccessToken, probeServiceToken } from './startup/token';
import {
	applyDotenvOverrides,
	FatalError,
	FETCH_TIMEOUT_MS,
	isLocalServer,
	sleep,
	type AccessCredentials
} from './startup/types';
import {
	defaultRunWrangler,
	MANIFEST_FILE,
	MIGRATION_DIR,
	WRANGLER_CONFIG,
	D1_DATABASE,
	parseD1Changes,
	type LegacyExportManifest,
	type RunWrangler
} from './export-legacy-puzzles';

export const IMPORT_RESULTS_FILE = 'import-results.json';

export type ImportedFamily = {
	legacyId: string;
	familyId: string;
	name: string;
	ownerId: string;
	status: 'processing' | 'ready' | 'failed';
};

export type ImportResults = {
	importedAt: string;
	server: string;
	families: ImportedFamily[];
};

export type ImportOptions = AccessCredentials & {
	server: string;
	migrationDir: string;
	fetchFn?: typeof fetch;
	runWrangler?: RunWrangler;
	sleepFn?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
	maxPollAttempts?: number;
};

function sqlQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function readManifest(migrationDir: string): LegacyExportManifest {
	const raw = readFileSync(join(migrationDir, MANIFEST_FILE), 'utf8');
	return JSON.parse(raw) as LegacyExportManifest;
}

async function resolveAccess(options: ImportOptions): Promise<Record<string, string>> {
	if (options.skipAccess || isLocalServer(options.server)) return accessHeaders(options);
	if (!hasAccessCredentials(options)) {
		throw new FatalError('Cloudflare Access credentials are required for production import.');
	}
	if (options.cfAccessToken) {
		const outcome = await probeAccessToken(options.server, options.cfAccessToken);
		if (outcome !== 'ok') {
			throw new FatalError('Cloudflare Access JWT probe failed for import.');
		}
	}
	if (options.cfClientId && options.cfClientSecret) {
		const outcome = await probeServiceToken(
			options.server,
			options.cfClientId,
			options.cfClientSecret
		);
		if (outcome !== 'ok') {
			throw new FatalError('Cloudflare Access service token probe failed for import.');
		}
	}
	return accessHeaders(options);
}

async function updateFamilyOwner(
	familyId: string,
	ownerId: string,
	runWrangler: RunWrangler
): Promise<void> {
	const command =
		`UPDATE puzzle_families SET owner_id = ${sqlQuote(ownerId)} ` +
		`WHERE id = ${sqlQuote(familyId)}`;
	const result = await runWrangler([
		'd1',
		'execute',
		D1_DATABASE,
		'--remote',
		'--yes',
		'--config',
		WRANGLER_CONFIG,
		'--json',
		'--command',
		command
	]);
	if (result.exitCode !== 0) {
		throw new FatalError(
			`Failed to update owner_id for family ${familyId}:\n${result.stderr || result.stdout}`
		);
	}
	const changes = parseD1Changes(result.stdout);
	if (changes === 0) {
		throw new FatalError(
			`Owner update for family ${familyId} changed zero rows — verify family id and D1 state`
		);
	}
}

async function fetchAdminFamilies(
	server: string,
	headers: Record<string, string>,
	fetchFn: typeof fetch
): Promise<PuzzleFamilyListResponse['families']> {
	const response = await fetchFn(`${server.replace(/\/+$/, '')}/api/admin/puzzle-families`, {
		method: 'GET',
		headers,
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!response.ok) {
		throw new FatalError(
			`Failed to list puzzle families (${response.status} ${response.statusText})`
		);
	}
	const payload = (await response.json()) as PuzzleFamilyListResponse;
	return payload.families ?? [];
}

export async function pollImportedFamilies(
	server: string,
	families: ImportedFamily[],
	headers: Record<string, string>,
	fetchFn: typeof fetch,
	sleepFn: (ms: number) => Promise<void>,
	maxAttempts: number,
	pollIntervalMs: number
): Promise<ImportedFamily[]> {
	const pending = new Map(families.map((family) => [family.familyId, family]));
	const results = [...families];

	for (let attempt = 0; attempt < maxAttempts && pending.size > 0; attempt++) {
		const remoteFamilies = await fetchAdminFamilies(server, headers, fetchFn);
		for (const remote of remoteFamilies) {
			const tracked = pending.get(remote.id);
			if (!tracked) continue;
			if (remote.status === 'ready' || remote.status === 'failed') {
				tracked.status = remote.status;
				pending.delete(remote.id);
			}
		}
		if (pending.size > 0) await sleepFn(pollIntervalMs);
	}

	for (const family of results) {
		if (family.status === 'processing') {
			throw new FatalError(
				`Imported family ${family.familyId} (${family.name}) did not reach ready/failed in time`
			);
		}
	}
	return results;
}

export async function importPuzzleFamilies(options: ImportOptions): Promise<ImportedFamily[]> {
	const fetchFn = options.fetchFn ?? fetch;
	const runWrangler = options.runWrangler ?? defaultRunWrangler;
	const sleepFn = options.sleepFn ?? sleep;
	const pollIntervalMs = options.pollIntervalMs ?? 5_000;
	const maxPollAttempts = options.maxPollAttempts ?? 120;
	const manifest = readManifest(options.migrationDir);
	const headers = await resolveAccess(options);
	const imported: ImportedFamily[] = [];

	for (const entry of manifest.puzzles) {
		const imagePath = join(options.migrationDir, entry.originalFile);
		const image = Bun.file(imagePath);
		if (!(await image.exists())) {
			throw new FatalError(`Missing original file for ${entry.legacyId}: ${entry.originalFile}`);
		}

		const formData = new FormData();
		formData.append('name', entry.name);
		formData.append('aspectRatio', entry.aspectRatio);
		if (entry.category) formData.append('category', entry.category);
		formData.append(
			'image',
			new File([image], basename(entry.originalFile), { type: entry.contentType })
		);

		const dedupKey = idempotencyKey(entry.name, entry.aspectRatio);
		const response = await uploadWithRetry(options.server, headers, formData, entry.name, dedupKey);
		if (!response.ok) {
			const detail = await readError(response, !!(options.cfClientId && options.cfClientSecret));
			throw new FatalError(`Failed to import ${entry.name}: ${detail}`);
		}

		const created = (await response.json()) as { id?: string; status?: string };
		if (!created.id) {
			throw new FatalError(`Import response for ${entry.name} did not include family id`);
		}

		await updateFamilyOwner(created.id, entry.ownerId, runWrangler);
		imported.push({
			legacyId: entry.legacyId,
			familyId: created.id,
			name: entry.name,
			ownerId: entry.ownerId,
			status:
				created.status === 'ready' || created.status === 'failed' ? created.status : 'processing'
		});
	}

	// Persist a durable artifact BEFORE polling: if pollImportedFamilies throws
	// (or the operator kills the script while families are still processing),
	// cleanup-legacy-puzzles still finds an import-results.json listing every
	// family created this run instead of aborting on a missing file. The
	// successful-poll write below overwrites it with final statuses.
	const initialResults: ImportResults = {
		importedAt: new Date().toISOString(),
		server: options.server,
		families: imported
	};
	writeFileSync(
		join(options.migrationDir, IMPORT_RESULTS_FILE),
		JSON.stringify(initialResults, null, 2)
	);

	const finalStatuses = await pollImportedFamilies(
		options.server,
		imported,
		headers,
		fetchFn,
		sleepFn,
		maxPollAttempts,
		pollIntervalMs
	);

	const results: ImportResults = {
		importedAt: new Date().toISOString(),
		server: options.server,
		families: finalStatuses
	};
	writeFileSync(join(options.migrationDir, IMPORT_RESULTS_FILE), JSON.stringify(results, null, 2));
	return finalStatuses;
}

function readArg(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) return undefined;
	return value;
}

async function parseCliOptions(): Promise<ImportOptions> {
	const args = Bun.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`Usage:
  bun scripts/import-puzzle-families.ts [--server <url>] [--migration-dir <dir>]

Imports exported legacy puzzles into /api/admin/puzzle-families and restores owner_id.
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
	const migrationDir = readArg(args, '--migration-dir') ?? join(root, MIGRATION_DIR);
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
		migrationDir,
		skipAccess,
		cfAccessToken,
		cfClientId,
		cfClientSecret
	};
}

if (import.meta.main) {
	parseCliOptions()
		.then((options) => importPuzzleFamilies(options))
		.then((families) => {
			const ready = families.filter((family) => family.status === 'ready').length;
			const failed = families.filter((family) => family.status === 'failed').length;
			console.log(`Import complete: ${ready} ready, ${failed} failed`);
			if (failed > 0) process.exit(1);
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
