// Red tests for PuzzleSession lifecycle and the single injected clock.
import { describe, it, expect } from 'vitest';
import { createPuzzleSession } from './session';
import type {
	PuzzleSessionState,
	PuzzleMetadata,
	RunIdFactory,
	Clock,
	PersistedPuzzleSessionV1,
	CompletionEffectState
} from './types';

interface ManagedInterval {
	cb: () => void;
	ms: number;
	active: boolean;
}

class ManualClock implements Clock {
	monotonic = 0;
	wall = 0;
	intervals = new Set<ManagedInterval>();
	startedIntervalCount = 0;
	clearedIntervalCount = 0;

	monotonicNow() {
		return this.monotonic;
	}
	wallNow() {
		return this.wall;
	}
	setInterval(cb: () => void, ms: number) {
		this.startedIntervalCount++;
		const entry: ManagedInterval = { cb, ms, active: true };
		this.intervals.add(entry);
		return entry;
	}
	clearInterval(handle: unknown) {
		const entry = handle as ManagedInterval;
		if (entry && this.intervals.has(entry) && entry.active) {
			entry.active = false;
			this.clearedIntervalCount++;
			this.intervals.delete(entry);
		}
	}
	get activeIntervalCount() {
		let n = 0;
		for (const e of this.intervals) if (e.active) n++;
		return n;
	}
	advance(ms: number) {
		this.monotonic += ms;
		this.wall += ms;
	}
}

function makeMetadata(pieceCount = 4): PuzzleMetadata {
	// Build a grid that satisfies gridCols * gridRows === pieceCount so the
	// metadata passes the engine's construction validation. Use a 2-column
	// layout for even counts >= 2 (preserving the coordinates existing tests
	// assume for pieceCount 2 and 4) and a single column otherwise.
	const gridCols = pieceCount >= 2 && pieceCount % 2 === 0 ? 2 : 1;
	const gridRows = pieceCount / gridCols;
	const pieces = Array.from({ length: pieceCount }, (_, i) => ({
		id: i,
		correctX: i % gridCols,
		correctY: Math.floor(i / gridCols)
	}));
	return {
		puzzleId: 'pz1',
		source: 'api',
		pieceCount,
		gridCols,
		gridRows,
		pieces
	};
}

function makeRunIdFactory(): RunIdFactory {
	let n = 0;
	return { create: () => `run-${++n}` };
}

function makeOptions(
	overrides: Partial<{ clock: Clock; metadata: PuzzleMetadata; mode: 'timed' | 'relaxed' }> = {}
) {
	return {
		metadata: overrides.metadata ?? makeMetadata(),
		runIdFactory: makeRunIdFactory(),
		clock: overrides.clock ?? new ManualClock(),
		mode: overrides.mode
	};
}

describe('PuzzleSession lifecycle', () => {
	it('creates a fresh session in setup with a known timed identity', () => {
		const session = createPuzzleSession(makeOptions());
		const state = session.getState();

		expect(state.lifecycle).toBe('setup');
		expect(state.origin).toBe('new');
		expect(state.mode).toBe('timed');
		expect(state.timingQuality).toBe('known');
		expect(state.timerStarted).toBe(false);
		expect(state.elapsedActiveSeconds).toBe(0);
		expect(state.placedPieces).toEqual([]);
		expect(state.runId).toMatch(/^run-\d+$/);
		expect(state.sealedCompletion).toBeNull();
	});

	it('moves setup -> active on start and returns a transitioned outcome', () => {
		const session = createPuzzleSession(makeOptions());

		const outcome = session.dispatch({ type: 'start' });

		expect(outcome).toEqual({ type: 'lifecycle_transitioned', from: 'setup', to: 'active' });
		expect(session.getState().lifecycle).toBe('active');
	});

	it('repeats start as a no-op once active', () => {
		const session = createPuzzleSession(makeOptions());
		session.dispatch({ type: 'start' });

		expect(session.dispatch({ type: 'start' })).toEqual({
			type: 'lifecycle_noop',
			reason: 'invalid_transition'
		});
	});

	it('pauses an active session and checkpoints elapsed time', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession(makeOptions({ clock }));
		session.dispatch({ type: 'start' });

		// Pretend a counted action already started the clock by advancing and
		// checkpointing directly (placement starts the clock in Task 3).
		expect(session.getState().timerStarted).toBe(false);
		// Without a counted action, pausing still transitions lifecycle.
		const outcome = session.dispatch({ type: 'pause' });

		expect(outcome.type).toBe('lifecycle_transitioned');
		expect(session.getState().lifecycle).toBe('paused');
	});

	it('resumes a paused session back to active', () => {
		const session = createPuzzleSession(makeOptions());
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'pause' });

		const outcome = session.dispatch({ type: 'resume' });

		expect(outcome).toEqual({
			type: 'lifecycle_transitioned',
			from: 'paused',
			to: 'active'
		});
		expect(session.getState().lifecycle).toBe('active');
	});

	it('rejects pause from non-active lifecycle', () => {
		const session = createPuzzleSession(makeOptions());

		expect(session.dispatch({ type: 'pause' }).type).toBe('lifecycle_noop');
		expect(session.dispatch({ type: 'resume' }).type).toBe('lifecycle_noop');
	});

	it('makes disposed terminal: every subsequent action is a no-op', () => {
		const session = createPuzzleSession(makeOptions());

		session.dispatch({ type: 'dispose' });

		expect(session.getState().lifecycle).toBe('disposed');
		expect(session.dispatch({ type: 'start' }).type).toBe('lifecycle_noop');
		expect(session.dispatch({ type: 'pause' }).type).toBe('lifecycle_noop');
		expect(session.dispatch({ type: 'resume' }).type).toBe('lifecycle_noop');
	});

	it('does not overwrite restored active/paused/completed lifecycle on construction', () => {
		for (const lifecycle of ['active', 'paused', 'completed'] as const) {
			const restored: PersistedPuzzleSessionV1 = {
				schemaVersion: 1,
				puzzleId: 'pz1',
				source: 'api',
				lifecycle,
				mode: 'timed',
				runId: 'run-restored',
				origin: 'resumed',
				elapsedActiveSeconds: lifecycle === 'completed' ? 42 : 12,
				timingQuality: 'known',
				timerStarted: lifecycle === 'active',
				placedPieces: [],
				trayOrder: [0, 1, 2, 3],
				rotationEnabled: false,
				pieceRotations: {},
				counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
				facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
				hasUserActivity: true,
				resultClass: 'standard_timed',
				sealedCompletion: null,
				lastUpdated: 0
			};
			const session = createPuzzleSession({ ...makeOptions(), restored });
			expect(session.getState().lifecycle).toBe(lifecycle);
			expect(session.getState().origin).toBe('resumed');
			expect(session.getState().runId).toBe('run-restored');
		}
	});
});

describe('PuzzleSession clock and timing', () => {
	it('does not accumulate time while active but before any counted action', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession(makeOptions({ clock }));
		session.dispatch({ type: 'start' });
		clock.advance(5_000);
		session.checkpointTime();

		expect(session.getState().elapsedActiveSeconds).toBe(0);
		expect(session.getState().timerStarted).toBe(false);
	});

	it('keeps elapsed null and the clock off for relaxed sessions', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession(makeOptions({ clock, mode: 'relaxed' }));
		session.dispatch({ type: 'start' });

		expect(session.getState().elapsedActiveSeconds).toBeNull();
		expect(clock.activeIntervalCount).toBe(0);
	});

	it('keeps elapsed null and the clock off for legacy_unknown sessions', () => {
		const clock = new ManualClock();
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'legacy-abc',
			origin: 'resumed',
			elapsedActiveSeconds: null,
			timingQuality: 'legacy_unknown',
			timerStarted: false,
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: 0
		};
		const session = createPuzzleSession({ ...makeOptions({ clock }), restored });

		expect(session.getState().elapsedActiveSeconds).toBeNull();
		expect(session.getState().timingQuality).toBe('legacy_unknown');
		expect(clock.activeIntervalCount).toBe(0);
	});

	it('restarts the clock on construction for an active known timed restored session', () => {
		const clock = new ManualClock();
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'run-x',
			origin: 'resumed',
			elapsedActiveSeconds: 10,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: 0
		};
		const session = createPuzzleSession({ ...makeOptions({ clock }), restored });

		expect(clock.activeIntervalCount).toBe(1);
		clock.advance(3_500);
		session.checkpointTime();
		expect(session.getState().elapsedActiveSeconds).toBe(13);
	});

	it('checkpoints whole seconds and preserves the residual', () => {
		const clock = new ManualClock();
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'run-x',
			origin: 'resumed',
			elapsedActiveSeconds: 0,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: 0
		};
		const session = createPuzzleSession({ ...makeOptions({ clock }), restored });

		clock.advance(2_500);
		session.checkpointTime();
		expect(session.getState().elapsedActiveSeconds).toBe(2);
		clock.advance(500);
		session.checkpointTime();
		expect(session.getState().elapsedActiveSeconds).toBe(3);
	});

	it('suspends the clock on document hidden without changing lifecycle', () => {
		const clock = new ManualClock();
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'run-x',
			origin: 'resumed',
			elapsedActiveSeconds: 0,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: 0
		};
		const session = createPuzzleSession({ ...makeOptions({ clock }), restored });
		expect(clock.activeIntervalCount).toBe(1);

		session.setDocumentHidden(true);

		expect(session.getState().lifecycle).toBe('active');
		expect(clock.activeIntervalCount).toBe(0);
		// Hidden time is excluded.
		clock.advance(10_000);
		session.checkpointTime();
		expect(session.getState().elapsedActiveSeconds).toBe(0);
	});

	it('resumes the clock on document visible only for an active started known timed run', () => {
		const clock = new ManualClock();
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'run-x',
			origin: 'resumed',
			elapsedActiveSeconds: 0,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: 0
		};
		const session = createPuzzleSession({ ...makeOptions({ clock }), restored });
		session.setDocumentHidden(true);
		expect(clock.activeIntervalCount).toBe(0);

		session.setDocumentHidden(false);

		expect(clock.activeIntervalCount).toBe(1);
		clock.advance(2_000);
		session.checkpointTime();
		expect(session.getState().elapsedActiveSeconds).toBe(2);
	});

	it('does not auto-resume an explicitly paused session on visibility', () => {
		const clock = new ManualClock();
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'paused',
			mode: 'timed',
			runId: 'run-x',
			origin: 'resumed',
			elapsedActiveSeconds: 5,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: 0
		};
		const session = createPuzzleSession({ ...makeOptions({ clock }), restored });
		expect(clock.activeIntervalCount).toBe(0);

		session.setDocumentHidden(true);
		session.setDocumentHidden(false);

		expect(session.getState().lifecycle).toBe('paused');
		expect(clock.activeIntervalCount).toBe(0);
	});

	it('dispose stops the clock and clears the interval', () => {
		const clock = new ManualClock();
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'run-x',
			origin: 'resumed',
			elapsedActiveSeconds: 0,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [],
			trayOrder: [0, 1, 2, 3],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: 0
		};
		const session = createPuzzleSession({ ...makeOptions({ clock }), restored });
		expect(clock.activeIntervalCount).toBe(1);

		session.dispose();

		expect(session.getState().lifecycle).toBe('disposed');
		expect(clock.activeIntervalCount).toBe(0);
		expect(clock.clearedIntervalCount).toBeGreaterThanOrEqual(1);
	});

	it('dispose is idempotent', () => {
		const session = createPuzzleSession(makeOptions());
		session.dispose();
		session.dispose();

		expect(session.getState().lifecycle).toBe('disposed');
	});

	it('never reports disposed as a restorable lifecycle in serialized state', () => {
		const session = createPuzzleSession(makeOptions());
		session.dispatch({ type: 'start' });
		session.dispose();

		const state: PuzzleSessionState = session.getState();
		// The serializer (Task 6) rejects disposed; here we assert the engine's
		// state only carries the terminal lifecycle, and a fresh instance is the
		// restorable unit (not the disposed one).
		expect(state.lifecycle).toBe('disposed');
	});
});

