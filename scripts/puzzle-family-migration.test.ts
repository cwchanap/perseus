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
	R2_BUCKET,
	type LegacyExportManifest,
	type RunWrangler
} from './export-legacy-puzzles';
import {
	importPuzzleFamilies,
	pollImportedFamilies,
	type ImportResults
} from './import-puzzle-families';
import {
	cleanupLegacyPuzzles,
	getLegacyR2Keys,
	verifyReplacementsReady,
	assertHttpsCredentialServer
} from './cleanup-legacy-puzzles';

const SERVER = 'https://example.test';
const PUZZLE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUZZLE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PUZZLE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_A = 'player-a';
const OWNER_B = 'player-b';
const FAMILY_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FAMILY_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VARIANT_EASY = '11111111-1111-4111-8111-111111111111';
const VARIANT_NORMAL = '22222222-2222-4222-8222-222222222222';
const VARIANT_HARD = '33333333-3333-4333-8333-333333333333';

function readyFamilyResponse(
	familyId: string,
	name: string,
	variantIds = {
		easy: VARIANT_EASY,
		normal: VARIANT_NORMAL,
		hard: VARIANT_HARD
	}
) {
	return {
		id: familyId,
		name,
		status: 'ready',
		variants: {
			easy: { id: variantIds.easy, difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: variantIds.normal, difficulty: 'normal', pieceCount: 48, status: 'ready' },
			hard: { id: variantIds.hard, difficulty: 'hard', pieceCount: 100, status: 'ready' }
		}
	};
}

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
			pieceCount: 100,
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
			pieceCount: 48,
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

describe('getLegacyR2Keys', () => {
	it('enumerates original, thumbnail, and piece keys from pieceCount', () => {
		const keys = getLegacyR2Keys(PUZZLE_A, 3);
		expect(keys).toEqual([
			`puzzles/${PUZZLE_A}/original`,
			`puzzles/${PUZZLE_A}/thumbnail.jpg`,
			`puzzles/${PUZZLE_A}/pieces/0.png`,
			`puzzles/${PUZZLE_A}/pieces/1.png`,
			`puzzles/${PUZZLE_A}/pieces/2.png`
		]);
	});
});

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
		expect(manifest.puzzles[0]?.pieceCount).toBe(100);
		const saved = readFileSync(join(dir, manifest.puzzles[0]!.originalFile));
		expect(saved.byteLength).toBe(png.byteLength);
	});

	it('derives aspectRatio from original bytes when API omits it', async () => {
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
								pieceCount: 100
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

		expect(manifest.puzzles[0]?.aspectRatio).toBe('1:1');
		expect(manifest.puzzles[0]?.category).toBeUndefined();
	});
});

