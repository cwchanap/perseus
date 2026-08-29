#!/usr/bin/env bun

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
	applyDotenvOverrides,
	assertHttpsCredentialServer,
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

export { assertHttpsCredentialServer } from './startup/types';

export type CleanupOptions = AccessCredentials & {
	server: string;
	migrationDir: string;
	fetchFn?: typeof fetch;
	runWrangler?: RunWrangler;
	dryRun?: boolean;
};

export type CleanupPlanAction =
	| { type: 'kv-delete'; key: string }
	| { type: 'r2-delete'; key: string; objectPath: string };

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

export function getLegacyR2Keys(legacyId: string, pieceCount: number): string[] {
	const keys = [`puzzles/${legacyId}/original`, `puzzles/${legacyId}/thumbnail.jpg`];
	for (let pieceId = 0; pieceId < pieceCount; pieceId++) {
		keys.push(`puzzles/${legacyId}/pieces/${pieceId}.png`);
	}
	return keys;
}

export function verifyManifestImportsCoverage(
	manifest: LegacyExportManifest,
	importResults: ImportResults
): void {
	const importedByLegacy = new Map(
		importResults.families.map((family) => [family.legacyId, family])
	);
	for (const entry of manifest.puzzles) {
		const imported = importedByLegacy.get(entry.legacyId);
		if (!imported) {
			throw new FatalError(
				`Missing imported family for manifest legacyId ${entry.legacyId}; refusing cleanup`
			);
		}
		if (imported.status !== 'ready') {
			throw new FatalError(
				`Imported family for ${entry.legacyId} is not ready (status=${imported.status})`
			);
		}
	}
}

type AdminPuzzleFamily = {
	id: string;
	status: string;
	variants?: {
		easy?: { id: string };
		normal?: { id: string };
		hard?: { id: string };
	};
};

export function collectVariantIdsFromFamilies(families: AdminPuzzleFamily[]): Set<string> {
	const variantIds = new Set<string>();
	for (const family of families) {
		for (const difficulty of ['easy', 'normal', 'hard'] as const) {
			const variantId = family.variants?.[difficulty]?.id;
			if (variantId) variantIds.add(variantId);
		}
	}
	return variantIds;
}

async function fetchAdminPuzzleFamilies(
	server: string,
	headers: Record<string, string>,
	fetchFn: typeof fetch
): Promise<AdminPuzzleFamily[]> {
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
	const payload = (await response.json()) as { families?: AdminPuzzleFamily[] };
	return payload.families ?? [];
}

export async function verifyReplacementsReady(
	server: string,
	families: ImportedFamily[],
	headers: Record<string, string>,
	fetchFn: typeof fetch
): Promise<AdminPuzzleFamily[]> {
	const adminFamilies = await fetchAdminPuzzleFamilies(server, headers, fetchFn);
	const byId = new Map(adminFamilies.map((family) => [family.id, family.status]));

	for (const family of families) {
		const status = byId.get(family.familyId);
		if (status !== 'ready') {
			throw new FatalError(
				`Replacement family ${family.familyId} (${family.name}) is not ready for cleanup (status=${status ?? 'missing'})`
			);
		}
	}
	return adminFamilies;
}

function parseKvKeyList(stdout: string): string[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new FatalError(
			`Failed to parse KV key list JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!Array.isArray(parsed)) {
		throw new FatalError('Unexpected KV key list response shape');
	}
	const keys: string[] = [];
	for (const entry of parsed) {
		if (
			entry &&
			typeof entry === 'object' &&
			typeof (entry as { name?: unknown }).name === 'string'
		) {
			keys.push((entry as { name: string }).name);
		}
	}
	return keys;
}

function parsePuzzleKvMetadata(stdout: string): {
	pieceCount: number | null;
	familyId: string | null;
} {
	const trimmed = stdout.trim();
	if (!trimmed) return { pieceCount: null, familyId: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new FatalError(
			`Failed to parse KV metadata JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!parsed || typeof parsed !== 'object') return { pieceCount: null, familyId: null };
	const record = parsed as { pieceCount?: unknown; familyId?: unknown };
	const pieceCount = record.pieceCount;
	const familyId = record.familyId;
	return {
		pieceCount:
			typeof pieceCount === 'number' && Number.isInteger(pieceCount) && pieceCount >= 0
				? pieceCount
				: null,
		familyId: typeof familyId === 'string' && familyId.length > 0 ? familyId : null
	};
}

function legacyIdFromPuzzleKvKey(key: string): string | null {
	if (!key.startsWith('puzzle:')) return null;
	const legacyId = key.slice('puzzle:'.length);
	return legacyId.length > 0 ? legacyId : null;
}

function isR2NotFoundError(result: { stdout: string; stderr: string }): boolean {
	const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
	return (
		output.includes('not found') ||
		output.includes('does not exist') ||
		output.includes('no such key') ||
		output.includes('10009')
	);
}

function buildDeletePlanForLegacyId(legacyId: string, pieceCount: number): CleanupPlanAction[] {
	const actions: CleanupPlanAction[] = [{ type: 'kv-delete', key: `puzzle:${legacyId}` }];
	for (const key of getLegacyR2Keys(legacyId, pieceCount)) {
		actions.push({ type: 'r2-delete', key, objectPath: `${R2_BUCKET}/${key}` });
	}
	return actions;
}