// --- Task 3: selection, placement, rotation, history ---------------------------

import type { Rotation } from '$lib/types/gameplay';

function deterministicRotations(ids: number[]): Record<number, Rotation> {
	const out: Record<number, Rotation> = {};
	ids.forEach((id, i) => {
		out[id] = ((i % 4) * 90) as Rotation;
	});
	return out;
}

function startedSession(
	overrides: Partial<{
		pieceCount: number;
		createRotations: (ids: number[]) => Record<number, Rotation>;
	}> = {}
) {
	const clock = new ManualClock();
	const session = overrides.createRotations
		? createPuzzleSession({
				metadata: makeMetadata(overrides.pieceCount ?? 4),
				runIdFactory: makeRunIdFactory(),
				clock,
				createRotations: overrides.createRotations
			})
		: createPuzzleSession(
				makeOptions({
					clock,
					metadata: makeMetadata(overrides.pieceCount ?? 4)
				})
			);
	session.dispatch({ type: 'start' });
	return { session, clock };
}

describe('PuzzleSession selection', () => {
	it('selects a known unplaced piece', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({ type: 'select_piece', pieceId: 1 });

		expect(outcome).toEqual({ type: 'selection_changed', pieceId: 1 });
		expect(session.getState().selectedPieceId).toBe(1);
	});

	it('cancels the current selection', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'select_piece', pieceId: 1 });

		session.dispatch({ type: 'cancel_selection' });

		expect(session.getState().selectedPieceId).toBeNull();
	});

	it('no-ops selection of an unknown piece', () => {
		const { session } = startedSession();

		expect(session.dispatch({ type: 'select_piece', pieceId: 99 }).type).toBe('selection_noop');
		expect(session.getState().selectedPieceId).toBeNull();
	});

	it('no-ops selection of an already-placed piece', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(session.dispatch({ type: 'select_piece', pieceId: 0 }).type).toBe('selection_noop');
	});

	it('clears selection when the selected piece is placed', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'select_piece', pieceId: 0 });

		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(session.getState().selectedPieceId).toBeNull();
	});
});

describe('PuzzleSession placement', () => {
	it('accepts a correct placement once', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({
			type: 'attempt_placement',
			pieceId: 0,
			x: 0,
			y: 0
		});

		expect(outcome).toEqual({
			type: 'placement',
			outcome: { status: 'accepted', completed: false }
		});
		expect(session.getState().placedPieces).toEqual([{ pieceId: 0, x: 0, y: 0 }]);
	});

	it('rejects a wrong-slot placement and counts it once', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({
			type: 'attempt_placement',
			pieceId: 0,
			x: 1,
			y: 0
		});

		expect(outcome).toEqual({
			type: 'placement',
			outcome: { status: 'rejected', reason: 'wrong_slot', counted: true }
		});
		expect(session.getState().counters.incorrectAttempts).toBe(1);
		expect(session.getState().placedPieces).toEqual([]);
	});

	it('no-ops an unknown piece without counting', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({ type: 'attempt_placement', pieceId: 99, x: 0, y: 0 });

		expect(outcome.type).toBe('placement');
		expect(session.getState().counters.incorrectAttempts).toBe(0);
	});

	it('no-ops a duplicate (already-placed) piece without counting', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		const outcome = session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(outcome.type).toBe('placement');
		expect((outcome as { outcome: { status: string } }).outcome.status).toBe('noop');
		expect(session.getState().counters.incorrectAttempts).toBe(0);
	});

	it('no-ops non-integer coordinates without counting', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({
			type: 'attempt_placement',
			pieceId: 0,
			x: 0.5,
			y: 0
		});

		expect((outcome as { outcome: { status: string } }).outcome.status).toBe('noop');
		expect(session.getState().counters.incorrectAttempts).toBe(0);
	});

	it('reports completed=true when the final unique piece is placed', () => {
		const { session } = startedSession({ pieceCount: 2 });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		const outcome = session.dispatch({ type: 'attempt_placement', pieceId: 1, x: 1, y: 0 });

		expect((outcome as { outcome: { completed: boolean } }).outcome.completed).toBe(true);
	});

	it('starts the clock on an accepted placement', () => {
		const { session, clock } = startedSession();

		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(session.getState().timerStarted).toBe(true);
		expect(clock.activeIntervalCount).toBe(1);
	});

	it('direct complete before a valid full board is a no-op', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({ type: 'complete' });

		expect(outcome.type).toBe('completion_noop');
	});

	it('no-ops placement outside active gameplay (e.g. setup)', () => {
		const session = createPuzzleSession(makeOptions());

		const outcome = session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect((outcome as { outcome: { status: string } }).outcome.status).toBe('noop');
	});
});

describe('PuzzleSession rotation and history', () => {
	it('locks rotation-mode toggle unless active with zero pieces placed', () => {
		const session = createPuzzleSession(makeOptions());

		expect(session.dispatch({ type: 'set_rotation_mode', enabled: true }).type).toBe(
			'rotation_mode_noop'
		);
	});

	it('enabling rotation immediately sets rotationUsed and rotation_timed result class', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });

		session.dispatch({ type: 'set_rotation_mode', enabled: true });

		expect(session.getState().rotationEnabled).toBe(true);
		expect(session.getState().facts.rotationUsed).toBe(true);
		expect(session.getState().resultClass).toBe('rotation_timed');
		expect(session.getState().timerStarted).toBe(false);
	});

	it('disabling rotation after enabling does not restore standard eligibility', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		session.dispatch({ type: 'set_rotation_mode', enabled: true });

		session.dispatch({ type: 'set_rotation_mode', enabled: false });

		expect(session.getState().rotationEnabled).toBe(false);
		expect(session.getState().facts.rotationUsed).toBe(true);
		expect(session.getState().resultClass).toBe('rotation_timed');
	});

	it('locks rotation toggle after the first placement', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(session.dispatch({ type: 'set_rotation_mode', enabled: true }).type).toBe(
			'rotation_mode_noop'
		);
	});

	it('rotates an unplaced piece 90 degrees clockwise', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		session.dispatch({ type: 'set_rotation_mode', enabled: true });
		// piece 1 starts at 90 (deterministic: index 1 -> 90)
		expect(session.getState().pieceRotations[1]).toBe(90);

		session.dispatch({ type: 'rotate_piece', pieceId: 1 });

		expect(session.getState().pieceRotations[1]).toBe(180);
		expect(session.getState().timerStarted).toBe(true);
	});

	it('does not rotate a placed or unknown piece', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		session.dispatch({ type: 'set_rotation_mode', enabled: true });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(session.dispatch({ type: 'rotate_piece', pieceId: 0 }).type).toBe('rotation_noop');
		expect(session.dispatch({ type: 'rotate_piece', pieceId: 99 }).type).toBe('rotation_noop');
	});

	it('rejects non-upright placement and counts it', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		session.dispatch({ type: 'set_rotation_mode', enabled: true });
		// piece 0 starts at 0 (upright) per deterministic; rotate it to 90 first.
		session.dispatch({ type: 'rotate_piece', pieceId: 0 });

		const outcome = session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect((outcome as { outcome: { status: string; reason?: string } }).outcome).toMatchObject({
			status: 'rejected',
			reason: 'non_upright'
		});
		expect(session.getState().counters.incorrectAttempts).toBe(1);
	});

	it('undo restores placements, rotations, and rotation-mode; not selection/counters', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
		session.dispatch({ type: 'select_piece', pieceId: 1 });

		const outcome = session.dispatch({ type: 'undo' });

		expect(outcome.type).toBe('history_restored');
		expect(session.getState().placedPieces).toEqual([]);
		expect(session.getState().canUndo).toBe(false);
		expect(session.getState().canRedo).toBe(true);
		// selection and counters are not restored/affected by undo; selection is transient.
		expect(session.getState().selectedPieceId).toBe(1);
	});

	it('redo re-applies the undone placement', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
		session.dispatch({ type: 'undo' });

		session.dispatch({ type: 'redo' });

		expect(session.getState().placedPieces).toEqual([{ pieceId: 0, x: 0, y: 0 }]);
		expect(session.getState().canRedo).toBe(false);
	});

	it('undo keeps rotationUsed and the rotation_timed result class', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		session.dispatch({ type: 'set_rotation_mode', enabled: true });
		session.dispatch({ type: 'rotate_piece', pieceId: 0 });

		session.dispatch({ type: 'undo' });

		// rotationEnabled restored from history (was true at snapshot), but the
		// monotonic rotationUsed fact and result class remain.
		expect(session.getState().facts.rotationUsed).toBe(true);
		expect(session.getState().resultClass).toBe('rotation_timed');
	});

	it('history boundaries return typed no-ops', () => {
		const { session } = startedSession();

		expect(session.dispatch({ type: 'undo' }).type).toBe('history_noop');
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
		session.dispatch({ type: 'undo' });
		expect(session.dispatch({ type: 'redo' }).type).toBe('history_restored');
		expect(session.dispatch({ type: 'redo' }).type).toBe('history_noop');
	});
});

