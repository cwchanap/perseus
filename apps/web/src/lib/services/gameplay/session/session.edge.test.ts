import { describe, expect, it, vi } from 'vitest';
import { createPuzzleSession } from './session';
import type {
	Clock,
	CreatePuzzleSessionOptions,
	PersistedPuzzleSessionV1,
	PuzzleMetadata,
	PuzzleSessionAction
} from './types';

const metadata: PuzzleMetadata = {
	puzzleId: 'pz-edge',
	source: 'api',
	pieceCount: 4,
	gridCols: 2,
	gridRows: 2,
	pieces: [
		{ id: 0, correctX: 0, correctY: 0 },
		{ id: 1, correctX: 1, correctY: 0 },
		{ id: 2, correctX: 0, correctY: 1 },
		{ id: 3, correctX: 1, correctY: 1 }
	]
};

function makeClock(): Clock {
	return {
		monotonicNow: () => 0,
		wallNow: () => 1_000,
		setInterval: () => Symbol('interval'),
		clearInterval: () => {}
	};
}

function makeOptions(
	overrides: Partial<CreatePuzzleSessionOptions> = {}
): CreatePuzzleSessionOptions {
	return {
		metadata,
		runIdFactory: { create: () => '11111111-1111-4111-8111-111111111111' },
		clock: makeClock(),
		...overrides
	};
}

function restoredSnapshot(): PersistedPuzzleSessionV1 {
	return {
		schemaVersion: 1,
		puzzleId: metadata.puzzleId,
		source: metadata.source,
		lifecycle: 'paused',
		mode: 'timed',
		runId: '11111111-1111-4111-8111-111111111111',
		origin: 'resumed',
		elapsedActiveSeconds: 5,
		timingQuality: 'known',
		timerStarted: true,
		placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: true,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		organization: {
			filter: 'edges',
			activeTray: 'side',
			membership: { 0: 'side' },
			names: { side: 'Side pieces' }
		},
		lastUpdated: 1_000
	};
}

describe('PuzzleSession edge coverage', () => {
	it('returns an invalid-transition no-op for an unknown runtime action', () => {
		const session = createPuzzleSession(makeOptions());
		const action = { type: 'unknown' } as unknown as PuzzleSessionAction;

		expect(session.dispatch(action)).toEqual({
			type: 'lifecycle_noop',
			reason: 'invalid_transition'
		});
	});

	it('stops notifying a listener after unsubscribe', () => {
		const session = createPuzzleSession(makeOptions());
		const listener = vi.fn();
		const unsubscribe = session.subscribe(listener);

		unsubscribe();
		session.dispatch({ type: 'start' });

		expect(listener).not.toHaveBeenCalled();
	});

	it('disposes through the convenience method', () => {
		const session = createPuzzleSession(makeOptions());

		session.dispose();

		expect(session.getState().lifecycle).toBe('disposed');
	});

	it('uses the default puzzle-id seed when generating initial rotations', () => {
		const session = createPuzzleSession(makeOptions());
		session.dispatch({ type: 'start' });

		const outcome = session.dispatch({ type: 'set_rotation_mode', enabled: true });

		expect(outcome).toEqual({ type: 'rotation_mode_changed', enabled: true });
		expect(Object.keys(session.getState().pieceRotations).map(Number).sort()).toEqual([0, 1, 2, 3]);
	});

	it('clones restored tray organization data', () => {
		const restored = restoredSnapshot();
		const session = createPuzzleSession(makeOptions({ restored }));

		restored.organization!.membership[0] = 'main';
		restored.organization!.names.side = 'Changed';

		expect(session.getState().organization).toEqual({
			filter: 'edges',
			activeTray: 'side',
			membership: { 0: 'side' },
			names: { side: 'Side pieces' }
		});
	});
});
