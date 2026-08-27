import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PuzzleCategory } from '@perseus/types';
import {
	exportLegacyPuzzles,
	fetchAllReadyPuzzles,
	fetchOwnerIds,
	MANIFEST_FILE,
	type LegacyExportManifest,
	type RunWrangler
} from './export-legacy-puzzles';
import { importPuzzleFamilies, pollImportedFamilies } from './import-puzzle-families';
import { cleanupLegacyPuzzles, verifyReplacementsReady } from './cleanup-legacy-puzzles';

const SERVER = 'https://example.test';
const PUZZLE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUZZLE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_A = 'player-a';
const OWNER_B = 'player-b';
const FAMILY_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FAMILY_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function makePng(): Uint8Array {
	const buf = new Uint8Array(24);
	buf[0] = 0x89;
	buf.set([0x50, 0x4e, 0x47], 1);
	buf[16] = 0;
	buf[17] = 1;
	buf[20] = 0;
	buf[21] = 1;
	return buf;
}

function makeManifest(dir: string, entries = 2): LegacyExportManifest {
	const puzzles = [
		{
			legacyId: PUZZLE_A,
			name: 'Alpha',
			category: 'Nature' as PuzzleCategory,
			aspectRatio: '1:1' as const,
			ownerId: OWNER_A,
			originalFile: `originals/${PUZZLE_A}.png`,
			contentType: 'image/png',
			byteLength: makePng().byteLength
		},
		{
			legacyId: PUZZLE_B,
			name: 'Beta',
			category: 'Animals' as PuzzleCategory,
			aspectRatio: '4:3' as const,
			ownerId: OWNER_B,
			originalFile: `originals/${PUZZLE_B}.png`,
			contentType: 'image/png',
			byteLength: makePng().byteLength
		}
	].slice(0, entries);

	mkdirSync(join(dir, 'originals'), { recursive: true });
	for (const puzzle of puzzles) {
		writeFileSync(join(dir, puzzle.originalFile), makePng());
	}

	const manifest: LegacyExportManifest = {
		exportedAt: '2026-08-27T00:00:00.000Z',
		server: SERVER,
		puzzles
	};
	writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
	return manifest;
}

describe('fetchAllReadyPuzzles', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('paginates until all ready puzzles are collected', async () => {
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			const offset = Number(url.searchParams.get('offset') ?? '0');
			if (offset === 0) {
				return new Response(
					JSON.stringify({
						puzzles: [{ id: PUZZLE_A, name: 'Alpha', status: 'ready', pieceCount: 100 }],
						total: 2,
						offset: 0,
						limit: 1
					}),
					{ status: 200 }
				);
			}
			return new Response(
				JSON.stringify({
					puzzles: [{ id: PUZZLE_B, name: 'Beta', status: 'ready', pieceCount: 48 }],
					total: 2,
					offset: 1,
					limit: 1
				}),
				{ status: 200 }
			);
		}) as unknown as typeof fetch;

		const puzzles = await fetchAllReadyPuzzles(SERVER, {}, globalThis.fetch, 1);
		expect(puzzles).toHaveLength(2);
		expect(puzzles.map((p) => p.id)).toEqual([PUZZLE_A, PUZZLE_B]);
	});
});

describe('fetchOwnerIds', () => {
	it('parses owner_id rows from wrangler d1 execute output', async () => {
		const runWrangler: RunWrangler = async () => ({
			exitCode: 0,
			stdout: JSON.stringify([
				{
					results: [
						{ id: PUZZLE_A, owner_id: OWNER_A },
						{ id: PUZZLE_B, owner_id: OWNER_B }
					],
					success: true
				}
			]),
			stderr: ''
		});

		const owners = await fetchOwnerIds([PUZZLE_A, PUZZLE_B], runWrangler);
		expect(owners.get(PUZZLE_A)).toBe(OWNER_A);
		expect(owners.get(PUZZLE_B)).toBe(OWNER_B);
	});
});