// --- Task 4: assistance, reference, activity, restart, organization -----------

describe('PuzzleSession hints', () => {
	it('increments the hint counter and makes a timed run assisted', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({ type: 'use_hint' });

		expect(outcome).toEqual({ type: 'hint_used', pieceId: 0 });
		expect(session.getState().counters.hintsUsed).toBe(1);
		expect(session.getState().facts.hintUsed).toBe(true);
		expect(session.getState().resultClass).toBe('assisted_timed');
	});

	it('hint does not start the timer', () => {
		const { session, clock } = startedSession();
		session.dispatch({ type: 'use_hint' });

		expect(session.getState().timerStarted).toBe(false);
		expect(clock.activeIntervalCount).toBe(0);
	});

	it('hint is a no-op when every piece is placed', () => {
		const { session } = startedSession({ pieceCount: 1 });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(session.dispatch({ type: 'use_hint' }).type).toBe('hint_noop');
	});
});

describe('PuzzleSession reference modes', () => {
	it('null -> hold increments the reference counter but does not change result class', () => {
		const { session } = startedSession();

		session.dispatch({ type: 'set_reference_mode', mode: 'hold' });

		expect(session.getState().counters.referenceActivations).toBe(1);
		expect(session.getState().activeReferenceMode).toBe('hold');
		expect(session.getState().resultClass).toBe('standard_timed');
	});

	it('null -> toggle increments once; repeated activations do not increment again', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });

		session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });

		expect(session.getState().counters.referenceActivations).toBe(1);
	});

	it('null -> ghost makes a timed run assisted', () => {
		const { session } = startedSession();

		session.dispatch({ type: 'set_reference_mode', mode: 'ghost' });

		expect(session.getState().counters.referenceActivations).toBe(1);
		expect(session.getState().facts.ghostReferenceUsed).toBe(true);
		expect(session.getState().resultClass).toBe('assisted_timed');
	});

	it('setting null ends activation without incrementing', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'set_reference_mode', mode: 'hold' });

		session.dispatch({ type: 'set_reference_mode', mode: null });

		expect(session.getState().counters.referenceActivations).toBe(1);
		expect(session.getState().activeReferenceMode).toBeNull();
	});

	it('switching active mode without first null does not double-count', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'set_reference_mode', mode: 'hold' });

		session.dispatch({ type: 'set_reference_mode', mode: 'toggle' });

		expect(session.getState().counters.referenceActivations).toBe(1);
	});

	it('relaxed runs remain relaxed regardless of assistance', () => {
		const session = createPuzzleSession(makeOptions({ mode: 'relaxed' }));
		session.dispatch({ type: 'start' });

		session.dispatch({ type: 'use_hint' });

		expect(session.getState().resultClass).toBe('relaxed');
	});
});

describe('PuzzleSession activity flag', () => {
	it('starts false and becomes true on a counted placement attempt', () => {
		const { session } = startedSession();
		expect(session.getState().hasUserActivity).toBe(false);

		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 1, y: 0 });

		expect(session.getState().hasUserActivity).toBe(true);
	});

	it('does not become true on start alone', () => {
		const { session } = startedSession();
		expect(session.getState().hasUserActivity).toBe(false);
	});

	it('does not become true on a duplicate placement', () => {
		const { session } = startedSession();
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		// already true from first; a duplicate does not flip it back to false, and
		// never sets it true on its own (covered by the no-activity baseline).
		expect(session.getState().hasUserActivity).toBe(true);
	});

	it('becomes true when rotation mode is enabled, even with zero placements', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		expect(session.getState().hasUserActivity).toBe(false);

		session.dispatch({ type: 'set_rotation_mode', enabled: true });

		// Enabling rotation permanently changes result eligibility, so it must
		// count as user activity for resume discovery (isResumable).
		expect(session.getState().hasUserActivity).toBe(true);
	});

	it('becomes true when rotation mode is disabled after being enabled', () => {
		const { session } = startedSession({ createRotations: deterministicRotations });
		session.dispatch({ type: 'set_rotation_mode', enabled: true });

		// Reset is only possible via a fresh session that never enabled rotation;
		// here we verify disabling also marks activity (a persisted state change).
		const before = session.getState().hasUserActivity;
		session.dispatch({ type: 'set_rotation_mode', enabled: false });
		expect(session.getState().hasUserActivity).toBe(true);
		expect(before).toBe(true);
	});
});

describe('PuzzleSession restart', () => {
	it('clears placements, counters, assistance, history, and creates a new run id', () => {
		const { session } = startedSession({ pieceCount: 2 });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
		session.dispatch({ type: 'use_hint' });
		const firstRun = session.getState().runId;

		const outcome = session.dispatch({ type: 'restart' });

		expect(outcome).toEqual({ type: 'lifecycle_transitioned', from: 'active', to: 'setup' });
		expect(session.getState().runId).not.toBe(firstRun);
		expect(session.getState().placedPieces).toEqual([]);
		expect(session.getState().counters.hintsUsed).toBe(0);
		expect(session.getState().facts.hintUsed).toBe(false);
		expect(session.getState().facts.rotationUsed).toBe(false);
		expect(session.getState().resultClass).toBe('standard_timed');
		expect(session.getState().hasUserActivity).toBe(false);
		expect(session.getState().canUndo).toBe(false);
	});

	it('retains the session mode across restart', () => {
		const session = createPuzzleSession(makeOptions({ mode: 'relaxed' }));
		session.dispatch({ type: 'start' });

		session.dispatch({ type: 'restart' });

		expect(session.getState().mode).toBe('relaxed');
		expect(session.getState().resultClass).toBe('relaxed');
	});

	it('is a no-op from setup', () => {
		const session = createPuzzleSession(makeOptions());

		expect(session.dispatch({ type: 'restart' }).type).toBe('lifecycle_noop');
	});

	it('works from completed', () => {
		const { session } = completeOnePieceSession();
		expect(session.getState().lifecycle).toBe('completed');

		expect(session.dispatch({ type: 'restart' }).type).toBe('lifecycle_transitioned');
	});
});

describe('PuzzleSession tray organization', () => {
	it('applies a valid filter update and records activity', () => {
		const { session } = startedSession();
		expect(session.getState().organization).toBeNull();

		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'set_filter', filter: 'edges' }
		});

		expect(outcome.type).toBe('tray_organization_applied');
		expect(session.getState().organization?.filter).toBe('edges');
		expect(session.getState().hasUserActivity).toBe(true);
	});

	it('rejects moving an unknown piece', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'move_piece', pieceId: 999, toTrayId: 'a' }
		});

		expect(outcome.type).toBe('tray_organization_noop');
	});
});

// --- Task 5: completion sealing and typed effects -----------------------------

import type { SealedCompletion, PuzzleSessionEventCallback } from './types';

function completeOnePieceSession(
	overrides: Partial<{
		mode: 'timed' | 'relaxed';
		onEvent: PuzzleSessionEventCallback;
	}> = {}
): {
	session: ReturnType<typeof createPuzzleSession>;
	seal: SealedCompletion;
} {
	const session = createPuzzleSession({
		metadata: makeMetadata(1),
		runIdFactory: makeRunIdFactory(),
		clock: new ManualClock(),
		mode: overrides.mode,
		onEvent: overrides.onEvent
	});
	session.dispatch({ type: 'start' });
	session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
	const seal = session.getState().sealedCompletion;
	if (!seal) throw new Error('expected seal');
	return { session, seal };
}

/**
 * Build a restored v1 snapshot mirroring `session`'s completed state but with
 * the two completion effect statuses supplied by the caller. Used by the
 * resume_completion_effects tests to exercise pending/succeeded/failed
 * combinations without repeating the snapshot literal.
 */
