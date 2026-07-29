import { describe, expect, it } from 'vitest';
import { createSessionStorageAdapter, serializeSession } from './persistence';
import type {
	PuzzleSessionState,
	SessionPersistenceError,
	SessionValidationContext
} from './types';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const context: SessionValidationContext = {
	puzzleId: 'pz1',
	source: 'api',
	pieceIds: [0, 1, 2, 3],
	gridCols: 2,
	gridRows: 2,
	pieceCount: 4
};

function validState(overrides: Partial<PuzzleSessionState> = {}): PuzzleSessionState {
	return {
		puzzleId: 'pz1',
		source: 'api',
		runId: RUN_ID,
		origin: 'new',
		lifecycle: 'active',
		mode: 'timed',
		timingQuality: 'known',
		elapsedActiveSeconds: 5,
		timerStarted: true,
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		selectedPieceId: null,
		activeReferenceMode: null,
		organization: null,
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: true,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		canUndo: false,
		canRedo: false,
		...overrides
	};
}

describe('PuzzleSession persistence adapter and cloning', () => {
	it('reports storage read and remove failures', () => {
		const errors: SessionPersistenceError[] = [];
		const storage = {
			length: 0,
			key: () => null,
			getItem: () => {
				throw new Error('read failed');
			},
			setItem: () => {},
			removeItem: () => {
				throw new Error('remove failed');
			},
			clear: () => {}
		} satisfies Storage;
		const adapter = createSessionStorageAdapter({
			storage,
			onError: (error) => errors.push(error)
		});

		expect(adapter.loadSession('pz1', context).status).toBe('missing');
		expect(() => adapter.clearSession('pz1')).not.toThrow();
		expect(errors.map((error) => error.kind)).toEqual(['read_error', 'remove_error']);
	});

	it('serializes cloned organization, gameplay, and completion data', () => {
		const state = validState({
			organization: {
				filter: 'edges',
				activeTray: 'side',
				membership: { 0: 'side' },
				names: { side: 'Side' }
			},
			pieceRotations: { 0: 90 },
			sealedCompletion: {
				runId: RUN_ID,
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 5,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'succeeded' }
			}
		});
		const snapshot = serializeSession(state, 2_000)!;

		state.placedPieces[0].x = 1;
		state.trayOrder[0] = 3;
		state.pieceRotations[0] = 180;
		state.counters.incorrectAttempts = 9;
		state.facts.rotationUsed = true;
		state.organization!.membership[0] = 'main';
		state.organization!.names.side = 'Changed';

		expect(snapshot.placedPieces[0].x).toBe(0);
		expect(snapshot.trayOrder[0]).toBe(0);
		expect(snapshot.pieceRotations[0]).toBe(90);
		expect(snapshot.counters.incorrectAttempts).toBe(0);
		expect(snapshot.facts.rotationUsed).toBe(false);
		expect(snapshot.organization).toEqual({
			filter: 'edges',
			activeTray: 'side',
			membership: { 0: 'side' },
			names: { side: 'Side' }
		});
		expect(snapshot.sealedCompletion).toEqual(state.sealedCompletion);
	});
});
