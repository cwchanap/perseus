import { describe, expect, it, vi } from 'vitest';
import type { Puzzle } from '$lib/types/puzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
import {
	getDifficultyPieceCount,
	PUZZLE_DIFFICULTIES,
	type PuzzleAspectRatio,
	type PuzzleDifficulty,
	type PuzzleFamilySummary,
	type PuzzleStatus
} from '@perseus/types';
import {
	createSessionStorageAdapter,
	listResumableSessionCandidateIds
} from './session/persistence';
import { memoryStorage, seal, validSnapshot } from './session/persistence.test-fixtures';
import type {
	PersistedPuzzleSessionV1,
	SessionLoadResult,
	SessionStorageAdapter,
	SessionValidationContext
} from '@perseus/game-core';
import { discoverAllSavedProgress, discoverGalleryProgress } from './galleryProgress';

const expectedSquare16 = Array.from({ length: 16 }, (_, id) => ({
	id,
	correctX: id % 4,
	correctY: Math.floor(id / 4)
}));

const expectedLandscape12 = [
	{ id: 0, correctX: 0, correctY: 0 },
	{ id: 1, correctX: 1, correctY: 0 },
	{ id: 2, correctX: 2, correctY: 0 },
	{ id: 3, correctX: 3, correctY: 0 },
	{ id: 4, correctX: 0, correctY: 1 },
	{ id: 5, correctX: 1, correctY: 1 },
	{ id: 6, correctX: 2, correctY: 1 },
	{ id: 7, correctX: 3, correctY: 1 },
	{ id: 8, correctX: 0, correctY: 2 },
	{ id: 9, correctX: 1, correctY: 2 },
	{ id: 10, correctX: 2, correctY: 2 },
	{ id: 11, correctX: 3, correctY: 2 }
];

const expectedPortrait12 = [
	{ id: 0, correctX: 0, correctY: 0 },
	{ id: 1, correctX: 1, correctY: 0 },
	{ id: 2, correctX: 2, correctY: 0 },
	{ id: 3, correctX: 0, correctY: 1 },
	{ id: 4, correctX: 1, correctY: 1 },
	{ id: 5, correctX: 2, correctY: 1 },
	{ id: 6, correctX: 0, correctY: 2 },
	{ id: 7, correctX: 1, correctY: 2 },
	{ id: 8, correctX: 2, correctY: 2 },
	{ id: 9, correctX: 0, correctY: 3 },
	{ id: 10, correctX: 1, correctY: 3 },
	{ id: 11, correctX: 2, correctY: 3 }
];

function serverFamily(
	easyVariantId: string,
	aspectRatio: PuzzleAspectRatio,
	overrides: Partial<PuzzleFamilySummary> = {},
	variantStatus: Partial<Record<PuzzleDifficulty, PuzzleStatus>> = {}
): PuzzleFamilySummary {
	const familyStatus = overrides.status ?? 'ready';
	const variants = {} as PuzzleFamilySummary['variants'];
	for (const difficulty of PUZZLE_DIFFICULTIES) {
		const pieceCount = getDifficultyPieceCount(aspectRatio, difficulty);
		const id =
			difficulty === 'easy'
				? easyVariantId
				: `${easyVariantId}-${difficulty === 'normal' ? 'n' : 'h'}`;
		variants[difficulty] = {
			id,
			difficulty,
			pieceCount,
			status: variantStatus[difficulty] ?? familyStatus
		};
	}
	return {
		id: overrides.id ?? `fam-${easyVariantId}`,
		name: overrides.name ?? easyVariantId,
		aspectRatio,
		status: familyStatus,
		createdAt: 1000,
		variants,
		...overrides
	};
}

function variantSnapshot(variantId: string, pieceCount: number): PersistedPuzzleSessionV1 {
	return {
		...validSnapshot(),
		puzzleId: variantId,
		trayOrder: Array.from({ length: pieceCount }, (_, index) => index)
	};
}

function apiProgressSnapshot(
	variantId: string,
	overrides: Partial<PersistedPuzzleSessionV1> = {}
): PersistedPuzzleSessionV1 {
	return {
		...variantSnapshot(variantId, 16),
		...overrides
	};
}

function fullBoard16Placements() {
	return Array.from({ length: 16 }, (_, pieceId) => ({
		pieceId,
		x: pieceId % 4,
		y: Math.floor(pieceId / 4)
	}));
}

function quickPuzzle(): StoredQuickPuzzle {
	return {
		id: 'q-test',
		name: 'Quick Test',
		aspectRatio: '1:1',
		pieceCount: 4,
		gridRows: 2,
		gridCols: 2,
		imageWidth: 100,
		imageHeight: 100,
		imageDataUrl: 'data:image/jpeg;base64,',
		pieces: [
			{
				id: 0,
				correctX: 0,
				correctY: 0,
				edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' }
			},
			{
				id: 1,
				correctX: 1,
				correctY: 0,
				edges: { top: 'flat', right: 'flat', bottom: 'tab', left: 'blank' }
			},
			{
				id: 2,
				correctX: 0,
				correctY: 1,
				edges: { top: 'tab', right: 'blank', bottom: 'flat', left: 'flat' }
			},
			{
				id: 3,
				correctX: 1,
				correctY: 1,
				edges: { top: 'blank', right: 'flat', bottom: 'flat', left: 'tab' }
			}
		],
		createdAt: 1_000,
		schemaVersion: 1
	};
}