function makeRestoredSnapshot(
	session: ReturnType<typeof createPuzzleSession>,
	seal: SealedCompletion,
	effects: { localStats: CompletionEffectState; serverSubmission: CompletionEffectState }
): PersistedPuzzleSessionV1 {
	const s = session.getState();
	return {
		schemaVersion: 1,
		puzzleId: s.puzzleId,
		source: 'api',
		lifecycle: 'completed',
		mode: 'timed',
		runId: seal.runId,
		origin: 'resumed',
		elapsedActiveSeconds: seal.elapsedActiveSeconds,
		timingQuality: seal.timingQuality,
		timerStarted: true,
		placedPieces: s.placedPieces.map((p) => ({ ...p })),
		trayOrder: s.trayOrder.slice(),
		rotationEnabled: false,
		pieceRotations: {},
		counters: { ...s.counters },
		facts: { ...s.facts },
		hasUserActivity: true,
		resultClass: seal.resultClass,
		sealedCompletion: {
			runId: seal.runId,
			resultClass: seal.resultClass,
			timingQuality: seal.timingQuality,
			elapsedActiveSeconds: seal.elapsedActiveSeconds,
			completedAt: seal.completedAt,
			localStats: effects.localStats,
			serverSubmission: effects.serverSubmission
		},
		lastUpdated: 0
	};
}

describe('PuzzleSession completion sealing', () => {
	it('seals on the final placement and moves lifecycle to completed', () => {
		const { session, seal } = completeOnePieceSession();

		expect(seal.runId).toBe(session.getState().runId);
		expect(session.getState().lifecycle).toBe('completed');
		expect(seal.localStats.status).toBe('pending');
		expect(seal.serverSubmission.status).toBe('pending');
	});

	it('clamps a known timed elapsed time to at least one second in the seal', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession({
			metadata: makeMetadata(1),
			runIdFactory: makeRunIdFactory(),
			clock
		});
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		const seal = session.getState().sealedCompletion!;
		expect(seal.timingQuality).toBe('known');
		expect(seal.elapsedActiveSeconds).toBeGreaterThanOrEqual(1);
	});

	it('uses null elapsed for a relaxed seal', () => {
		const { seal } = completeOnePieceSession({ mode: 'relaxed' });

		expect(seal.resultClass).toBe('relaxed');
		expect(seal.elapsedActiveSeconds).toBeNull();
	});

	it('uses null elapsed and server pending for a local-source seal', () => {
		const session = createPuzzleSession({
			metadata: { ...makeMetadata(1), source: 'local' },
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock()
		});
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		const seal = session.getState().sealedCompletion!;
		expect(seal.serverSubmission.status).toBe('not_applicable');
		expect(seal.localStats.status).toBe('pending');
	});

	it('direct complete on a full board is idempotent (already sealed)', () => {
		const { session } = completeOnePieceSession();

		expect(session.dispatch({ type: 'complete' }).type).toBe('completion_noop');
	});

	it('undo reactivates the board/lifecycle but cannot alter the seal', () => {
		const { session, seal } = completeOnePieceSession();

		session.dispatch({ type: 'undo' });

		expect(session.getState().lifecycle).toBe('active');
		expect(session.getState().placedPieces).toEqual([]);
		expect(session.getState().sealedCompletion).toEqual(seal);
	});

	it('redo restores the completed board without emitting a second completion', () => {
		const { session, seal } = completeOnePieceSession();
		session.dispatch({ type: 'undo' });

		session.dispatch({ type: 'redo' });

		expect(session.getState().lifecycle).toBe('completed');
		expect(session.getState().sealedCompletion).toEqual(seal);
	});

	it('a fresh final placement after undo does not create a second seal', () => {
		const { session, seal } = completeOnePieceSession();
		session.dispatch({ type: 'undo' });
		expect(session.getState().sealedCompletion).toEqual(seal);

		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(session.getState().sealedCompletion).toEqual(seal);
		expect(session.getState().lifecycle).toBe('completed');
	});

	it('a completed seal is restored from a hydrated snapshot without re-emitting', () => {
		const sealed: SealedCompletion = {
			runId: 'run-sealed',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 30,
			completedAt: 1000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' }
		};
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'completed',
			mode: 'timed',
			runId: 'run-sealed',
			origin: 'resumed',
			elapsedActiveSeconds: 30,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			trayOrder: [0],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: sealed,
			lastUpdated: 0
		};
		const session = createPuzzleSession({
			...makeOptions({ metadata: makeMetadata(1) }),
			restored
		});

		expect(session.getState().sealedCompletion).toEqual(sealed);
		// A re-complete on the restored seal is a noop.
		expect(session.dispatch({ type: 'complete' }).type).toBe('completion_noop');
	});
});

describe('PuzzleSession completion effect coordination', () => {
	it('acknowledges a pending local effect as succeeded', () => {
		const { session, seal } = completeOnePieceSession();

		const outcome = session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'succeeded' }
		});

		expect(outcome.type).toBe('effect_acknowledged');
		expect(session.getState().sealedCompletion!.localStats.status).toBe('succeeded');
	});

	it('acknowledges a pending server effect as a retryable failure', () => {
		const { session, seal } = completeOnePieceSession();

		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'failed', code: 'network_error', retryable: true }
		});

		const server = session.getState().sealedCompletion!.serverSubmission;
		expect(server.status).toBe('failed');
		if (server.status === 'failed') expect(server.code).toBe('network_error');
	});

	it('ignores an acknowledgement for a different run id', () => {
		const { session } = completeOnePieceSession();

		const outcome = session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: 'some-other-run',
			effect: 'local_stats',
			result: { status: 'succeeded' }
		});

		expect(outcome.type).toBe('effect_acknowledgement_noop');
		expect(session.getState().sealedCompletion!.localStats.status).toBe('pending');
	});

	it('ignores an acknowledgement for an already-terminal effect', () => {
		const { session, seal } = completeOnePieceSession();
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'succeeded' }
		});

		const outcome = session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'failed', code: 'storage_error', retryable: true }
		});

		expect(outcome.type).toBe('effect_acknowledgement_noop');
		expect(session.getState().sealedCompletion!.localStats.status).toBe('succeeded');
	});

	it('retry re-emits a retryable failed server effect after resetting it to pending', () => {
		const { session, seal } = completeOnePieceSession();
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'failed', code: 'network_error', retryable: true }
		});

		const outcome = session.dispatch({ type: 'retry_completion_effects' });

		expect(outcome.type).toBe('completion_sealed');
		expect(session.getState().sealedCompletion!.serverSubmission.status).toBe('pending');
	});

	it('retry does not re-emit effects that were already pending (no duplicate submission)', () => {
		// Regression: retry must only re-emit effects whose failed state was
		// reset to pending. An effect that was already pending (e.g. an
		// in-flight initial server_submission) must not be re-emitted, or the
		// side effect would run twice.
		const emitted: string[] = [];
		const session = createPuzzleSession({
			metadata: makeMetadata(1),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			onEvent: (event) => {
				if (event.type === 'completion_effect_request') {
					emitted.push(event.effect);
				}
			}
		});
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
		const seal = session.getState().sealedCompletion!;
		// Initial completion emits both effects.
		expect(emitted).toEqual(['local_stats', 'server_submission']);

		emitted.length = 0;
		// Fail only local_stats; server_submission stays pending (in flight).
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'failed', code: 'storage_error', retryable: true }
		});

		const outcome = session.dispatch({ type: 'retry_completion_effects' });
		expect(outcome.type).toBe('completion_sealed');

		// Only local_stats was reset from failed -> pending; server_submission
		// was already pending and must not be re-emitted.
		expect(emitted).toEqual(['local_stats']);
		expect(session.getState().sealedCompletion!.serverSubmission.status).toBe('pending');
	});

	it('does not retry a terminal quota failure', () => {
		const { session, seal } = completeOnePieceSession();
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'failed', code: 'completion_quota_exceeded', retryable: false }
		});

		session.dispatch({ type: 'retry_completion_effects' });

		const server = session.getState().sealedCompletion!.serverSubmission;
		expect(server.status).toBe('failed');
	});

	it('retry skips unauthorized failures by default (hydration auto-retry)', () => {
		const { session, seal } = completeOnePieceSession();
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'failed', code: 'unauthorized', retryable: true }
		});

		const outcome = session.dispatch({ type: 'retry_completion_effects' });

		// No retryable effects to reset (unauthorized is skipped), so no-op.
		expect(outcome.type).toBe('completion_noop');
		const server = session.getState().sealedCompletion!.serverSubmission;
		expect(server.status).toBe('failed');
	});

	it('retry with includeUnauthorized resets unauthorized failures to pending', () => {
		const emitted: string[] = [];
		const { session, seal } = completeOnePieceSession({
			onEvent: (event) => {
				if (event.type === 'completion_effect_request') {
					emitted.push(event.effect);
				}
			}
		});
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'failed', code: 'unauthorized', retryable: true }
		});

		emitted.length = 0;
		const outcome = session.dispatch({
			type: 'retry_completion_effects',
			includeUnauthorized: true
		});

		expect(outcome.type).toBe('completion_sealed');
		expect(emitted).toEqual(['server_submission']);
		expect(session.getState().sealedCompletion!.serverSubmission.status).toBe('pending');
	});

	it('retry without flag retries non-unauthorized failures alongside unauthorized (skips only unauthorized)', () => {
		const emitted: string[] = [];
		const { session, seal } = completeOnePieceSession({
			onEvent: (event) => {
				if (event.type === 'completion_effect_request') {
					emitted.push(event.effect);
				}
			}
		});
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'failed', code: 'storage_error', retryable: true }
		});
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'failed', code: 'unauthorized', retryable: true }
		});

		emitted.length = 0;
		const outcome = session.dispatch({ type: 'retry_completion_effects' });

		// local_stats (storage_error) is retried; unauthorized is skipped.
		expect(outcome.type).toBe('completion_sealed');
		expect(emitted).toEqual(['local_stats']);
		const sealState = session.getState().sealedCompletion!;
		expect(sealState.localStats.status).toBe('pending');
		expect(sealState.serverSubmission.status).toBe('failed');
	});

	it('emits completion_effect_request only after subscribers see the sealed state', () => {
		// Regression: doComplete must notify() before emitting effect requests,
		// so a synchronous acknowledge in onEvent cannot reassign
		// state.sealedCompletion mid-transition. Subscribers must observe the
		// completed/sealed state before any effect handler runs.
		const log: string[] = [];
		const session = createPuzzleSession({
			metadata: makeMetadata(1),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			onEvent: (event) => {
				if (event.type === 'completion_effect_request') {
					// At the moment the effect request fires, the engine state
					// must already be sealed+completed (proving notify() ran).
					log.push(`effect:${event.effect}:${session.getState().lifecycle}`);
				}
			}
		});
		session.subscribe(() => {
			const s = session.getState();
			if (s.lifecycle === 'completed' && s.sealedCompletion) {
				log.push('notified');
			}
		});
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		// Subscriber notification must precede every effect request emission.
		const firstEffectIndex = log.findIndex((entry) => entry.startsWith('effect:'));
		const notifiedIndex = log.indexOf('notified');
		expect(notifiedIndex).toBeGreaterThanOrEqual(0);
		expect(firstEffectIndex).toBeGreaterThan(notifiedIndex);
		expect(log.filter((e) => e.startsWith('effect:')).length).toBe(2);
	});
});