describe('importPuzzleFamilies', () => {
	const originalFetch = globalThis.fetch;
	let dir: string;
	const wranglerCalls: string[][] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'perseus-import-'));
		wranglerCalls.length = 0;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	});

	it('POSTs each original, updates owner_id with --yes --json, and polls to ready/failed', async () => {
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
			wranglerCalls.push([...args]);
			return {
				exitCode: 0,
				stdout: JSON.stringify([{ results: [], success: true, meta: { changes: 1 } }]),
				stderr: ''
			};
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
		const updateCall = wranglerCalls.find((args) =>
			args.some((arg) => arg.includes('UPDATE puzzle_families'))
		);
		expect(updateCall).toBeDefined();
		expect(updateCall).toContain('--yes');
		expect(updateCall).toContain('--json');
		expect(results.every((r) => r.status === 'ready')).toBe(true);
	});

	it('does not coalesce distinct legacy puzzles that share name + aspectRatio', async () => {
		// Two legacy entries with identical name + aspectRatio but different
		// legacyIds. The legacy catalog does not enforce unique names, so this
		// is a legitimate input. The import must create two distinct families
		// (distinct Idempotency-Key headers), not reuse one replacement.
		const manifest = makeManifest(dir, 1);
		manifest.puzzles.push({
			legacyId: PUZZLE_B,
			name: 'Alpha',
			category: 'Nature' as PuzzleCategory,
			aspectRatio: '1:1' as const,
			ownerId: OWNER_B,
			pieceCount: 100,
			originalFile: `originals/${PUZZLE_B}.png`,
			contentType: 'image/png',
			byteLength: makePng().byteLength
		});
		writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
		mkdirSync(join(dir, 'originals'), { recursive: true });
		writeFileSync(join(dir, `originals/${PUZZLE_B}.png`), makePng());

		const postedKeys: string[] = [];
		let created = 0;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzle-families')) {
				const headerKey = (init.headers as Record<string, string>)['Idempotency-Key'];
				postedKeys.push(headerKey);
				created += 1;
				return new Response(
					JSON.stringify({ id: created === 1 ? FAMILY_A : FAMILY_B, status: 'ready' }),
					{ status: 201 }
				);
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzle-families')) {
				return new Response(
					JSON.stringify({
						families: [
							{ id: FAMILY_A, name: 'Alpha', status: 'ready' },
							{ id: FAMILY_B, name: 'Alpha', status: 'ready' }
						]
					}),
					{ status: 200 }
				);
			}
			throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
		}) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async () => ({
			exitCode: 0,
			stdout: JSON.stringify([{ results: [], success: true, meta: { changes: 1 } }]),
			stderr: ''
		});

		const results = await importPuzzleFamilies({
			server: SERVER,
			migrationDir: dir,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler,
			sleepFn: async () => {}
		});

		// Distinct legacyIds produced distinct idempotency keys → no coalescing.
		expect(postedKeys).toHaveLength(2);
		expect(postedKeys[0]).not.toBe(postedKeys[1]);
		expect(results.map((r) => r.familyId).sort()).toEqual([FAMILY_A, FAMILY_B].sort());
		expect(results.map((r) => r.legacyId).sort()).toEqual([PUZZLE_A, PUZZLE_B].sort());
	});

	it('omits category from FormData when manifest entry has no category', async () => {
		const manifest = makeManifest(dir, 1);
		delete (manifest.puzzles[0] as { category?: PuzzleCategory }).category;
		writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzle-families')) {
				const body = init.body as FormData;
				expect(body.has('category')).toBe(false);
				return new Response(JSON.stringify({ id: FAMILY_A, status: 'ready' }), { status: 201 });
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzle-families')) {
				return new Response(
					JSON.stringify({
						families: [{ id: FAMILY_A, name: 'Alpha', status: 'ready' }]
					}),
					{ status: 200 }
				);
			}
			throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
		}) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async () => ({
			exitCode: 0,
			stdout: JSON.stringify([{ results: [], success: true, meta: { changes: 1 } }]),
			stderr: ''
		});

		await importPuzzleFamilies({
			server: SERVER,
			migrationDir: dir,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler,
			sleepFn: async () => {}
		});
	});

	it('persists import-results.json before polling, so a poll failure still leaves an artifact', async () => {
		makeManifest(dir, 1);

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzle-families')) {
				return new Response(JSON.stringify({ id: FAMILY_A, status: 'processing' }), {
					status: 201
				});
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzle-families')) {
				// Polling blows up while the family is still processing.
				throw new Error('poll network failure');
			}
			throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
		}) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async () => ({
			exitCode: 0,
			stdout: JSON.stringify([{ results: [], success: true, meta: { changes: 1 } }]),
			stderr: ''
		});

		await expect(
			importPuzzleFamilies({
				server: SERVER,
				migrationDir: dir,
				skipAccess: true,
				fetchFn: globalThis.fetch,
				runWrangler,
				sleepFn: async () => {}
			})
		).rejects.toThrow('poll network failure');

		// The durable artifact written BEFORE polling survives the failure and
		// lists the created family as still processing.
		const results = JSON.parse(
			readFileSync(join(dir, 'import-results.json'), 'utf8')
		) as ImportResults;
		expect(results.families).toHaveLength(1);
		expect(results.families[0]).toMatchObject({
			familyId: FAMILY_A,
			status: 'processing'
		});
	});

	it('fails owner update when D1 reports zero changes', async () => {
		makeManifest(dir, 1);

		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzle-families')) {
				return new Response(JSON.stringify({ id: FAMILY_A, status: 'processing' }), {
					status: 201
				});
			}
			throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
		}) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async () => ({
			exitCode: 0,
			stdout: JSON.stringify([{ results: [], success: true, meta: { changes: 0 } }]),
			stderr: ''
		});

		await expect(
			importPuzzleFamilies({
				server: SERVER,
				migrationDir: dir,
				skipAccess: true,
				fetchFn: globalThis.fetch,
				runWrangler,
				sleepFn: async () => {}
			})
		).rejects.toThrow(/changed zero rows/i);
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