function fetchedServerPuzzle(id: string, name: string): Puzzle {
	return {
		id,
		name,
		pieceCount: 16,
		gridCols: 4,
		gridRows: 4,
		imageWidth: 200,
		imageHeight: 200,
		createdAt: 1_000,
		pieces: expectedSquare16.map((piece) => ({
			...piece,
			puzzleId: id,
			imagePath: `pieces/${piece.id}.png`,
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' }
		}))
	};
}

function spyAdapter(): {
	adapter: SessionStorageAdapter;
	contexts: SessionValidationContext[];
} {
	const contexts: SessionValidationContext[] = [];
	const adapter: SessionStorageAdapter = {
		peekSession: (_puzzleId: string, context: SessionValidationContext): SessionLoadResult => {
			contexts.push(context);
			return { status: 'missing' };
		},
		loadSession: () => ({ status: 'missing' }),
		saveSession: () => {},
		clearSession: () => true,
		isResumable: () => false
	};
	return { adapter, contexts };
}

describe('discoverGalleryProgress', () => {
	it('derives canonical server geometry for representative aspect ratios', () => {
		const { adapter, contexts } = spyAdapter();
		const corrupt = {
			id: 'bad-fam',
			name: 'Bad',
			aspectRatio: '16:9',
			status: 'ready',
			createdAt: 1000,
			variants: {}
		} as unknown as PuzzleFamilySummary;

		discoverGalleryProgress({
			serverFamilies: [
				serverFamily('square', '1:1'),
				serverFamily('landscape', '4:3'),
				serverFamily('portrait', '3:4'),
				corrupt
			],
			quickPuzzles: [],
			sessionStorage: adapter
		});

		const easyContexts = contexts.filter((captured) =>
			['square', 'landscape', 'portrait'].includes(captured.puzzleId)
		);
		expect(easyContexts.map((captured) => captured.pieces)).toEqual([
			expectedSquare16,
			expectedLandscape12,
			expectedPortrait12
		]);
		// The corrupt family contributes no contexts: neither its own id nor
		// any identifier derived from it may appear.
		expect(contexts.some((captured) => captured.puzzleId.startsWith('bad-fam'))).toBe(false);
	});

	it('selects the greatest lastUpdated resumable current candidate', () => {
		const serverSnapshot = variantSnapshot('pz1', 16);
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...validSnapshot(),
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 2_000
		};
		const serverRaw = JSON.stringify({ ...serverSnapshot, lastUpdated: 1_000 });
		const store = {
			'puzzle-progress-v2-pz1': serverRaw,
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
		};
		const discovery = discoverGalleryProgress({
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [quickPuzzle()],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.newest?.puzzleId).toBe('q-test');
	});

	it('returns placed counts for matching ready server cards', () => {
		const snapshot = variantSnapshot('pz1', 16);
		const store = { 'puzzle-progress-v2-pz1': JSON.stringify(snapshot) };
		const discovery = discoverGalleryProgress({
			serverFamilies: [serverFamily('pz1', '1:1', { name: 'Server Puzzle' })],
			quickPuzzles: [],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byVariantId.get('pz1')?.placedCount).toBe(2);
		expect(discovery.byVariantId.get('pz1')).toMatchObject({
			puzzleId: 'pz1',
			name: 'Server Puzzle',
			source: 'api',
			pieceCount: 16,
			lastUpdated: 1_000
		});
	});

	it('ignores completed snapshots without deleting them', () => {
		const snapshot = {
			...variantSnapshot('pz1', 16),
			lifecycle: 'completed' as const,
			placedPieces: fullBoard16Placements(),
			sealedCompletion: seal()
		};
		const raw = JSON.stringify(snapshot);
		const store = { 'puzzle-progress-v2-pz1': raw };
		const discovery = discoverGalleryProgress({
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byVariantId.has('pz1')).toBe(false);
		expect(discovery.newest).toBeNull();
		expect(store['puzzle-progress-v2-pz1']).toBe(raw);
	});

	it('ignores invalid snapshots without deleting them', () => {
		const snapshot = variantSnapshot('pz1', 16);
		const raw = JSON.stringify({ ...snapshot, schemaVersion: 999 });
		const store = { 'puzzle-progress-v2-pz1': raw };
		const discovery = discoverGalleryProgress({
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byVariantId.has('pz1')).toBe(false);
		expect(discovery.newest).toBeNull();
		expect(store['puzzle-progress-v2-pz1']).toBe(raw);
	});

	it('skips malformed current-schema Quick records without aborting valid candidates', () => {
		const serverSnapshot = variantSnapshot('pz1', 16);
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...validSnapshot(),
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 2_000
		};
		const malformedQuick = {
			...quickPuzzle(),
			id: 'q-malformed',
			pieces: undefined
		} as unknown as StoredQuickPuzzle;
		const store = {
			'puzzle-progress-v2-pz1': JSON.stringify(serverSnapshot),
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
		};

		const discovery = discoverGalleryProgress({
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [malformedQuick, quickPuzzle()],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byVariantId.get('pz1')?.placedCount).toBe(2);
		expect(discovery.newest?.puzzleId).toBe('q-test');
	});

	it('rejects Quick records whose grid capacity does not match pieceCount', () => {
		// 4 pieces projected onto a 3x3 grid (capacity 9): coordinates are
		// individually in-bounds and unique, but the grid is non-canonical.
		// Production records always satisfy gridCols * gridRows === pieceCount
		// (see getGridDimensionsForAspectRatio), so a mismatch signals corrupt
		// local state and must not surface as resumable progress.
		const mismatchedQuick: StoredQuickPuzzle = {
			...quickPuzzle(),
			id: 'q-mismatch',
			gridRows: 3,
			gridCols: 3,
			pieces: [
				{
					id: 0,
					correctX: 0,
					correctY: 0,
					edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' }
				},
				{
					id: 1,
					correctX: 1,
					correctY: 0,
					edges: { top: 'flat', right: 'flat', bottom: 'tab', left: 'blank' }
				},
				{
					id: 2,
					correctX: 0,
					correctY: 1,
					edges: { top: 'tab', right: 'blank', bottom: 'flat', left: 'flat' }
				},
				{
					id: 3,
					correctX: 1,
					correctY: 1,
					edges: { top: 'blank', right: 'flat', bottom: 'flat', left: 'tab' }
				}
			]
		};
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...validSnapshot(),
			puzzleId: 'q-mismatch',
			source: 'local',
			lastUpdated: 5_000
		};
		const store = {
			'puzzle-progress-q-mismatch': JSON.stringify(quickSnapshot)
		};

		const discovery = discoverGalleryProgress({
			serverFamilies: [],
			quickPuzzles: [mismatchedQuick],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.newest).toBeNull();
		expect(discovery.byVariantId.has('q-mismatch')).toBe(false);
	});

	it('rejects Quick records whose id lacks the QUICK_PUZZLE_ID_PREFIX', () => {
		// loadPuzzleSource routes only q- IDs to the local source; a non-q- id
		// would fall through to the API path and 404. Gallery validation must
		// enforce the same invariant so a malformed persisted Quick record can
		// never surface a Continue link that cannot resume.
		const nonQuickIdQuick: StoredQuickPuzzle = {
			...quickPuzzle(),
			id: 'server-looking-id'
		};
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...validSnapshot(),
			puzzleId: 'server-looking-id',
			source: 'local',
			lastUpdated: 5_000
		};
		const store = {
			'puzzle-progress-v2-server-looking-id': JSON.stringify(quickSnapshot)
		};

		const discovery = discoverGalleryProgress({
			serverFamilies: [],
			quickPuzzles: [nonQuickIdQuick],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.newest).toBeNull();
		expect(discovery.byVariantId.has('server-looking-id')).toBe(false);
	});

	it('skips server puzzles that are not ready', () => {
		const { adapter, contexts } = spyAdapter();
		discoverGalleryProgress({
			serverFamilies: [
				serverFamily('processing', '1:1', { status: 'processing' }),
				serverFamily('failed', '1:1', { status: 'failed' })
			],
			quickPuzzles: [],
			sessionStorage: adapter
		});

		expect(contexts).toHaveLength(0);
	});

	it('skips server families with a variant whose piece count does not match difficulty', () => {
		const { adapter, contexts } = spyAdapter();
		const badFamily = serverFamily('bad-count', '1:1');
		badFamily.variants.easy = { ...badFamily.variants.easy, pieceCount: 5 };
		discoverGalleryProgress({
			serverFamilies: [badFamily],
			quickPuzzles: [],
			sessionStorage: adapter
		});

		expect(contexts.some((captured) => captured.puzzleId === 'bad-count')).toBe(false);
		expect(contexts.length).toBe(2);
	});

	it('skips null or non-object Quick records', () => {
		const { adapter, contexts } = spyAdapter();
		discoverGalleryProgress({
			serverFamilies: [],
			quickPuzzles: [null as unknown as StoredQuickPuzzle, 42 as unknown as StoredQuickPuzzle],
			sessionStorage: adapter
		});

		expect(contexts).toHaveLength(0);
	});

	it('skips Quick records with a non-object piece entry', () => {
		const { adapter, contexts } = spyAdapter();
		const withNullPiece: StoredQuickPuzzle = {
			...quickPuzzle(),
			pieces: [null as unknown as StoredQuickPuzzle['pieces'][0], ...quickPuzzle().pieces.slice(1)]
		};
		discoverGalleryProgress({
			serverFamilies: [],
			quickPuzzles: [withNullPiece],
			sessionStorage: adapter
		});

		expect(contexts).toHaveLength(0);
	});

	it('skips Quick records with a duplicate piece id', () => {
		const { adapter, contexts } = spyAdapter();
		const base = quickPuzzle();
		const withDupId: StoredQuickPuzzle = {
			...base,
			pieces: [
				{ ...base.pieces[0] },
				{ ...base.pieces[0], correctX: base.pieces[1].correctX, correctY: base.pieces[1].correctY },
				...base.pieces.slice(2)
			]
		};
		discoverGalleryProgress({
			serverFamilies: [],
			quickPuzzles: [withDupId],
			sessionStorage: adapter
		});

		expect(contexts).toHaveLength(0);
	});

	it('skips Quick records with two pieces occupying the same cell', () => {
		const { adapter, contexts } = spyAdapter();
		const base = quickPuzzle();
		const withDupCell: StoredQuickPuzzle = {
			...base,
			pieces: [
				{ ...base.pieces[0] },
				{ ...base.pieces[1], correctX: base.pieces[0].correctX, correctY: base.pieces[0].correctY },
				...base.pieces.slice(2)
			]
		};
		discoverGalleryProgress({
			serverFamilies: [],
			quickPuzzles: [withDupCell],
			sessionStorage: adapter
		});

		expect(contexts).toHaveLength(0);
	});

	it('uses the default session storage adapter when none is provided', () => {
		// Exercises the `?? createSessionStorageAdapter()` fallback. With an
		// empty browser storage every peekSession returns 'missing', so no
		// progress is discovered — but the fallback branch itself is exercised.
		const discovery = discoverGalleryProgress({
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [quickPuzzle()]
		});

		expect(discovery.newest).toBeNull();
		expect(discovery.byVariantId.size).toBe(0);
	});

	it('rejects Quick records whose explicit geometry is individually invalid', () => {
		// Each malformed Quick record targets a distinct guard inside
		// explicitValidationContext (pieceCount, gridCols, gridRows, piece id
		// range, correctY range) so every defensive return null is exercised.
		const { adapter, contexts } = spyAdapter();
		const base = quickPuzzle();
		const zeroPieceCount = { ...base, id: 'q-zero-pc', pieceCount: 0 } as StoredQuickPuzzle;
		const zeroGridCols = { ...base, id: 'q-zero-cols', gridCols: 0 } as StoredQuickPuzzle;
		const zeroGridRows = { ...base, id: 'q-zero-rows', gridRows: 0 } as StoredQuickPuzzle;
		const idOutOfRange: StoredQuickPuzzle = {
			...base,
			id: 'q-id-oob',
			pieces: [{ ...base.pieces[0]!, id: 99 }, ...base.pieces.slice(1)]
		};
		const correctYOutOfRange: StoredQuickPuzzle = {
			...base,
			id: 'q-y-oob',
			pieces: [{ ...base.pieces[0]!, correctY: 99 }, ...base.pieces.slice(1)]
		};

		discoverGalleryProgress({
			serverFamilies: [],
			quickPuzzles: [zeroPieceCount, zeroGridCols, zeroGridRows, idOutOfRange, correctYOutOfRange],
			sessionStorage: adapter
		});

		// Every malformed record is rejected before producing a candidate.
		expect(contexts).toHaveLength(0);
	});

	it('keeps the newest progress when a later candidate is older', () => {
		const serverSnapshot = variantSnapshot('pz1', 16);
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...serverSnapshot,
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 500
		};
		const store = {
			'puzzle-progress-v2-pz1': JSON.stringify({ ...serverSnapshot, lastUpdated: 1_000 }),
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
		};

		const discovery = discoverGalleryProgress({
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [quickPuzzle()],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		// Server (1000) is newer than Quick (500) → newest stays server.
		expect(discovery.newest?.puzzleId).toBe('pz1');
		expect(discovery.newest?.lastUpdated).toBe(1_000);
	});
});

describe('discoverAllSavedProgress', () => {
	it('includes loaded, fetched, and Quick saves newest first', async () => {
		const quickBase = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-v2-loaded': JSON.stringify(
				apiProgressSnapshot('loaded', { lastUpdated: 1_000 })
			),
			'puzzle-progress-v2-old': JSON.stringify(apiProgressSnapshot('old', { lastUpdated: 3_000 })),
			'puzzle-progress-q-test': JSON.stringify({
				...quickBase,
				puzzleId: 'q-test',
				source: 'local',
				lastUpdated: 2_000
			})
		});
		const fetchPuzzleById = vi.fn(async (id: string) => fetchedServerPuzzle(id, 'Fetched Save'));

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['loaded', 'old', 'q-test'],
			serverFamilies: [serverFamily('loaded', '1:1', { name: 'Loaded Save' })],
			quickPuzzles: [quickPuzzle()],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows.map((row) => row.puzzleId)).toEqual(['old', 'q-test', 'loaded']);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(1);
		expect(fetchPuzzleById).toHaveBeenCalledWith('old', undefined);
	});

	it('skips detail fetches when summary metadata is already loaded', async () => {
		const store = memoryStorage({
			'puzzle-progress-v2-a': JSON.stringify(apiProgressSnapshot('a', { lastUpdated: 1_000 })),
			'puzzle-progress-v2-b': JSON.stringify(apiProgressSnapshot('b', { lastUpdated: 2_000 }))
		});
		const fetchPuzzleById = vi.fn();

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['a', 'b'],
			serverFamilies: [serverFamily('a', '1:1'), serverFamily('b', '1:1')],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(fetchPuzzleById).not.toHaveBeenCalled();
		expect(rows.map((row) => row.puzzleId)).toEqual(['b', 'a']);
	});

	it('omits saves whose detail fetch fails without aborting the others', async () => {
		const store = memoryStorage({
			'puzzle-progress-v2-gone': JSON.stringify(
				apiProgressSnapshot('gone', { lastUpdated: 5_000 })
			),
			'puzzle-progress-v2-kept': JSON.stringify(apiProgressSnapshot('kept', { lastUpdated: 1_000 }))
		});
		const fetchPuzzleById = vi.fn(async (id: string) => {
			if (id === 'gone') throw new Error('not found');
			return fetchedServerPuzzle(id, 'Fetched Save');
		});

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['gone', 'kept'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows.map((row) => row.puzzleId)).toEqual(['kept']);
		// A transient fetch failure marks discovery incomplete so the caller
		// does not clear saved-progress candidate ids on a partial result.
		expect(complete).toBe(false);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(2);
	});

	it('marks discovery incomplete when every off-page detail fetch fails transiently', async () => {
		// Regression: if all candidates are off-page and their detail requests
		// fail transiently (network blip, 5xx), the result must be empty rows
		// BUT complete=false so the caller does not clear savedProgressCandidateIds
		// and hide the VIEW SAVED PROGRESS affordance while local saves persist.
		const store = memoryStorage({
			'puzzle-progress-v2-off-a': JSON.stringify(
				apiProgressSnapshot('off-a', { lastUpdated: 5_000 })
			),
			'puzzle-progress-v2-off-b': JSON.stringify(
				apiProgressSnapshot('off-b', { lastUpdated: 3_000 })
			)
		});
		const fetchPuzzleById = vi.fn(async () => {
			throw new Error('network down');
		});

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['off-a', 'off-b'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows).toEqual([]);
		expect(complete).toBe(false);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(2);
	});

	it('preserves persisted sessions and stays incomplete when detail returns 404', async () => {
		// Regression: the public detail endpoint reads metadata from KV and
		// returns the same 404 for a missing record, a non-ready record, and a
		// stale eventually-consistent read where the metadata DO has already
		// committed `ready` (the reaper uses a separate strongly consistent DO
		// lookup for exactly this). Clearing the session on 404 would
		// irreversibly delete a valid local save over a stale KV read, so the
		// session must survive and discovery must be incomplete (retryable).
		const records: Record<string, string> = {
			'puzzle-progress-v2-deleted-a': JSON.stringify(
				apiProgressSnapshot('deleted-a', { lastUpdated: 5_000 })
			),
			'puzzle-progress-v2-deleted-b': JSON.stringify(
				apiProgressSnapshot('deleted-b', { lastUpdated: 3_000 })
			)
		};
		const fetchPuzzleById = vi.fn(async () => {
			throw Object.assign(new Error('Puzzle not found'), { status: 404, name: 'ApiError' });
		});

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['deleted-a', 'deleted-b'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(records) })
		});

		expect(rows).toEqual([]);
		expect(complete).toBe(false);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(2);
		// Both persisted sessions survive the 404s for retry.
		expect(records['puzzle-progress-v2-deleted-a']).toBeDefined();
		expect(records['puzzle-progress-v2-deleted-b']).toBeDefined();
	});

	it('treats 400 detail failures as authoritative for malformed candidate ids', async () => {
		// Invalid puzzle ID format yields 400 from the detail endpoint — also
		// permanent, so discovery stays complete and the stale candidate is
		// cleared rather than retried on every load.
		const store = memoryStorage({
			'puzzle-progress-v2-bad-id': JSON.stringify(
				apiProgressSnapshot('bad-id', { lastUpdated: 1_000 })
			)
		});
		const fetchPuzzleById = vi.fn(async () => {
			throw Object.assign(new Error('Invalid puzzle ID format'), {
				status: 400,
				name: 'ApiError'
			});
		});

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['bad-id'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows).toEqual([]);
		expect(complete).toBe(true);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(1);
	});

	it('treats 5xx detail failures as transient even alongside a 404', async () => {
		// A mix of 404 and 500 failures keeps discovery incomplete — 404 is
		// not authoritative (stale KV reads), and the 500 could recover on
		// retry, so the caller must not clear candidates.
		const store = memoryStorage({
			'puzzle-progress-v2-gone': JSON.stringify(
				apiProgressSnapshot('gone', { lastUpdated: 5_000 })
			),
			'puzzle-progress-v2-flaky': JSON.stringify(
				apiProgressSnapshot('flaky', { lastUpdated: 3_000 })
			)
		});
		const fetchPuzzleById = vi.fn(async (id: string) => {
			if (id === 'gone')
				throw Object.assign(new Error('Puzzle not found'), { status: 404, name: 'ApiError' });
			throw Object.assign(new Error('Failed to retrieve puzzle'), {
				status: 500,
				name: 'ApiError'
			});
		});

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['gone', 'flaky'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows).toEqual([]);
		expect(complete).toBe(false);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(2);
	});

	it('preserves 404 sessions while surfacing valid candidates', async () => {
		// Mixed discovery: one candidate fetches successfully and surfaces as a
		// row, another 404s. The 404 is NOT authoritative (the detail endpoint
		// serves missing and non-ready KV records — including stale reads —
		// as the same 404), so the persisted session must be kept for retry
		// and discovery marked incomplete so the caller does not clear
		// candidate ids.
		const records: Record<string, string> = {
			'puzzle-progress-v2-valid': JSON.stringify(
				apiProgressSnapshot('valid', { lastUpdated: 2_000 })
			),
			'puzzle-progress-v2-gone': JSON.stringify(apiProgressSnapshot('gone', { lastUpdated: 5_000 }))
		};
		const fetchPuzzleById = vi.fn(async (id: string) => {
			if (id === 'gone')
				throw Object.assign(new Error('Puzzle not found'), { status: 404, name: 'ApiError' });
			return fetchedServerPuzzle(id, 'Valid Save');
		});

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['valid', 'gone'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(records) })
		});

		// The valid candidate surfaces; the 404 candidate is omitted but kept.
		expect(rows.map((row) => row.puzzleId)).toEqual(['valid']);
		expect(complete).toBe(false);
		// Both persisted sessions survive (the 404 is not authoritative).
		expect(records['puzzle-progress-v2-gone']).toBeDefined();
		expect(records['puzzle-progress-v2-valid']).toBeDefined();
	});

	it('does not purge persisted sessions on transient (5xx) failures', async () => {
		// A transient failure must not purge the session — the puzzle may
		// recover on retry, and deleting the save would lose real progress.
		const store: Record<string, string> = {
			'puzzle-progress-v2-flaky': JSON.stringify(
				apiProgressSnapshot('flaky', { lastUpdated: 5_000 })
			)
		};
		const fetchPuzzleById = vi.fn(async () => {
			throw Object.assign(new Error('Failed to retrieve puzzle'), {
				status: 500,
				name: 'ApiError'
			});
		});

		await discoverAllSavedProgress({
			puzzleIds: ['flaky'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		// The session survives a transient failure for retry.
		expect(store['puzzle-progress-v2-flaky']).toBeDefined();
	});

	it('omits Quick candidates without loaded Quick metadata instead of fetching', async () => {
		const quickBase = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-q-orphan': JSON.stringify({
				...quickBase,
				puzzleId: 'q-orphan',
				source: 'local',
				lastUpdated: 4_000
			})
		});
		const fetchPuzzleById = vi.fn();

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['q-orphan'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows).toEqual([]);
		expect(fetchPuzzleById).not.toHaveBeenCalled();
	});

	it('preserves completed fetched saves instead of surfacing them', async () => {
		const snapshot = {
			...apiProgressSnapshot('done'),
			lifecycle: 'completed' as const,
			placedPieces: fullBoard16Placements(),
			sealedCompletion: seal()
		};
		const raw = JSON.stringify(snapshot);
		const store = { 'puzzle-progress-v2-done': raw };
		const fetchPuzzleById = vi.fn(async () => fetchedServerPuzzle('done', 'Done Save'));

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['done'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(rows).toEqual([]);
		expect(store['puzzle-progress-v2-done']).toBe(raw);
	});

	it('rejects fetched details with duplicate or out-of-bounds pieces', async () => {
		const dupIdPuzzle = fetchedServerPuzzle('dup', 'Dup Save');
		dupIdPuzzle.pieces = [
			dupIdPuzzle.pieces[0],
			{ ...dupIdPuzzle.pieces[1], id: dupIdPuzzle.pieces[0].id },
			...dupIdPuzzle.pieces.slice(2)
		];
		const outOfBoundsPuzzle = fetchedServerPuzzle('oob', 'Out Of Bounds Save');
		outOfBoundsPuzzle.pieces[0] = { ...outOfBoundsPuzzle.pieces[0], correctX: 9 };

		const store = memoryStorage({
			'puzzle-progress-v2-dup': JSON.stringify(apiProgressSnapshot('dup', { lastUpdated: 5_000 })),
			'puzzle-progress-v2-oob': JSON.stringify(apiProgressSnapshot('oob', { lastUpdated: 4_000 }))
		});
		const fetchPuzzleById = vi.fn(async (id: string) =>
			id === 'dup' ? dupIdPuzzle : outOfBoundsPuzzle
		);

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['dup', 'oob'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows).toEqual([]);
	});

	it('orders same-timestamp saves deterministically by puzzle id', async () => {
		const quickBase = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-v2-b': JSON.stringify(apiProgressSnapshot('b', { lastUpdated: 2_000 })),
			'puzzle-progress-v2-a': JSON.stringify(apiProgressSnapshot('a', { lastUpdated: 2_000 })),
			'puzzle-progress-q-test': JSON.stringify({
				...quickBase,
				puzzleId: 'q-test',
				source: 'local',
				lastUpdated: 2_000
			})
		});

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['b', 'a', 'q-test'],
			serverFamilies: [serverFamily('a', '1:1'), serverFamily('b', '1:1')],
			quickPuzzles: [quickPuzzle()],
			fetchPuzzleById: async (id: string) => fetchedServerPuzzle(id, 'Fetched Save'),
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(rows.map((row) => row.puzzleId)).toEqual(['a', 'b', 'q-test']);
	});

	it('forwards the abort signal to each detail fetch', async () => {
		const store = memoryStorage({
			'puzzle-progress-v2-fetched': JSON.stringify(
				apiProgressSnapshot('fetched', { lastUpdated: 1_000 })
			)
		});
		const controller = new AbortController();
		const fetchPuzzleById = vi.fn(async (_id: string, signal?: AbortSignal) => {
			expect(signal).toBe(controller.signal);
			return fetchedServerPuzzle('fetched', 'Fetched Save');
		});

		await discoverAllSavedProgress({
			puzzleIds: ['fetched'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store }),
			signal: controller.signal
		});

		expect(fetchPuzzleById).toHaveBeenCalledWith('fetched', controller.signal);
	});

	it('stops and returns empty when the abort signal is already aborted', async () => {
		const store = memoryStorage({
			'puzzle-progress-v2-fetched': JSON.stringify(
				apiProgressSnapshot('fetched', { lastUpdated: 1_000 })
			)
		});
		const controller = new AbortController();
		controller.abort();
		const fetchPuzzleById = vi.fn();

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['fetched'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store }),
			signal: controller.signal
		});

		// An already-aborted signal short-circuits before any detail fetch.
		expect(rows).toEqual([]);
		expect(fetchPuzzleById).not.toHaveBeenCalled();
	});

	it('drops a candidate whose detail fetch resolves after the signal aborts', async () => {
		// The post-fetch `signal?.aborted` guard must drop a candidate when the
		// signal aborts while the fetch is in flight but the fetch still resolves
		// (e.g. a stale request the caller abandoned by opening a newer one).
		const store = memoryStorage({
			'puzzle-progress-v2-fetched': JSON.stringify(
				apiProgressSnapshot('fetched', { lastUpdated: 1_000 })
			)
		});
		const controller = new AbortController();
		const fetchPuzzleById = vi.fn(async (_id: string, signal?: AbortSignal) => {
			// Abort mid-flight, then still resolve: the resolved value must be
			// discarded by the post-await abort check.
			controller.abort();
			expect(signal).toBe(controller.signal);
			return fetchedServerPuzzle('fetched', 'Fetched Save');
		});

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['fetched'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store }),
			signal: controller.signal
		});

		expect(rows).toEqual([]);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(1);
	});

	it('uses the default session storage adapter when none is provided', async () => {
		// Exercises the `?? createSessionStorageAdapter()` fallback in
		// discoverAllSavedProgress. With empty browser storage every
		// peekSession returns 'missing', so no rows surface — but the
		// fallback branch itself is exercised.
		const fetchPuzzleById = vi.fn(async (id: string) => fetchedServerPuzzle(id, 'Fetched Save'));

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['fetched'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById
		});

		expect(rows).toEqual([]);
	});

	it('omits fetched saves whose id is empty or mismatches the requested id', async () => {
		// `puzzle.id !== puzzleId` guard (mismatch) and the empty-puzzleId guard
		// inside explicitValidationContext (reached only when the fetched id
		// matches the requested empty id).
		const fetchPuzzleById = vi.fn(async (id: string) => {
			if (id === '') return fetchedServerPuzzle('', 'Empty Id');
			return fetchedServerPuzzle('different', 'Mismatched Id');
		});

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['', 'mismatch'],
			serverFamilies: [],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage({}) })
		});

		expect(rows).toEqual([]);
		expect(fetchPuzzleById).toHaveBeenCalledWith('', undefined);
		expect(fetchPuzzleById).toHaveBeenCalledWith('mismatch', undefined);
	});

	it('omits candidates whose loaded summary metadata fails validation', async () => {
		// A server summary with an invalid piece count for its aspect ratio
		// (5 is not a perfect square for 1:1) yields a null context via
		// serverValidationContext, exercising the summary `: null` branch.
		// A Quick record whose grid capacity does not match its pieceCount
		// yields a null context via quickValidationContext, exercising the
		// Quick `: null` branch.
		const quickBase = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-v2-bad-summary': JSON.stringify(
				apiProgressSnapshot('bad-summary', { lastUpdated: 1_000 })
			),
			'puzzle-progress-q-bad-quick': JSON.stringify({
				...quickBase,
				puzzleId: 'q-bad-quick',
				source: 'local',
				lastUpdated: 2_000
			})
		});
		const mismatchedQuick: StoredQuickPuzzle = {
			...quickPuzzle(),
			id: 'q-bad-quick',
			gridRows: 3,
			gridCols: 3
		};
		const fetchPuzzleById = vi.fn();

		const { rows } = await discoverAllSavedProgress({
			puzzleIds: ['bad-summary', 'q-bad-quick'],
			serverFamilies: [
				(() => {
					const bad = serverFamily('bad-summary', '1:1');
					bad.variants.easy = { ...bad.variants.easy, pieceCount: 5 };
					return bad;
				})()
			],
			quickPuzzles: [mismatchedQuick],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		// Neither invalid-summary candidate surfaces a row, and no detail
		// fetch is needed because both ids resolve via loaded metadata.
		expect(rows).toEqual([]);
		expect(fetchPuzzleById).not.toHaveBeenCalled();
	});

	it('purges shallow-passing saves that fail deep peekSession validation', async () => {
		// Regression: listResumableSessionCandidateIds is intentionally a
		// shallow probe (schema version, puzzle-id match, lifecycle
		// active/paused, unsealed, hasUserActivity). It does NOT validate
		// tray order, rotations, counters, result-class, or geometry. A
		// current-schema active save can therefore pass the shallow probe
		// while failing full peekSession() validation via validateV1.
		//
		// discoverAllSavedProgress must return { rows: [], complete: true }
		// for such a save — the failure is not a transient fetch error, so
		// discovery is complete. The structurally invalid session is purged
		// from storage (local validation is authoritative, like the 400
		// malformed-id case) so it does not re-surface on every
		// shallow mount probe via listResumableSessionCandidateIds after
		// reload. Valid-but-non-resumable snapshots (e.g. completed
		// sessions) are NOT purged — only structurally invalid records.
		const snapshot = {
			...validSnapshot(),
			puzzleId: 'pz1',
			// Corrupt tray order: wrong length (2 instead of 4). The shallow
			// probe never inspects trayOrder, but validateTrayOrder rejects
			// a length mismatch against knownPieceIds.size.
			trayOrder: [0, 1]
		};
		const store = memoryStorage({
			'puzzle-progress-v2-pz1': JSON.stringify(snapshot)
		});

		// The shallow probe passes: current schema, matching puzzle id,
		// active lifecycle, unsealed, hasUserActivity true.
		expect(listResumableSessionCandidateIds(store)).toEqual(['pz1']);

		const fetchPuzzleById = vi.fn();

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['pz1'],
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		// Deep validation fails — no row surfaces, but discovery is
		// complete (no transient fetch failure occurred).
		expect(rows).toEqual([]);
		expect(complete).toBe(true);
		expect(fetchPuzzleById).not.toHaveBeenCalled();
		// The structurally invalid session is purged from storage, so a
		// shallow re-probe no longer lists it. This prevents the dead
		// VIEW SAVED PROGRESS affordance from reappearing after reload.
		expect(store.getItem('puzzle-progress-v2-pz1')).toBeNull();
		expect(listResumableSessionCandidateIds(store)).toEqual([]);
	});

	it('keeps valid-but-non-resumable (completed) sessions through deep validation', async () => {
		const snapshot = {
			...variantSnapshot('pz1', 16),
			lifecycle: 'completed' as const,
			placedPieces: fullBoard16Placements(),
			sealedCompletion: seal()
		};
		const store = memoryStorage({
			'puzzle-progress-v2-pz1': JSON.stringify(snapshot)
		});

		const fetchPuzzleById = vi.fn();

		const { rows, complete } = await discoverAllSavedProgress({
			puzzleIds: ['pz1'],
			serverFamilies: [serverFamily('pz1', '1:1')],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		// No row surfaces (completed sessions are not resumable), but
		// discovery is complete and the session survives in storage.
		expect(rows).toEqual([]);
		expect(complete).toBe(true);
		expect(store.getItem('puzzle-progress-v2-pz1')).not.toBeNull();
	});
});