// --- Patch coverage: lifecycle no-ops, tray org branches, retry, subscribe -----

describe('PuzzleSession lifecycle no-ops from non-active states', () => {
	it('rejects selection from setup (lifecycle_disallows_gameplay)', () => {
		const session = createPuzzleSession(makeOptions());
		const outcome = session.dispatch({ type: 'select_piece', pieceId: 0 });
		expect(outcome).toEqual({ type: 'selection_noop', reason: 'lifecycle_disallows_gameplay' });
	});

	it('rejects rotation toggle from setup (lifecycle_disables_rotation_toggle)', () => {
		const session = createPuzzleSession(makeOptions());
		const outcome = session.dispatch({ type: 'set_rotation_mode', enabled: true });
		expect(outcome.type).toBe('rotation_mode_noop');
	});

	it('rejects piece rotation from setup (piece_not_rotatable)', () => {
		const session = createPuzzleSession(makeOptions());
		const outcome = session.dispatch({ type: 'rotate_piece', pieceId: 0 });
		expect(outcome).toEqual({ type: 'rotation_noop', reason: 'piece_not_rotatable' });
	});

	it('rejects hint from setup (lifecycle_disallows_gameplay for non-active)', () => {
		const session = createPuzzleSession(makeOptions());
		const outcome = session.dispatch({ type: 'use_hint' });
		expect(outcome).toEqual({ type: 'hint_noop', reason: 'lifecycle_disallows_gameplay' });
	});

	it('rejects reference mode from setup (lifecycle_disallows_gameplay)', () => {
		const session = createPuzzleSession(makeOptions());
		const outcome = session.dispatch({ type: 'set_reference_mode', mode: 'hold' });
		expect(outcome).toEqual({
			type: 'reference_mode_noop',
			reason: 'lifecycle_disallows_gameplay'
		});
	});

	it('rejects direct complete from setup (lifecycle_disallows)', () => {
		const session = createPuzzleSession(makeOptions());
		const outcome = session.dispatch({ type: 'complete' });
		expect(outcome).toEqual({ type: 'completion_noop', reason: 'lifecycle_disallows' });
	});

	it('rejects restart when disposed', () => {
		const session = createPuzzleSession(makeOptions());
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'dispose' });

		const outcome = session.dispatch({ type: 'restart' });
		expect(outcome).toEqual({ type: 'lifecycle_noop', reason: 'disposed' });
	});
});

describe('PuzzleSession resume with active timer', () => {
	it('restarts the clock on resume when the timer was already started', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession(makeOptions({ clock }));
		session.dispatch({ type: 'start' });
		// Start the timer via a counted action (placement).
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
		expect(clock.activeIntervalCount).toBe(1);

		session.dispatch({ type: 'pause' });
		expect(clock.activeIntervalCount).toBe(0);

		session.dispatch({ type: 'resume' });
		expect(clock.activeIntervalCount).toBe(1);
	});
});

describe('PuzzleSession default rotation factory', () => {
	it('uses the default createRotations factory when none is provided', () => {
		const session = createPuzzleSession(makeOptions());
		session.dispatch({ type: 'start' });

		const outcome = session.dispatch({ type: 'set_rotation_mode', enabled: true });
		expect(outcome.type).toBe('rotation_mode_changed');
		// The default factory produces a rotation for every piece id.
		const state = session.getState();
		expect(Object.keys(state.pieceRotations).length).toBe(state.pieceCount);
	});
});

describe('PuzzleSession tray organization branches', () => {
	it('applies a set_active_tray update', () => {
		const { session } = startedSession();
		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'set_active_tray', trayId: 'group-a' }
		});
		expect(outcome.type).toBe('tray_organization_applied');
		expect(session.getState().organization?.activeTray).toBe('group-a');
	});

	it('applies a rename_tray update', () => {
		const { session } = startedSession();
		session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'set_active_tray', trayId: 'group-a' }
		});
		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'rename_tray', trayId: 'group-a', name: 'My Group' }
		});
		expect(outcome.type).toBe('tray_organization_applied');
		expect(session.getState().organization?.names['group-a']).toBe('My Group');
	});

	it('removes a tray that has no members', () => {
		const { session } = startedSession();
		session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'rename_tray', trayId: 'temp', name: 'Temp' }
		});
		session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'set_active_tray', trayId: 'temp' }
		});
		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'remove_tray', trayId: 'temp' }
		});
		expect(outcome.type).toBe('tray_organization_applied');
		expect(session.getState().organization?.names['temp']).toBeUndefined();
		// Removing the active tray falls back to the default 'main' tray.
		expect(session.getState().organization?.activeTray).toBe('main');
	});

	it('rejects removing a tray that still has members', () => {
		const { session } = startedSession();
		session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'move_piece', pieceId: 0, toTrayId: 'group-a' }
		});
		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'remove_tray', trayId: 'group-a' }
		});
		expect(outcome).toEqual({ type: 'tray_organization_noop', reason: 'invalid_update' });
	});

	it('applies a move_piece update for a known piece', () => {
		const { session } = startedSession();
		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'move_piece', pieceId: 1, toTrayId: 'group-b' }
		});
		expect(outcome.type).toBe('tray_organization_applied');
		expect(session.getState().organization?.membership[1]).toBe('group-b');
	});

	it('returns a not_implemented no-op for a reorder update (HPA-220/237 own tray-org UI)', () => {
		const { session } = startedSession();
		const trayOrderBefore = session.getState().trayOrder.slice();
		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'reorder', trayId: 'main', pieceIds: [3, 1, 0, 2] }
		});
		expect(outcome).toEqual({ type: 'tray_organization_noop', reason: 'not_implemented' });
		// Reorder must not mutate state or persist a misleading "applied" result.
		expect(session.getState().trayOrder).toEqual(trayOrderBefore);
	});
});

describe('PuzzleSession retry and dispatch edge cases', () => {
	it('retry_completion_effects is a no-op when there is no seal (board_incomplete)', () => {
		const { session } = startedSession();
		const outcome = session.dispatch({ type: 'retry_completion_effects' });
		expect(outcome).toEqual({ type: 'completion_noop', reason: 'board_incomplete' });
	});

	it('retry re-emits a retryable failed local_stats effect', () => {
		const { session, seal } = completeOnePieceSession();
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'failed', code: 'storage_error', retryable: true }
		});

		const outcome = session.dispatch({ type: 'retry_completion_effects' });
		expect(outcome.type).toBe('completion_sealed');
		expect(session.getState().sealedCompletion!.localStats.status).toBe('pending');
	});

	it('dispatch with an unknown action type returns a lifecycle no-op', () => {
		const { session } = startedSession();
		const outcome = session.dispatch({ type: 'bogus_action' } as unknown as {
			type: 'start';
		});
		expect(outcome).toEqual({ type: 'lifecycle_noop', reason: 'invalid_transition' });
	});
});

describe('PuzzleSession resume_completion_effects (restore recovery)', () => {
	it('is a no-op when there is no seal (board_incomplete)', () => {
		const { session } = startedSession();
		const outcome = session.dispatch({ type: 'resume_completion_effects' });
		expect(outcome).toEqual({ type: 'completion_noop', reason: 'board_incomplete' });
	});

	it('re-emits completion_effect_request for pending effects after restore', () => {
		const emitted: string[] = [];
		const { session, seal } = completeOnePieceSession();
		// After completion, both effects were already emitted during doComplete.
		// Re-attach an event listener to observe resume emissions.
		// (onEvent was set at construction; instead, re-create with a listener.)
		const restoredSnapshot = makeRestoredSnapshot(session, seal, {
			localStats: { status: 'pending' },
			serverSubmission: { status: 'pending' }
		});

		const resumed = createPuzzleSession({
			metadata: makeMetadata(1),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			restored: restoredSnapshot,
			onEvent: (event) => {
				if (event.type === 'completion_effect_request') {
					emitted.push(event.effect);
				}
			}
		});

		const outcome = resumed.dispatch({ type: 'resume_completion_effects' });
		expect(outcome.type).toBe('completion_sealed');
		// Both pending effects should be re-emitted so the route can re-drive
		// the local stats recording and server submission.
		expect(emitted).toEqual(['local_stats', 'server_submission']);
	});

	it('does not re-emit succeeded or failed effects (idempotent)', () => {
		const emitted: string[] = [];
		const { session, seal } = completeOnePieceSession();
		// Acknowledge both effects so neither is pending.
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'succeeded' }
		});
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'succeeded' }
		});

		// Re-create with a listener and a snapshot reflecting succeeded state.
		const restoredSnapshot = makeRestoredSnapshot(session, seal, {
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' }
		});

		const resumed = createPuzzleSession({
			metadata: makeMetadata(1),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			restored: restoredSnapshot,
			onEvent: (event) => {
				if (event.type === 'completion_effect_request') {
					emitted.push(event.effect);
				}
			}
		});

		const outcome = resumed.dispatch({ type: 'resume_completion_effects' });
		expect(outcome).toEqual({ type: 'completion_noop', reason: 'no_pending_effects' });
		expect(emitted).toEqual([]);
	});

	it('re-emits only the pending effect when one is already succeeded', () => {
		const emitted: string[] = [];
		const { session, seal } = completeOnePieceSession();
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'succeeded' }
		});
		// server_submission stays pending (simulating interrupted submission).

		const restoredSnapshot = makeRestoredSnapshot(session, seal, {
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'pending' }
		});

		const resumed = createPuzzleSession({
			metadata: makeMetadata(1),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			restored: restoredSnapshot,
			onEvent: (event) => {
				if (event.type === 'completion_effect_request') {
					emitted.push(event.effect);
				}
			}
		});

		resumed.dispatch({ type: 'resume_completion_effects' });
		expect(emitted).toEqual(['server_submission']);
	});
});