describe('exportLegacyPuzzles', () => {
	const originalFetch = globalThis.fetch;
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'perseus-export-'));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	});

	it('fails when a ready puzzle cannot download original bytes', async () => {
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/api/puzzles?')) {
				return new Response(
					JSON.stringify({
						puzzles: [
							{
								id: PUZZLE_A,
								name: 'Alpha',
								status: 'ready',
								pieceCount: 100,
								category: 'Nature',
								aspectRatio: '1:1'
							}
						],
						total: 1,
						offset: 0,
						limit: 100
					}),
					{ status: 200 }
				);
			}
			if (url.endsWith(`/api/puzzles/${PUZZLE_A}/reference`)) {
				return new Response('missing', { status: 404 });
			}
			throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
		}) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async () => ({
			exitCode: 0,
			stdout: JSON.stringify([{ results: [{ id: PUZZLE_A, owner_id: OWNER_A }], success: true }]),
			stderr: ''
		});

		await expect(
			exportLegacyPuzzles({
				server: SERVER,
				outputDir: dir,
				skipAccess: true,
				fetchFn: globalThis.fetch,
				runWrangler
			})
		).rejects.toThrow(/cannot export ready puzzle/i);
	});

	it('writes manifest and original bytes for every ready puzzle', async () => {
		const png = makePng();
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/api/puzzles?')) {
				return new Response(
					JSON.stringify({
						puzzles: [
							{
								id: PUZZLE_A,
								name: 'Alpha',
								status: 'ready',
								pieceCount: 100,
								category: 'Nature',
								aspectRatio: '1:1'
							}
						],
						total: 1,
						offset: 0,
						limit: 100
					}),
					{ status: 200 }
				);
			}
			if (url.endsWith(`/api/puzzles/${PUZZLE_A}/reference`)) {
				return new Response(png, {
					status: 200,
					headers: { 'Content-Type': 'image/png' }
				});
			}
			throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
		}) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async () => ({
			exitCode: 0,
			stdout: JSON.stringify([{ results: [{ id: PUZZLE_A, owner_id: OWNER_A }], success: true }]),
			stderr: ''
		});

		const manifest = await exportLegacyPuzzles({
			server: SERVER,
			outputDir: dir,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler
		});

		expect(manifest.puzzles).toHaveLength(1);
		expect(manifest.puzzles[0]?.ownerId).toBe(OWNER_A);
		const saved = readFileSync(join(dir, manifest.puzzles[0]!.originalFile));
		expect(saved.byteLength).toBe(png.byteLength);
	});
});

describe('importPuzzleFamilies', () => {
	const originalFetch = globalThis.fetch;
	let dir: string;
	const wranglerCalls: string[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'perseus-import-'));
		wranglerCalls.length = 0;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	});

	it('POSTs each original, updates owner_id, and polls to ready/failed', async () => {
		makeManifest(dir);
		const posts: string[] = [];
		let pollCount = 0;

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzle-families')) {
				const body = init.body as FormData;
				posts.push(String(body.get('name')));
				const id = posts.length === 1 ? FAMILY_A : FAMILY_B;
				return new Response(JSON.stringify({ id, status: 'processing' }), { status: 201 });
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzle-families')) {
				pollCount++;
				const ready = pollCount >= 2;
				return new Response(
					JSON.stringify({
						families: [
							{ id: FAMILY_A, name: 'Alpha', status: ready ? 'ready' : 'processing' },
							{ id: FAMILY_B, name: 'Beta', status: ready ? 'ready' : 'processing' }
						]
					}),
					{ status: 200 }
				);
			}
			throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
		}) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async (args) => {
			wranglerCalls.push(args.join(' '));
			return { exitCode: 0, stdout: '[]', stderr: '' };
		};

		const results = await importPuzzleFamilies({
			server: SERVER,
			migrationDir: dir,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler,
			sleepFn: async () => {}
		});

		expect(posts).toEqual(['Alpha', 'Beta']);
		expect(wranglerCalls.some((call) => call.includes('UPDATE puzzle_families'))).toBe(true);
		expect(results.every((r) => r.status === 'ready')).toBe(true);
	});
});

