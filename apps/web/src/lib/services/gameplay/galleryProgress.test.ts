import { describe, expect, it } from 'vitest';
import type { PuzzleSummary } from '$lib/types/puzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
import { createSessionStorageAdapter } from './session/persistence';
import {
	fullBoardPlacements,
	memoryStorage,
	seal,
	validSnapshot
} from './session/persistence.test-fixtures';
import type {
	PersistedPuzzleSessionV1,
	SessionLoadResult,
	SessionStorageAdapter,
	SessionValidationContext
} from './session/types';
import { discoverGalleryProgress } from './galleryProgress';

const expectedSquare4 = [
	{ id: 0, correctX: 0, correctY: 0 },
	{ id: 1, correctX: 1, correctY: 0 },
	{ id: 2, correctX: 0, correctY: 1 },
	{ id: 3, correctX: 1, correctY: 1 }
];

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

function serverPuzzle(
	id: string,
	pieceCount: number,
	aspectRatio: string,
	overrides: Partial<PuzzleSummary> = {}
): PuzzleSummary {
	return {
		id,
		name: id,
		pieceCount,
		status: 'ready',
		aspectRatio: aspectRatio as PuzzleSummary['aspectRatio'],
		...overrides
	};
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
		clearSession: () => {},
		isResumable: () => false
	};
	return { adapter, contexts };
}