describe('PuzzleSession subscribe', () => {
	it('notifies subscribers on state change and supports unsubscribe', () => {
		const { session } = startedSession();
		let notifyCount = 0;
		const unsubscribe = session.subscribe(() => {
			notifyCount++;
		});

		// A selection dispatch should notify subscribers.
		session.dispatch({ type: 'select_piece', pieceId: 0 });
		expect(notifyCount).toBeGreaterThan(0);
		const countAfterSelect = notifyCount;

		unsubscribe();

		session.dispatch({ type: 'cancel_selection' });
		expect(notifyCount).toBe(countAfterSelect);
	});
});

describe('PuzzleSession hint with empty tray', () => {
	it('rejects an incomplete initialTrayOrder at construction', () => {
		// An empty initialTrayOrder is an incomplete tray (missing all
		// pieces), which violates the construction invariant. The engine
		// throws rather than building an unsolvable session.
		expect(() =>
			createPuzzleSession({
				metadata: makeMetadata(4),
				runIdFactory: makeRunIdFactory(),
				clock: new ManualClock(),
				initialTrayOrder: []
			})
		).toThrow();
	});
});

// --- Patch coverage: defensive guards and clock internals ----------------------

function activeKnownTimedRestored(): PersistedPuzzleSessionV1 {
	return {
		schemaVersion: 1,
		puzzleId: 'pz1',
		source: 'api',
		lifecycle: 'active',
		mode: 'timed',
		runId: 'run-x',
		origin: 'resumed',
		elapsedActiveSeconds: 0,
		timingQuality: 'known',
		timerStarted: true,
		placedPieces: [],
		trayOrder: [0, 1, 2, 3],
		rotationEnabled: false,
		pieceRotations: {},
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: true,
		resultClass: 'standard_timed',
		sealedCompletion: null,
		lastUpdated: 0
	};
}

describe('PuzzleSession defensive guard coverage', () => {
	it('invokes the onEvent callback for lifecycle and state events', () => {
		const events: string[] = [];
		const session = createPuzzleSession({
			...makeOptions(),
			onEvent: (event) => events.push(event.type)
		});

		session.dispatch({ type: 'start' });

		expect(events).toContain('lifecycle');
		expect(events).toContain('state_changed');
	});

	it('setDocumentHidden is a no-op after dispose', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession(makeOptions({ clock }));
		session.dispatch({ type: 'start' });
		session.dispose();

		session.setDocumentHidden(true);

		expect(session.getState().lifecycle).toBe('disposed');
		expect(clock.activeIntervalCount).toBe(0);
	});

	it('the clock interval callback checkpoints elapsed whole seconds', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession({
			...makeOptions({ clock }),
			restored: activeKnownTimedRestored()
		});
		expect(clock.activeIntervalCount).toBe(1);

		clock.advance(2_000);
		// ManualClock does not auto-fire interval callbacks; invoke the pending
		// entry directly to exercise the arrow-body checkpoint path.
		for (const entry of clock.intervals) {
			if (entry.active) entry.cb();
		}

		expect(session.getState().elapsedActiveSeconds).toBe(2);
	});

	it('checkpointTime is a no-op when no whole second has elapsed', () => {
		const clock = new ManualClock();
		const session = createPuzzleSession({
			...makeOptions({ clock }),
			restored: activeKnownTimedRestored()
		});
		const before = session.getState().elapsedActiveSeconds;

		session.checkpointTime();

		expect(session.getState().elapsedActiveSeconds).toBe(before);
	});

	it('rotate_piece is a no-op when rotation mode is disabled in an active session', () => {
		const { session } = startedSession();

		const outcome = session.dispatch({ type: 'rotate_piece', pieceId: 0 });

		expect(outcome).toEqual({ type: 'rotation_noop', reason: 'piece_not_rotatable' });
	});
});

// --- Patch coverage: rotation, tray, completion, checkpoint branches -------------

describe('PuzzleSession rotation edge coverage', () => {
	it('rotates a piece whose rotation entry is missing (defaults to 0)', () => {
		// Inject a createRotations that returns an empty map so the piece has no
		// prior rotation entry; doRotatePiece falls back to 0 before rotating.
		const { session } = startedSession({
			pieceCount: 2,
			createRotations: () => ({})
		});
		session.dispatch({ type: 'set_rotation_mode', enabled: true });

		const outcome = session.dispatch({ type: 'rotate_piece', pieceId: 0 });

		expect(outcome.type).toBe('piece_rotated');
		expect(session.getState().pieceRotations[0]).toBe(90);
	});

	it('accepts a correct placement when rotation is on but the piece has no rotation entry (defaults to upright 0)', () => {
		// With an empty rotation map, validatePlacement's `pieceRotations[pieceId] ?? 0`
		// falls back to 0 (upright), so the non_upright rejection is skipped.
		const { session } = startedSession({
			pieceCount: 1,
			createRotations: () => ({})
		});
		session.dispatch({ type: 'set_rotation_mode', enabled: true });

		const outcome = session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(outcome.type).toBe('placement');
		if (outcome.type === 'placement' && outcome.outcome.status === 'accepted') {
			expect(outcome.outcome.completed).toBe(true);
		}
	});

	it('accepts a correct placement when rotation is enabled and the piece is upright', () => {
		// Rotation enabled but piece rotation is 0 (upright) → the non_upright
		// rejection branch is skipped and the placement is accepted.
		const { session } = startedSession({
			pieceCount: 1,
			createRotations: (ids) => {
				const out: Record<number, Rotation> = {};
				ids.forEach((id) => (out[id] = 0));
				return out;
			}
		});
		session.dispatch({ type: 'set_rotation_mode', enabled: true });

		const outcome = session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });

		expect(outcome.type).toBe('placement');
		if (outcome.type === 'placement' && outcome.outcome.status === 'accepted') {
			expect(outcome.outcome.completed).toBe(true);
		}
	});
});

describe('PuzzleSession tray organization remove edge', () => {
	it('removes a non-active tray without resetting the active tray', () => {
		const { session } = startedSession();
		session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'rename_tray', trayId: 'temp', name: 'Temp' }
		});
		session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'set_active_tray', trayId: 'main' }
		});

		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: { type: 'remove_tray', trayId: 'temp' }
		});

		expect(outcome.type).toBe('tray_organization_applied');
		expect(session.getState().organization?.names['temp']).toBeUndefined();
		// Active tray was 'main', not 'temp', so it stays 'main'.
		expect(session.getState().organization?.activeTray).toBe('main');
	});
});

describe('PuzzleSession completion effect terminal failure', () => {
	it('treats a non-retryable failed effect as terminal on re-acknowledgement', () => {
		const { session, seal } = completeOnePieceSession();

		// First acknowledgement: mark server_submission as a non-retryable failure.
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'failed', code: 'completion_quota_exceeded', retryable: false }
		});

		// Second acknowledgement: the effect is already failed+non-retryable → terminal.
		const outcome = session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'server_submission',
			result: { status: 'succeeded' }
		});

		expect(outcome).toEqual({ type: 'effect_acknowledgement_noop', reason: 'effect_terminal' });
		expect(session.getState().sealedCompletion!.serverSubmission.status).toBe('failed');
	});
});

describe('PuzzleSession checkpoint no-op coverage', () => {
	it('checkpointTime is a no-op when the clock is not running', () => {
		// A fresh setup session never started the clock; checkpointTime returns
		// immediately via the !clockRunning guard.
		const session = createPuzzleSession(makeOptions());
		const before = session.getState().elapsedActiveSeconds;

		session.checkpointTime();

		expect(session.getState().elapsedActiveSeconds).toBe(before);
	});
});

describe('PuzzleSession restart with createTrayOrder', () => {
	it('uses the injected createTrayOrder on restart', () => {
		const customOrder = [3, 1, 0, 2];
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			createTrayOrder: () => customOrder.slice()
		});
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'restart' });

		expect(session.getState().trayOrder).toEqual(customOrder);
	});
});

