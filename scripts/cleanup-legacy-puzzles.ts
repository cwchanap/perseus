#!/usr/bin/env bun

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
	applyDotenvOverrides,
	FatalError,
	FETCH_TIMEOUT_MS,
	isLocalServer,
	type AccessCredentials
} from './startup/types';
import { accessHeaders, hasAccessCredentials } from './startup/upload';
import { resolveAccessToken, probeAccessToken, probeServiceToken } from './startup/token';
import {
	defaultRunWrangler,
	KV_BINDING,
	MANIFEST_FILE,
	MIGRATION_DIR,
	R2_BUCKET,
	WRANGLER_CONFIG,
	type LegacyExportManifest,
	type RunWrangler
} from './export-legacy-puzzles';
import {
	IMPORT_RESULTS_FILE,
	type ImportResults,
	type ImportedFamily
} from './import-puzzle-families';

export type CleanupOptions = AccessCredentials & {
	server: string;
	migrationDir: string;
	fetchFn?: typeof fetch;
	runWrangler?: RunWrangler;
	dryRun?: boolean;
};

type R2ListResponse = {
	objects?: Array<{ key: string }>;
};

function readManifest(migrationDir: string): LegacyExportManifest {
	return JSON.parse(
		readFileSync(join(migrationDir, MANIFEST_FILE), 'utf8')
	) as LegacyExportManifest;
}

function readImportResults(migrationDir: string): ImportResults {
	return JSON.parse(readFileSync(join(migrationDir, IMPORT_RESULTS_FILE), 'utf8')) as ImportResults;
}

async function resolveAccess(options: CleanupOptions): Promise<Record<string, string>> {
	if (options.skipAccess || isLocalServer(options.server)) return accessHeaders(options);
	if (!hasAccessCredentials(options)) {
		throw new FatalError('Cloudflare Access credentials are required for verification.');
	}
	if (options.cfAccessToken) {
		const outcome = await probeAccessToken(options.server, options.cfAccessToken);
		if (outcome !== 'ok') {
			throw new FatalError('Cloudflare Access JWT probe failed for cleanup verification.');
		}
	}
	if (options.cfClientId && options.cfClientSecret) {
		const outcome = await probeServiceToken(
			options.server,
			options.cfClientId,
			options.cfClientSecret
		);
		if (outcome !== 'ok') {
			throw new FatalError(
				'Cloudflare Access service token probe failed for cleanup verification.'
			);
		}
	}
	return accessHeaders(options);
}

export async function verifyReplacementsReady(
	server: string,
	families: ImportedFamily[],
	headers: Record<string, string>,
	fetchFn: typeof fetch
): Promise<void> {
	const response = await fetchFn(`${server.replace(/\/+$/, '')}/api/admin/puzzle-families`, {
		method: 'GET',
		headers,
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!response.ok) {
		throw new FatalError(
			`Failed to verify imported families (${response.status} ${response.statusText})`
		);
	}
	const payload = (await response.json()) as { families?: Array<{ id: string; status: string }> };
	const byId = new Map((payload.families ?? []).map((family) => [family.id, family.status]));

	for (const family of families) {
		const status = byId.get(family.familyId);
		if (status !== 'ready') {
			throw new FatalError(
				`Replacement family ${family.familyId} (${family.name}) is not ready for cleanup (status=${status ?? 'missing'})`
			);
		}
	}
}

async function listLegacyR2Keys(legacyId: string, runWrangler: RunWrangler): Promise<string[]> {
	const prefix = `puzzles/${legacyId}/`;
	const result = await runWrangler([
		'r2',
		'object',
		'list',
		R2_BUCKET,
		'--prefix',
		prefix,
		'--remote',
		'--config',
		WRANGLER_CONFIG,
		'--json'
	]);
	if (result.exitCode !== 0) {
		throw new FatalError(
			`Failed to list R2 objects for ${legacyId}:\n${result.stderr || result.stdout}`
		);
	}
	try {
		const parsed = JSON.parse(result.stdout) as R2ListResponse;
		return (parsed.objects ?? []).map((object) => object.key);
	} catch {
		return [];
	}
}

async function deleteKvKey(
	legacyId: string,
	runWrangler: RunWrangler,
	dryRun: boolean
): Promise<void> {
	const args = [
		'kv',
		'key',
		'delete',
		`puzzle:${legacyId}`,
		'--binding',
		KV_BINDING,
		'--remote',
		'--config',
		WRANGLER_CONFIG
	];
	if (dryRun) return;
	const result = await runWrangler(args);
	if (result.exitCode !== 0) {
		throw new FatalError(
			`Failed to delete KV key puzzle:${legacyId}:\n${result.stderr || result.stdout}`
		);
	}
}

async function deleteR2Key(key: string, runWrangler: RunWrangler, dryRun: boolean): Promise<void> {
	const args = ['r2', 'object', 'delete', R2_BUCKET, key, '--remote', '--config', WRANGLER_CONFIG];
	if (dryRun) return;
	const result = await runWrangler(args);
	if (result.exitCode !== 0) {
		throw new FatalError(`Failed to delete R2 object ${key}:\n${result.stderr || result.stdout}`);
	}
}

export async function cleanupLegacyPuzzles(options: CleanupOptions): Promise<void> {
	const fetchFn = options.fetchFn ?? fetch;
	const runWrangler = options.runWrangler ?? defaultRunWrangler;
	const manifest = readManifest(options.migrationDir);
	const importResults = readImportResults(options.migrationDir);
	const headers = await resolveAccess(options);

	await verifyReplacementsReady(options.server, importResults.families, headers, fetchFn);

	for (const entry of manifest.puzzles) {
		await deleteKvKey(entry.legacyId, runWrangler, !!options.dryRun);
		const keys = await listLegacyR2Keys(entry.legacyId, runWrangler);
		for (const key of keys) {
			await deleteR2Key(key, runWrangler, !!options.dryRun);
		}
	}
}

function readArg(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) return undefined;
	return value;
}

async function parseCliOptions(): Promise<CleanupOptions> {
	const args = Bun.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`Usage:
  bun scripts/cleanup-legacy-puzzles.ts [--server <url>] [--migration-dir <dir>] [--dry-run]

Deletes legacy puzzle:* KV keys and puzzles/<oldId>/ R2 objects after replacements verify ready.
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
	const dryRun = args.includes('--dry-run');

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
		dryRun,
		cfAccessToken,
		cfClientId,
		cfClientSecret
	};
}

if (import.meta.main) {
	parseCliOptions()
		.then((options) => cleanupLegacyPuzzles(options))
		.then(() => {
			console.log('Legacy puzzle cleanup complete');
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