export function buildCleanupPlan(
	manifest: LegacyExportManifest,
	leftoverKvKeys: string[],
	leftoverPieceCounts: Map<string, number>
): CleanupPlanAction[] {
	const actions: CleanupPlanAction[] = [];
	const manifestByLegacy = new Map(manifest.puzzles.map((entry) => [entry.legacyId, entry]));

	for (const entry of manifest.puzzles) {
		actions.push(...buildDeletePlanForLegacyId(entry.legacyId, entry.pieceCount));
	}

	for (const kvKey of leftoverKvKeys) {
		const legacyId = legacyIdFromPuzzleKvKey(kvKey);
		if (!legacyId || manifestByLegacy.has(legacyId)) continue;
		const pieceCount = leftoverPieceCounts.get(legacyId);
		if (pieceCount === undefined) {
			throw new FatalError(
				`Cannot delete leftover legacy puzzle ${legacyId}: pieceCount unknown (not in manifest and KV metadata lacked pieceCount)`
			);
		}
		actions.push(...buildDeletePlanForLegacyId(legacyId, pieceCount));
	}

	return actions;
}

async function listLeftoverPuzzleKvKeys(runWrangler: RunWrangler): Promise<string[]> {
	const result = await runWrangler([
		'kv',
		'key',
		'list',
		'--binding',
		KV_BINDING,
		'--prefix',
		'puzzle:',
		'--remote',
		'--config',
		WRANGLER_CONFIG
	]);
	if (result.exitCode !== 0) {
		throw new FatalError(
			`Failed to list leftover puzzle:* KV keys:\n${result.stderr || result.stdout}`
		);
	}
	return parseKvKeyList(result.stdout);
}

async function fetchPuzzleKvMetadata(
	puzzleId: string,
	runWrangler: RunWrangler
): Promise<{ pieceCount: number | null; familyId: string | null }> {
	const result = await runWrangler([
		'kv',
		'key',
		'get',
		`puzzle:${puzzleId}`,
		'--binding',
		KV_BINDING,
		'--remote',
		'--config',
		WRANGLER_CONFIG
	]);
	if (result.exitCode !== 0) {
		throw new FatalError(
			`Failed to read KV metadata for puzzle:${puzzleId}:\n${result.stderr || result.stdout}`
		);
	}
	return parsePuzzleKvMetadata(result.stdout);
}

async function deleteKvKey(key: string, runWrangler: RunWrangler): Promise<void> {
	const result = await runWrangler([
		'kv',
		'key',
		'delete',
		key,
		'--binding',
		KV_BINDING,
		'--remote',
		'--config',
		WRANGLER_CONFIG
	]);
	if (result.exitCode !== 0) {
		throw new FatalError(`Failed to delete KV key ${key}:\n${result.stderr || result.stdout}`);
	}
}

async function deleteR2Key(objectPath: string, runWrangler: RunWrangler): Promise<void> {
	const result = await runWrangler([
		'r2',
		'object',
		'delete',
		objectPath,
		'--remote',
		'--config',
		WRANGLER_CONFIG
	]);
	if (result.exitCode !== 0 && !isR2NotFoundError(result)) {
		throw new FatalError(
			`Failed to delete R2 object ${objectPath}:\n${result.stderr || result.stdout}`
		);
	}
}

function printCleanupPlan(actions: CleanupPlanAction[]): void {
	console.log('Legacy puzzle cleanup dry-run plan:');
	for (const action of actions) {
		if (action.type === 'kv-delete') {
			console.log(`  kv key delete ${action.key}`);
		} else {
			console.log(`  r2 object delete ${action.objectPath}`);
		}
	}
}

async function executeCleanupPlan(
	actions: CleanupPlanAction[],
	runWrangler: RunWrangler
): Promise<void> {
	for (const action of actions) {
		if (action.type === 'kv-delete') {
			await deleteKvKey(action.key, runWrangler);
		} else {
			await deleteR2Key(action.objectPath, runWrangler);
		}
	}
}

export async function cleanupLegacyPuzzles(options: CleanupOptions): Promise<void> {
	const fetchFn = options.fetchFn ?? fetch;
	const runWrangler = options.runWrangler ?? defaultRunWrangler;
	const manifest = readManifest(options.migrationDir);
	const importResults = readImportResults(options.migrationDir);
	const headers = await resolveAccess(options);

	verifyManifestImportsCoverage(manifest, importResults);
	const adminFamilies = await verifyReplacementsReady(
		options.server,
		importResults.families,
		headers,
		fetchFn
	);
	const excludedVariantIds = collectVariantIdsFromFamilies(adminFamilies);

	const manifestLegacyIds = new Set(manifest.puzzles.map((entry) => entry.legacyId));
	const leftoverKvKeys = await listLeftoverPuzzleKvKeys(runWrangler);
	const leftoverPieceCounts = new Map<string, number>();
	const leftoverCandidateKvKeys: string[] = [];

	for (const kvKey of leftoverKvKeys) {
		const legacyId = legacyIdFromPuzzleKvKey(kvKey);
		if (!legacyId || manifestLegacyIds.has(legacyId)) continue;
		if (excludedVariantIds.has(legacyId)) continue;
		const metadata = await fetchPuzzleKvMetadata(legacyId, runWrangler);
		if (metadata.familyId) continue;
		leftoverCandidateKvKeys.push(kvKey);
		if (metadata.pieceCount !== null) leftoverPieceCounts.set(legacyId, metadata.pieceCount);
	}

	const plan = buildCleanupPlan(manifest, leftoverCandidateKvKeys, leftoverPieceCounts);

	if (options.dryRun) {
		printCleanupPlan(plan);
		return;
	}

	await executeCleanupPlan(plan, runWrangler);
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
	assertHttpsCredentialServer(server);
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
			if (!Bun.argv.includes('--dry-run')) {
				console.log('Legacy puzzle cleanup complete');
			}
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