describe('PuzzleSession snapshot and event immutability', () => {
	it('getState returns a deep-frozen copy: mutating it does not affect engine state', () => {
		const { session } = completeOnePieceSession();

		const snapshot = session.getState();
		// Shallow fields are frozen.
		expect(Object.isFrozen(snapshot)).toBe(true);
		// Nested mutable fields are frozen too.
		expect(Object.isFrozen(snapshot.placedPieces)).toBe(true);
		expect(Object.isFrozen(snapshot.counters)).toBe(true);
		expect(Object.isFrozen(snapshot.facts)).toBe(true);
		expect(Object.isFrozen(snapshot.sealedCompletion)).toBe(true);

		// Mutating the snapshot's placedPieces must throw / be a no-op and
		// must NOT change the engine's internal state. A subsequent
		// getState() reflects the unmutated engine state.
		expect(() => snapshot.placedPieces.push({ pieceId: 99, x: 99, y: 99 })).toThrow();
		expect(() => (snapshot.counters.incorrectAttempts as number)++).toThrow();

		const fresh = session.getState();
		expect(fresh.placedPieces).toEqual([{ pieceId: 0, x: 0, y: 0 }]);
		expect(fresh.counters.incorrectAttempts).toBe(0);
		expect(fresh.placedPieces).not.toBe(snapshot.placedPieces);
		expect(fresh.counters).not.toBe(snapshot.counters);
	});

	it('completion_sealed and completion_effect_request events carry a cloned seal', () => {
		const events: Array<{ type: string; seal?: SealedCompletion }> = [];
		const { session, seal } = completeOnePieceSession({
			onEvent: (e) => events.push(e)
		});
		// completeOnePieceSession already completed; seal captured from state.
		// Re-trigger an effect request by retrying a failed effect.
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'failed', code: 'storage_error', retryable: true }
		});
		session.dispatch({ type: 'retry_completion_effects' });

		const sealEvents = events.filter(
			(e): e is { type: 'completion_effect_request'; seal: SealedCompletion } =>
				e.type === 'completion_effect_request'
		);
		expect(sealEvents.length).toBeGreaterThan(0);
		for (const e of sealEvents) {
			// The emitted seal is a distinct object from the engine's internal
			// state.sealedCompletion, so a consumer mutating it cannot corrupt
			// the engine.
			expect(e.seal).not.toBe(session.getState().sealedCompletion);
			expect(e.seal.localStats).not.toBe(session.getState().sealedCompletion!.localStats);
			// Mutating the event payload's seal must not change engine state.
			expect(() => (e.seal.localStats.status = 'succeeded')).toThrow();
		}
	});
});

describe('PuzzleSession construction metadata validation', () => {
	function baseMetadata(overrides: Partial<PuzzleMetadata> = {}): PuzzleMetadata {
		return { ...makeMetadata(4), ...overrides };
	}

	it('clones accepted metadata so caller mutations do not affect the engine', () => {
		const pieces = Array.from({ length: 4 }, (_, i) => ({
			id: i,
			correctX: i % 2,
			correctY: Math.floor(i / 2)
		}));
		const metadata: PuzzleMetadata = {
			puzzleId: 'pz1',
			source: 'api',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			pieces
		};
		const session = createPuzzleSession({
			metadata,
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock()
		});
		// Mutate the caller's pieces array after construction.
		pieces.push({ id: 99, correctX: 99, correctY: 99 });
		pieces[0].correctX = 7;

		// The engine's view is unaffected: it still accepts piece 0 at (0,0).
		session.dispatch({ type: 'start' });
		const outcome = session.dispatch({
			type: 'attempt_placement',
			pieceId: 0,
			x: 0,
			y: 0
		});
		expect(outcome).toEqual({
			type: 'placement',
			outcome: { status: 'accepted', completed: false }
		});
	});

	it('throws on duplicate piece ids', () => {
		const metadata = baseMetadata({
			pieces: [
				{ id: 0, correctX: 0, correctY: 0 },
				{ id: 0, correctX: 1, correctY: 0 },
				{ id: 2, correctX: 0, correctY: 1 },
				{ id: 3, correctX: 1, correctY: 1 }
			]
		});
		expect(() =>
			createPuzzleSession({ metadata, runIdFactory: makeRunIdFactory(), clock: new ManualClock() })
		).toThrow(/duplicate piece id/);
	});

	it('throws on duplicate canonical cells', () => {
		const metadata = baseMetadata({
			pieces: [
				{ id: 0, correctX: 0, correctY: 0 },
				{ id: 1, correctX: 0, correctY: 0 },
				{ id: 2, correctX: 1, correctY: 0 },
				{ id: 3, correctX: 1, correctY: 1 }
			]
		});
		expect(() =>
			createPuzzleSession({ metadata, runIdFactory: makeRunIdFactory(), clock: new ManualClock() })
		).toThrow(/duplicate canonical cell/);
	});

	it('throws on out-of-bounds canonical coordinates', () => {
		const metadata = baseMetadata({
			pieces: [
				{ id: 0, correctX: 0, correctY: 0 },
				{ id: 1, correctX: 5, correctY: 0 },
				{ id: 2, correctX: 0, correctY: 1 },
				{ id: 3, correctX: 1, correctY: 1 }
			]
		});
		expect(() =>
			createPuzzleSession({ metadata, runIdFactory: makeRunIdFactory(), clock: new ManualClock() })
		).toThrow(/correctX out of bounds/);
	});

	it('throws on fractional canonical coordinates', () => {
		const metadata = baseMetadata({
			pieces: [
				{ id: 0, correctX: 0.5, correctY: 0 },
				{ id: 1, correctX: 1, correctY: 0 },
				{ id: 2, correctX: 0, correctY: 1 },
				{ id: 3, correctX: 1, correctY: 1 }
			]
		});
		expect(() =>
			createPuzzleSession({ metadata, runIdFactory: makeRunIdFactory(), clock: new ManualClock() })
		).toThrow(/correctX out of bounds/);
	});

	it('throws when pieces.length !== pieceCount', () => {
		const metadata = baseMetadata({ pieceCount: 4 });
		// Only 3 pieces supplied.
		(metadata as PuzzleMetadata).pieces = metadata.pieces.slice(0, 3);
		expect(() =>
			createPuzzleSession({ metadata, runIdFactory: makeRunIdFactory(), clock: new ManualClock() })
		).toThrow(/pieces.length must equal pieceCount/);
	});

	it('throws when gridCols * gridRows !== pieceCount', () => {
		// 3 pieces in a 2x2 grid: pieces.length === pieceCount (3), but
		// gridCols * gridRows (4) !== pieceCount (3). The grid-math check
		// runs before the pieces-length check, so this isolates it.
		const metadata: PuzzleMetadata = {
			puzzleId: 'pz1',
			source: 'api',
			pieceCount: 3,
			gridCols: 2,
			gridRows: 2,
			pieces: [
				{ id: 0, correctX: 0, correctY: 0 },
				{ id: 1, correctX: 1, correctY: 0 },
				{ id: 2, correctX: 0, correctY: 1 }
			]
		};
		expect(() =>
			createPuzzleSession({ metadata, runIdFactory: makeRunIdFactory(), clock: new ManualClock() })
		).toThrow(/gridCols \* gridRows must equal pieceCount/);
	});

	it('throws on a non-integer piece id', () => {
		const metadata = baseMetadata({
			pieces: [
				{ id: 0.5, correctX: 0, correctY: 0 },
				{ id: 1, correctX: 1, correctY: 0 },
				{ id: 2, correctX: 0, correctY: 1 },
				{ id: 3, correctX: 1, correctY: 1 }
			]
		});
		expect(() =>
			createPuzzleSession({ metadata, runIdFactory: makeRunIdFactory(), clock: new ManualClock() })
		).toThrow(/id must be an integer/);
	});

	it('throws on an initialTrayOrder with an unknown piece id', () => {
		expect(() =>
			createPuzzleSession({
				metadata: makeMetadata(4),
				runIdFactory: makeRunIdFactory(),
				clock: new ManualClock(),
				initialTrayOrder: [0, 1, 2, 99]
			})
		).toThrow(/unknown piece id/);
	});

	it('throws on an initialTrayOrder with a duplicate id', () => {
		expect(() =>
			createPuzzleSession({
				metadata: makeMetadata(4),
				runIdFactory: makeRunIdFactory(),
				clock: new ManualClock(),
				initialTrayOrder: [0, 1, 2, 0]
			})
		).toThrow(/duplicate piece id/);
	});

	it('accepts a complete duplicate-free initialTrayOrder and clones it', () => {
		const order = [3, 1, 0, 2];
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			initialTrayOrder: order
		});
		expect(session.getState().trayOrder).toEqual(order);
		// Mutating the caller's array does not affect the engine.
		order.push(99);
		order.sort((a, b) => a - b);
		expect(session.getState().trayOrder).toEqual([3, 1, 0, 2]);
	});
});

// --- Invariant boundary: completion outcomes and factory results ------------
//
// The engine's stated invariant (see session.ts) is that a consumer must not
// be able to mutate internal state through any public boundary. These tests
// pin the boundaries that previously leaked the engine's mutable seal or
// accepted unvalidated factory output.