describe('assertHttpsCredentialServer', () => {
	it('accepts https remotes and any local server, rejects http remotes', () => {
		expect(() => assertHttpsCredentialServer('https://perseus.cwchanap.dev')).not.toThrow();
		expect(() => assertHttpsCredentialServer('http://localhost:4690')).not.toThrow();
		expect(() => assertHttpsCredentialServer('http://127.0.0.1:8787')).not.toThrow();
		expect(() => assertHttpsCredentialServer('http://evil.example.com')).toThrow(/non-HTTPS/);
		// Scheme-less values cannot be verified as local — rejected.
		expect(() => assertHttpsCredentialServer('perseus.cwchanap.dev')).toThrow(/non-HTTPS/);
	});
});

describe('cleanupLegacyPuzzles', () => {
	let dir: string;
	const wranglerCalls: string[][] = [];
	const logs: string[] = [];
	const originalLog = console.log;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'perseus-cleanup-'));
		wranglerCalls.length = 0;
		logs.length = 0;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(' '));
		};
	});

	afterEach(() => {
		console.log = originalLog;
		globalThis.fetch = originalFetch;
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
			wranglerCalls.push([...args]);
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

		expect(wranglerCalls.some((args) => args.includes('delete'))).toBe(false);
	});

	it('refuses cleanup when manifest legacyIds lack ready imported families', async () => {
		makeManifest(dir, 2);
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
			wranglerCalls.push([...args]);
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
		).rejects.toThrow(/missing imported family/i);

		expect(wranglerCalls.some((args) => args.includes('delete'))).toBe(false);
	});

	it('deletes legacy KV and R2 objects with bucket/key delete argv after verify succeeds', async () => {
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
			wranglerCalls.push([...args]);
			if (args.includes('kv') && args.includes('list')) {
				return { exitCode: 0, stdout: '[]', stderr: '' };
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		};

		await cleanupLegacyPuzzles({
			migrationDir: dir,
			server: SERVER,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler
		});

		expect(wranglerCalls.some((args) => args.includes(`puzzle:${PUZZLE_A}`))).toBe(true);
		const r2Delete = wranglerCalls.find(
			(args) => args[0] === 'r2' && args[1] === 'object' && args[2] === 'delete'
		);
		expect(r2Delete).toBeDefined();
		expect(r2Delete?.[3]).toBe(`${R2_BUCKET}/puzzles/${PUZZLE_A}/original`);
		expect(
			wranglerCalls.some((args) => args[3] === `${R2_BUCKET}/puzzles/${PUZZLE_A}/pieces/0.png`)
		).toBe(true);
	});

	it('treats R2 not-found delete errors as success', async () => {
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
			wranglerCalls.push([...args]);
			if (args.includes('r2') && args.includes('delete')) {
				return { exitCode: 1, stdout: '', stderr: 'Object not found' };
			}
			if (args.includes('kv') && args.includes('list')) {
				return { exitCode: 0, stdout: '[]', stderr: '' };
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		};

		await expect(
			cleanupLegacyPuzzles({
				migrationDir: dir,
				server: SERVER,
				skipAccess: true,
				fetchFn: globalThis.fetch,
				runWrangler
			})
		).resolves.toBeUndefined();
	});

	it('does not delete leftover puzzle: keys that are imported family variant ids', async () => {
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

		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ families: [readyFamilyResponse(FAMILY_A, 'Alpha')] }), {
					status: 200
				})
		) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async (args) => {
			wranglerCalls.push([...args]);
			if (args.includes('kv') && args.includes('list')) {
				return {
					exitCode: 0,
					stdout: JSON.stringify([{ name: `puzzle:${VARIANT_EASY}` }]),
					stderr: ''
				};
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		};

		await cleanupLegacyPuzzles({
			migrationDir: dir,
			server: SERVER,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler
		});

		expect(
			wranglerCalls.some(
				(args) =>
					args.includes('kv') && args.includes('delete') && args.includes(`puzzle:${VARIANT_EASY}`)
			)
		).toBe(false);
		expect(
			wranglerCalls.some((args) => args[3] === `${R2_BUCKET}/puzzles/${VARIANT_EASY}/original`)
		).toBe(false);
		expect(wranglerCalls.some((args) => args.includes(`puzzle:${PUZZLE_A}`))).toBe(true);
	});

	it('does not delete leftover puzzle: keys whose KV metadata includes familyId', async () => {
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

		const orphanVariant = '44444444-4444-4444-8444-444444444444';
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ families: [readyFamilyResponse(FAMILY_A, 'Alpha')] }), {
					status: 200
				})
		) as unknown as typeof fetch;

		const runWrangler: RunWrangler = async (args) => {
			wranglerCalls.push([...args]);
			if (args.includes('kv') && args.includes('list')) {
				return {
					exitCode: 0,
					stdout: JSON.stringify([{ name: `puzzle:${orphanVariant}` }]),
					stderr: ''
				};
			}
			if (args.includes('kv') && args.includes('get') && args.includes(`puzzle:${orphanVariant}`)) {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						pieceCount: 48,
						status: 'ready',
						familyId: FAMILY_A
					}),
					stderr: ''
				};
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		};

		await cleanupLegacyPuzzles({
			migrationDir: dir,
			server: SERVER,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler
		});

		expect(
			wranglerCalls.some(
				(args) =>
					args.includes('kv') && args.includes('delete') && args.includes(`puzzle:${orphanVariant}`)
			)
		).toBe(false);
		expect(
			wranglerCalls.some((args) => args[3] === `${R2_BUCKET}/puzzles/${orphanVariant}/original`)
		).toBe(false);
	});

	it('fails closed when a leftover puzzle: key lacks a usable pieceCount', async () => {
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
			wranglerCalls.push([...args]);
			if (args.includes('kv') && args.includes('list')) {
				return {
					exitCode: 0,
					stdout: JSON.stringify([{ name: `puzzle:${PUZZLE_C}` }]),
					stderr: ''
				};
			}
			if (args.includes('kv') && args.includes('get') && args.includes(`puzzle:${PUZZLE_C}`)) {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ status: 'ready' }),
					stderr: ''
				};
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		};

		await expect(
			cleanupLegacyPuzzles({
				migrationDir: dir,
				server: SERVER,
				skipAccess: true,
				fetchFn: globalThis.fetch,
				runWrangler
			})
		).rejects.toThrow(
			`Cannot delete leftover legacy puzzle ${PUZZLE_C}: pieceCount unknown (not in manifest and KV metadata lacked pieceCount)`
		);

		expect(wranglerCalls.some((args) => args.includes('delete'))).toBe(false);
	});

	it('deletes leftover puzzle: KV keys not covered by the manifest', async () => {
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
			wranglerCalls.push([...args]);
			if (args.includes('kv') && args.includes('list')) {
				return {
					exitCode: 0,
					stdout: JSON.stringify([{ name: `puzzle:${PUZZLE_C}` }]),
					stderr: ''
				};
			}
			if (args.includes('kv') && args.includes('get') && args.includes(`puzzle:${PUZZLE_C}`)) {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ pieceCount: 2, status: 'ready' }),
					stderr: ''
				};
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		};

		await cleanupLegacyPuzzles({
			migrationDir: dir,
			server: SERVER,
			skipAccess: true,
			fetchFn: globalThis.fetch,
			runWrangler
		});

		expect(wranglerCalls.some((args) => args.includes(`puzzle:${PUZZLE_C}`))).toBe(true);
		expect(
			wranglerCalls.some((args) => args[3] === `${R2_BUCKET}/puzzles/${PUZZLE_C}/original`)
		).toBe(true);
	});

	it('prints delete plan on --dry-run without invoking wrangler mutations', async () => {
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
			wranglerCalls.push([...args]);
			if (args.includes('kv') && args.includes('list')) {
				return { exitCode: 0, stdout: '[]', stderr: '' };
			}
			return { exitCode: 0, stdout: '[]', stderr: '' };
		};

		await cleanupLegacyPuzzles({
			migrationDir: dir,
			server: SERVER,
			skipAccess: true,
			dryRun: true,
			fetchFn: globalThis.fetch,
			runWrangler
		});

		expect(wranglerCalls.some((args) => args.includes('delete'))).toBe(false);
		expect(wranglerCalls.some((args) => args.includes('list'))).toBe(true);
		expect(logs.some((line) => line.includes('dry-run'))).toBe(true);
		expect(logs.some((line) => line.includes(`puzzle:${PUZZLE_A}`))).toBe(true);
	});
});