describe('discoverGalleryProgress', () => {
	it('derives canonical server geometry for representative aspect ratios', () => {
		const { adapter, contexts } = spyAdapter();
		const corrupt = {
			id: 'bad',
			name: 'Bad',
			pieceCount: 4,
			status: 'ready',
			aspectRatio: '16:9'
		} as unknown as PuzzleSummary;

		discoverGalleryProgress({
			serverPuzzles: [
				serverPuzzle('square', 4, '1:1'),
				serverPuzzle('landscape', 12, '4:3'),
				serverPuzzle('portrait', 12, '3:4'),
				corrupt
			],
			quickPuzzles: [],
			sessionStorage: adapter
		});

		expect(contexts.map((captured) => captured.pieces)).toEqual([
			expectedSquare4,
			expectedLandscape12,
			expectedPortrait12
		]);
		expect(contexts.some((captured) => captured.puzzleId === 'bad')).toBe(false);
	});

	it('selects the greatest lastUpdated resumable current candidate', () => {
		const serverSnapshot = validSnapshot();
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...serverSnapshot,
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 2_000
		};
		const serverRaw = JSON.stringify({ ...serverSnapshot, lastUpdated: 1_000 });
		const store = {
			'puzzle-progress-pz1': serverRaw,
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
		};
		const discovery = discoverGalleryProgress({
			serverPuzzles: [serverPuzzle('pz1', 4, '1:1')],
			quickPuzzles: [quickPuzzle()],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.newest?.puzzleId).toBe('q-test');
	});

	it('returns placed counts for matching ready server cards', () => {
		const snapshot = validSnapshot();
		const store = { 'puzzle-progress-pz1': JSON.stringify(snapshot) };
		const discovery = discoverGalleryProgress({
			serverPuzzles: [serverPuzzle('pz1', 4, '1:1', { name: 'Server Puzzle' })],
			quickPuzzles: [],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byPuzzleId.get('pz1')?.placedCount).toBe(2);
		expect(discovery.byPuzzleId.get('pz1')).toMatchObject({
			puzzleId: 'pz1',
			name: 'Server Puzzle',
			source: 'api',
			pieceCount: 4,
			lastUpdated: 1_000
		});
	});

	it('ignores completed snapshots without deleting them', () => {
		const snapshot = {
			...validSnapshot(),
			lifecycle: 'completed' as const,
			placedPieces: fullBoardPlacements(),
			sealedCompletion: seal()
		};
		const raw = JSON.stringify(snapshot);
		const store = { 'puzzle-progress-pz1': raw };
		const discovery = discoverGalleryProgress({
			serverPuzzles: [serverPuzzle('pz1', 4, '1:1')],
			quickPuzzles: [],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byPuzzleId.has('pz1')).toBe(false);
		expect(discovery.newest).toBeNull();
		expect(store['puzzle-progress-pz1']).toBe(raw);
	});

	it('ignores invalid snapshots without deleting them', () => {
		const snapshot = validSnapshot();
		const raw = JSON.stringify({ ...snapshot, schemaVersion: 999 });
		const store = { 'puzzle-progress-pz1': raw };
		const discovery = discoverGalleryProgress({
			serverPuzzles: [serverPuzzle('pz1', 4, '1:1')],
			quickPuzzles: [],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byPuzzleId.has('pz1')).toBe(false);
		expect(discovery.newest).toBeNull();
		expect(store['puzzle-progress-pz1']).toBe(raw);
	});

	it('skips malformed current-schema Quick records without aborting valid candidates', () => {
		const serverSnapshot = validSnapshot();
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...serverSnapshot,
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
			'puzzle-progress-pz1': JSON.stringify(serverSnapshot),
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
		};

		const discovery = discoverGalleryProgress({
			serverPuzzles: [serverPuzzle('pz1', 4, '1:1')],
			quickPuzzles: [malformedQuick, quickPuzzle()],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.byPuzzleId.get('pz1')?.placedCount).toBe(2);
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
			serverPuzzles: [],
			quickPuzzles: [mismatchedQuick],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.newest).toBeNull();
		expect(discovery.byPuzzleId.has('q-mismatch')).toBe(false);
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
			'puzzle-progress-server-looking-id': JSON.stringify(quickSnapshot)
		};

		const discovery = discoverGalleryProgress({
			serverPuzzles: [],
			quickPuzzles: [nonQuickIdQuick],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		expect(discovery.newest).toBeNull();
		expect(discovery.byPuzzleId.has('server-looking-id')).toBe(false);
	});

	it('skips server puzzles that are not ready', () => {
		const { adapter, contexts } = spyAdapter();
		discoverGalleryProgress({
			serverPuzzles: [
				serverPuzzle('processing', 4, '1:1', { status: 'processing' }),
				serverPuzzle('failed', 4, '1:1', { status: 'failed' })
			],
			quickPuzzles: [],
			sessionStorage: adapter
		});

		expect(contexts).toHaveLength(0);
	});

	it('skips server puzzles with valid aspect ratio but invalid piece count', () => {
		const { adapter, contexts } = spyAdapter();
		// 1:1 requires a perfect-square piece count; 5 is not a perfect square.
		discoverGalleryProgress({
			serverPuzzles: [serverPuzzle('bad-count', 5, '1:1')],
			quickPuzzles: [],
			sessionStorage: adapter
		});

		expect(contexts).toHaveLength(0);
	});

	it('skips null or non-object Quick records', () => {
		const { adapter, contexts } = spyAdapter();
		discoverGalleryProgress({
			serverPuzzles: [],
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
			serverPuzzles: [],
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
			serverPuzzles: [],
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
			serverPuzzles: [],
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
			serverPuzzles: [serverPuzzle('pz1', 4, '1:1')],
			quickPuzzles: [quickPuzzle()]
		});

		expect(discovery.newest).toBeNull();
		expect(discovery.byPuzzleId.size).toBe(0);
	});

	it('keeps the newest progress when a later candidate is older', () => {
		const serverSnapshot = validSnapshot();
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...serverSnapshot,
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 500
		};
		const store = {
			'puzzle-progress-pz1': JSON.stringify({ ...serverSnapshot, lastUpdated: 1_000 }),
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
		};

		const discovery = discoverGalleryProgress({
			serverPuzzles: [serverPuzzle('pz1', 4, '1:1')],
			quickPuzzles: [quickPuzzle()],
			sessionStorage: createSessionStorageAdapter({ storage: memoryStorage(store) })
		});

		// Server (1000) is newer than Quick (500) → newest stays server.
		expect(discovery.newest?.puzzleId).toBe('pz1');
		expect(discovery.newest?.lastUpdated).toBe(1_000);
	});
});