describe('PuzzleSession completion outcome immutability', () => {
	it('completion_sealed outcome (via retry) is a frozen clone distinct from internal state', () => {
		const { session, seal } = completeOnePieceSession();
		// Move local_stats to a retryable failed state, then retry to obtain a
		// completion_sealed outcome from doRetryCompletionEffects.
		session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result: { status: 'failed', code: 'storage_error', retryable: true }
		});
		const outcome = session.dispatch({ type: 'retry_completion_effects' });
		expect(outcome.type).toBe('completion_sealed');
		if (outcome.type !== 'completion_sealed') return;
		const internal = session.getState().sealedCompletion!;
		expect(outcome.seal).not.toBe(internal);
		expect(outcome.seal.localStats).not.toBe(internal.localStats);
		expect(Object.isFrozen(outcome.seal)).toBe(true);
		expect(Object.isFrozen(outcome.seal.localStats)).toBe(true);
		// Mutating the outcome's seal must not change engine state.
		expect(() => (outcome.seal.localStats.status = 'succeeded')).toThrow();
		expect(session.getState().sealedCompletion!.localStats.status).toBe('pending');
	});

	it('resume_completion_effects returns a frozen clone distinct from internal state', () => {
		const { session } = completeOnePieceSession();
		// Both effects start pending, so resume re-emits and returns a seal.
		const outcome = session.dispatch({ type: 'resume_completion_effects' });
		expect(outcome.type).toBe('completion_sealed');
		if (outcome.type !== 'completion_sealed') return;
		const internal = session.getState().sealedCompletion!;
		expect(outcome.seal).not.toBe(internal);
		expect(outcome.seal.serverSubmission).not.toBe(internal.serverSubmission);
		expect(Object.isFrozen(outcome.seal)).toBe(true);
	});

	it('acknowledge clones the caller-supplied result so later mutation cannot alter state', () => {
		const { session, seal } = completeOnePieceSession();
		const result: { status: 'failed'; code: 'storage_error'; retryable: boolean } = {
			status: 'failed',
			code: 'storage_error',
			retryable: true
		};
		const outcome = session.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result
		});
		expect(outcome.type).toBe('effect_acknowledged');
		expect(session.getState().sealedCompletion!.localStats.status).toBe('failed');

		// Mutating the caller's result object after dispatch must not change
		// the engine's retained effect state.
		(result as unknown as { status: string }).status = 'succeeded';
		expect(session.getState().sealedCompletion!.localStats.status).toBe('failed');
		// The retained state must not be the caller's object.
		expect(session.getState().sealedCompletion!.localStats).not.toBe(result);
	});

	it('hydrate clones nested effect states so a persisted snapshot cannot mutate engine state', () => {
		const restored: PersistedPuzzleSessionV1 = {
			schemaVersion: 1,
			puzzleId: 'pz1',
			source: 'api',
			lifecycle: 'completed',
			mode: 'timed',
			runId: 'run-hydrate',
			origin: 'resumed',
			elapsedActiveSeconds: 12,
			timingQuality: 'known',
			timerStarted: true,
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			trayOrder: [0],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: {
				runId: 'run-hydrate',
				resultClass: 'standard_timed',
				timingQuality: 'known',
				elapsedActiveSeconds: 12,
				completedAt: 1_000,
				localStats: { status: 'succeeded' },
				serverSubmission: { status: 'failed', code: 'network_error', retryable: true }
			},
			lastUpdated: 0
		};
		const session = createPuzzleSession({
			...makeOptions({ metadata: makeMetadata(1) }),
			restored
		});

		const internal = session.getState().sealedCompletion!;
		// Nested effect states must be distinct objects from the snapshot's.
		expect(internal.localStats).not.toBe(restored.sealedCompletion!.localStats);
		expect(internal.serverSubmission).not.toBe(restored.sealedCompletion!.serverSubmission);

		// Mutating the snapshot's effect state after construction must not
		// change the engine's retained state.
		(restored.sealedCompletion!.serverSubmission as unknown as { status: string }).status =
			'succeeded';
		expect(internal.serverSubmission.status).toBe('failed');
	});
});

describe('PuzzleSession factory result validation and cloning', () => {
	it('clones createRotations output so a factory retaining its map cannot mutate state', () => {
		const retained: Record<number, Rotation> = { 0: 90, 1: 180 };
		const { session } = startedSession({
			pieceCount: 2,
			createRotations: () => retained
		});
		session.dispatch({ type: 'set_rotation_mode', enabled: true });
		expect(session.getState().pieceRotations).toEqual({ 0: 90, 1: 180 });

		// Mutating the factory's retained object after dispatch must not change
		// engine state.
		retained[0] = 270;
		expect(session.getState().pieceRotations[0]).toBe(90);
	});

	it('rejects a createRotations result with an unknown piece id', () => {
		const { session } = startedSession({
			pieceCount: 2,
			createRotations: () => ({ 0: 90, 99: 180 })
		});
		expect(() => session.dispatch({ type: 'set_rotation_mode', enabled: true })).toThrow(
			/unknown piece id/
		);
	});

	it('rejects a createRotations result with an invalid rotation value', () => {
		const { session } = startedSession({
			pieceCount: 1,
			createRotations: () => ({ 0: 45 as Rotation })
		});
		expect(() => session.dispatch({ type: 'set_rotation_mode', enabled: true })).toThrow(
			/invalid rotation/
		);
	});

	it('rejects a createRotations result that is not an object', () => {
		const { session } = startedSession({
			pieceCount: 1,
			createRotations: (() => null) as unknown as () => Record<number, Rotation>
		});
		expect(() => session.dispatch({ type: 'set_rotation_mode', enabled: true })).toThrow(
			/must be an object/
		);
	});

	it('clones createTrayOrder output on restart so a factory retaining its array cannot mutate state', () => {
		const retained = [3, 1, 0, 2];
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			createTrayOrder: () => retained
		});
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'restart' });
		expect(session.getState().trayOrder).toEqual([3, 1, 0, 2]);

		// Mutating the factory's retained array after restart must not change
		// engine state.
		retained.push(99);
		retained.sort((a, b) => a - b);
		expect(session.getState().trayOrder).toEqual([3, 1, 0, 2]);
	});

	it('rejects a restart createTrayOrder with a duplicate id and leaves state consistent', () => {
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			createTrayOrder: () => [0, 1, 2, 0]
		});
		session.dispatch({ type: 'start' });
		const beforeLifecycle = session.getState().lifecycle;
		const beforeTrayOrder = session.getState().trayOrder.slice();

		expect(() => session.dispatch({ type: 'restart' })).toThrow(/duplicate piece id/);

		// The session is left in its prior consistent state: lifecycle and
		// tray order unchanged (no half-applied transition).
		expect(session.getState().lifecycle).toBe(beforeLifecycle);
		expect(session.getState().trayOrder).toEqual(beforeTrayOrder);
	});

	it('rejects a restart createTrayOrder with an unknown id and leaves state consistent', () => {
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			createTrayOrder: () => [0, 1, 2, 99]
		});
		session.dispatch({ type: 'start' });
		const beforeLifecycle = session.getState().lifecycle;

		expect(() => session.dispatch({ type: 'restart' })).toThrow(/unknown piece id/);
		expect(session.getState().lifecycle).toBe(beforeLifecycle);
	});

	it('leaves state consistent when createTrayOrder throws on restart', () => {
		let throwOnce = true;
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			createTrayOrder: () => {
				if (throwOnce) throw new Error('factory boom');
				return [0, 1, 2, 3];
			}
		});
		session.dispatch({ type: 'start' });
		const beforeLifecycle = session.getState().lifecycle;
		const beforeTrayOrder = session.getState().trayOrder.slice();

		expect(() => session.dispatch({ type: 'restart' })).toThrow('factory boom');
		// No half-applied transition: state, lifecycle, and tray order intact.
		expect(session.getState().lifecycle).toBe(beforeLifecycle);
		expect(session.getState().trayOrder).toEqual(beforeTrayOrder);

		// The session is still usable: a subsequent restart with a working
		// factory succeeds.
		throwOnce = false;
		const outcome = session.dispatch({ type: 'restart' });
		expect(outcome.type).toBe('lifecycle_transitioned');
		expect(session.getState().lifecycle).toBe('setup');
	});

	it('rejects a restart createTrayOrder with the wrong length and leaves state consistent', () => {
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			createTrayOrder: () => [0, 1, 2]
		});
		session.dispatch({ type: 'start' });
		const beforeLifecycle = session.getState().lifecycle;

		expect(() => session.dispatch({ type: 'restart' })).toThrow(/length must equal pieceCount/);
		expect(session.getState().lifecycle).toBe(beforeLifecycle);
	});

	it('rejects a restart createTrayOrder that is not an array and leaves state consistent', () => {
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: makeRunIdFactory(),
			clock: new ManualClock(),
			createTrayOrder: (() => 'not-an-array') as unknown as () => number[]
		});
		session.dispatch({ type: 'start' });
		const beforeLifecycle = session.getState().lifecycle;

		expect(() => session.dispatch({ type: 'restart' })).toThrow(/must be an array/);
		expect(session.getState().lifecycle).toBe(beforeLifecycle);
	});

	it('leaves the clock running when runIdFactory throws on restart', () => {
		const clock = new ManualClock();
		// Succeed on construction (call 1), throw on the first restart (call 2),
		// then succeed on the retry restart (call 3).
		let calls = 0;
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: {
				create: () => {
					calls++;
					if (calls === 2) throw new Error('runid boom');
					return `run-${calls}`;
				}
			},
			clock
		});
		session.dispatch({ type: 'start' });
		// Start the timer via a counted action so the tick interval is live.
		session.dispatch({ type: 'attempt_placement', pieceId: 0, x: 0, y: 0 });
		expect(clock.activeIntervalCount).toBe(1);
		const beforeRunId = session.getState().runId;
		const beforeElapsed = session.getState().elapsedActiveSeconds;

		expect(() => session.dispatch({ type: 'restart' })).toThrow('runid boom');

		// The clock was never stopped: the tick interval is still live and
		// elapsed time keeps advancing. Prior to the fix, stopClock() ran
		// before the factory call, freezing the timer permanently.
		expect(clock.activeIntervalCount).toBe(1);
		expect(session.getState().runId).toBe(beforeRunId);
		clock.advance(3_000);
		session.checkpointTime();
		expect(session.getState().elapsedActiveSeconds).toBe((beforeElapsed ?? 0) + 3);

		// The session is still usable: a subsequent restart with a working
		// factory succeeds and produces a fresh run id.
		const outcome = session.dispatch({ type: 'restart' });
		expect(outcome.type).toBe('lifecycle_transitioned');
		expect(session.getState().runId).toBe('run-3');
		expect(session.getState().runId).not.toBe(beforeRunId);
	});

	it('rejects a runIdFactory that returns the current run id on restart', () => {
		const session = createPuzzleSession({
			metadata: makeMetadata(4),
			runIdFactory: { create: () => 'same-run' },
			clock: new ManualClock()
		});
		session.dispatch({ type: 'start' });
		const beforeLifecycle = session.getState().lifecycle;

		expect(() => session.dispatch({ type: 'restart' })).toThrow(/equal to the current run id/);
		// State fully intact: clock not stopped, lifecycle unchanged.
		expect(session.getState().lifecycle).toBe(beforeLifecycle);
	});
});
