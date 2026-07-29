import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStorageAdapter } from './persistence';
import type {
	PersistedPuzzleSessionV1,
	SessionPersistenceError,
	SessionValidationContext
} from './types';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const context: SessionValidationContext = {
	puzzleId: 'pz1',
	source: 'api',
	pieceIds: [0],
	gridCols: 1,
	gridRows: 1,
	pieceCount: 1
};
const snapshot: PersistedPuzzleSessionV1 = {
	schemaVersion: 1,
	puzzleId: 'pz1',
	source: 'api',
	lifecycle: 'active',
	mode: 'timed',
	runId: RUN_ID,
	origin: 'new',
	elapsedActiveSeconds: 0,
	timingQuality: 'known',
	timerStarted: false,
	placedPieces: [],
	trayOrder: [0],
	rotationEnabled: false,
	pieceRotations: {},
	counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
	facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
	hasUserActivity: false,
	resultClass: 'standard_timed',
	sealedCompletion: null,
	lastUpdated: 0
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('PuzzleSession unavailable storage fallback', () => {
	it('loads safely and reports writes when localStorage is unavailable', () => {
		const errors: SessionPersistenceError[] = [];
		vi.stubGlobal('localStorage', undefined);
		const adapter = createSessionStorageAdapter({
			onError: (error) => errors.push(error)
		});

		expect(adapter.loadSession('pz1', context).status).toBe('missing');
		expect(() => adapter.saveSession('pz1', snapshot)).not.toThrow();
		expect(() => adapter.clearSession('pz1')).not.toThrow();
		expect(errors.map((error) => error.kind)).toEqual(['write_error']);
	});
});
