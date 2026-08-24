// Shared fixtures for the web-local browser persistence wrapper tests.
// Snapshot shape and the loader come from @perseus/game-core; only the
// Storage-facing helpers (memoryStorage) are web-specific.
import type { PersistedPuzzleSessionV1, SessionValidationContext } from '@perseus/game-core';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';

export const context: SessionValidationContext = {
	puzzleId: 'pz1',
	source: 'api',
	pieceIds: [0, 1, 2, 3],
	gridCols: 2,
	gridRows: 2,
	pieceCount: 4,
	pieces: [
		{ id: 0, correctX: 0, correctY: 0 },
		{ id: 1, correctX: 1, correctY: 0 },
		{ id: 2, correctX: 0, correctY: 1 },
		{ id: 3, correctX: 1, correctY: 1 }
	]
};

export function validSnapshot(): PersistedPuzzleSessionV1 {
	return {
		schemaVersion: 1,
		puzzleId: 'pz1',
		source: 'api',
		lifecycle: 'active',
		mode: 'timed',
		runId: RUN_ID,
		origin: 'new',
		elapsedActiveSeconds: 5,
		timerStarted: true,
		// Partial board: a genuinely in-progress session. A full board without a
		// sealed completion is a dead state and must be rejected by the loader.
		placedPieces: [
			{ pieceId: 0, x: 0, y: 0 },
			{ pieceId: 1, x: 1, y: 0 }
		],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: true,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		lastUpdated: 1_000
	};
}

/**
 * Placements covering every piece in the test puzzle, used by completion
 * fixtures that need a full board alongside a completed lifecycle + seal.
 */
export function fullBoardPlacements() {
	return [
		{ pieceId: 0, x: 0, y: 0 },
		{ pieceId: 1, x: 1, y: 0 },
		{ pieceId: 2, x: 0, y: 1 },
		{ pieceId: 3, x: 1, y: 1 }
	];
}

export function seal(patch: Record<string, unknown> = {}) {
	return {
		runId: RUN_ID,
		resultClass: 'standard_timed',
		elapsedActiveSeconds: 5,
		completedAt: 1_000,
		localStats: { status: 'succeeded' },
		serverSubmission: { status: 'succeeded' },
		hintsUsed: 0,
		incorrectAttempts: 0,
		rotationEnabled: false,
		rotationUsed: false,
		...patch
	};
}

export function memoryStorage(store: Record<string, string>): Storage {
	return {
		get length() {
			return Object.keys(store).length;
		},
		key: (i: number) => Object.keys(store)[i] ?? null,
		getItem: (k: string) => (k in store ? store[k] : null),
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
		removeItem: (k: string) => {
			delete store[k];
		},
		clear: () => {
			for (const key of Object.keys(store)) {
				delete store[key];
			}
		}
	};
}
