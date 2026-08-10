import { describe, expect, it } from 'vitest';
import { createSessionStorageAdapter, serializeSession } from './persistence';
import { context, memoryStorage, validSnapshot } from './persistence.test-fixtures';
import type { PuzzleSessionState, SessionPersistenceError } from './types';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

function validState(overrides: Partial<PuzzleSessionState> = {}): PuzzleSessionState {
	return {
		puzzleId: 'pz1',
		source: 'api',
		runId: RUN_ID,
		origin: 'new',
		lifecycle: 'active',
		mode: 'timed',
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
		viewport: null,
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
	it('peekSession reports invalid data without removing it', () => {
		const snapshot = validSnapshot();
		const raw = JSON.stringify({ ...snapshot, schemaVersion: 999 });
		const store = { 'puzzle-progress-pz1': raw };
		const adapter = createSessionStorageAdapter({ storage: memoryStorage(store) });

		expect(adapter.peekSession('pz1', context)).toEqual({
			status: 'invalid',
			reason: 'unsupported_schema_version'
		});
		expect(store['puzzle-progress-pz1']).toBe(raw);
	});

	it('loadSession still removes invalid data', () => {
		const snapshot = validSnapshot();
		const store = {
			'puzzle-progress-pz1': JSON.stringify({ ...snapshot, schemaVersion: 999 })
		};
		const adapter = createSessionStorageAdapter({ storage: memoryStorage(store) });

		expect(adapter.loadSession('pz1', context)).toEqual({ status: 'missing' });
		expect(store['puzzle-progress-pz1']).toBeUndefined();
	});

	it('reports storage read and remove failures', () => {
		const errors: SessionPersistenceError[] = [];
		const storage = memoryStorage({});
		storage.getItem = () => {
			throw new Error('read failed');
		};
		storage.removeItem = () => {
			throw new Error('remove failed');
		};
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
		state.sealedCompletion!.localStats.status = 'failed';

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
		expect(snapshot.sealedCompletion?.localStats.status).toBe('succeeded');
	});
});