describe('pollImportedFamilies', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns failed when a family ends in failed status', async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						families: [{ id: FAMILY_A, name: 'Alpha', status: 'failed' }]
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;

		const statuses = await pollImportedFamilies(
			SERVER,
			[
				{
					legacyId: PUZZLE_A,
					familyId: FAMILY_A,
					name: 'Alpha',
					ownerId: OWNER_A,
					status: 'processing'
				}
			],
			{},
			globalThis.fetch,
			async () => {},
			1,
			1
		);
		expect(statuses[0]?.status).toBe('failed');
	});
});

describe('verifyReplacementsReady', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('rejects cleanup when replacements are not all ready', async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						families: [{ id: FAMILY_A, name: 'Alpha', status: 'processing' }]
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;

		await expect(
			verifyReplacementsReady(
				SERVER,
				[
					{
						legacyId: PUZZLE_A,
						familyId: FAMILY_A,
						name: 'Alpha',
						ownerId: OWNER_A,
						status: 'processing'
					}
				],
				{},
				globalThis.fetch
			)
		).rejects.toThrow(/not ready/i);
	});
});

describe('cleanupLegacyPuzzles', () => {
	let dir: string;
	const wranglerCalls: string[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'perseus-cleanup-'));
		wranglerCalls.length = 0;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('refuses cleanup before verify succeeds', async () => {
		makeManifest(dir);
		writeFileSync(
			join(dir, 'import-results.json'),
			JSON.stringify({
				importedAt: '2026-08-27T00:00:00.000Z',
				families: [
					{
						legacyId: PUZZLE_A,
						familyId: FAMILY_A,
						name: 'Alpha',
						ownerId: OWNER_A,
						status: 'processing'
					}
				]
			})
		);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						families: [{ id: FAMILY_A, name: 'Alpha', status: 'processing' }]
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async (args) => {
			wranglerCalls.push(args.join(' '));
			return { exitCode: 0, stdout: '[]', stderr: '' };
		};

		await expect(
			cleanupLegacyPuzzles({
				migrationDir: dir,
				server: SERVER,
				skipAccess: true,
				fetchFn: globalThis.fetch,
				runWrangler
			})
		).rejects.toThrow(/not ready/i);

		expect(wranglerCalls.some((call) => call.includes('kv key delete'))).toBe(false);
		globalThis.fetch = originalFetch;
	});

	it('deletes legacy KV and R2 objects only after verify succeeds', async () => {
		makeManifest(dir, 1);
		writeFileSync(
			join(dir, 'import-results.json'),
			JSON.stringify({
				importedAt: '2026-08-27T00:00:00.000Z',
				families: [
					{
						legacyId: PUZZLE_A,
						familyId: FAMILY_A,
						name: 'Alpha',
						ownerId: OWNER_A,
						status: 'ready'
					}
				]
			})
		);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						families: [{ id: FAMILY_A, name: 'Alpha', status: 'ready' }]
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async (args) => {
			wranglerCalls.push(args.join(' '));
			if (args.includes('r2') && args.includes('list')) {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						objects: [
							{ key: `puzzles/${PUZZLE_A}/original` },
							{ key: `puzzles/${PUZZLE_A}/thumbnail.jpg` },
							{ key: `puzzles/${PUZZLE_A}/pieces/0.png` }
						]
					}),
					stderr: ''
				};
			}
			return { exitCode: 0, stdout: '[]', stderr: '' };
		};

		await cleanupLegacyPuzzles({
			migrationDir: dir,
			server: SERVER,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler
		});

		expect(wranglerCalls.some((call) => call.includes(`puzzle:${PUZZLE_A}`))).toBe(true);
		expect(wranglerCalls.some((call) => call.includes(`puzzles/${PUZZLE_A}/original`))).toBe(true);
		globalThis.fetch = originalFetch;
	});
});
