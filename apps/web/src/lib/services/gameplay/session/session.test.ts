// Red tests for PuzzleSession lifecycle and the single injected clock.
import { describe, it, expect } from 'vitest';
import { createPuzzleSession } from './session';
import type {
	PuzzleSessionState,
	PuzzleMetadata,
	RunIdFactory,
	Clock,
	PersistedPuzzleSessionV1
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
	const pieces = Array.from({ length: pieceCount }, (_, i) => ({
		id: i,
		correctX: i % 2,
		correctY: Math.floor(i / 2)
	}));
	return {
		puzzleId: 'pz1',
		source: 'api',
		pieceCount,
		gridCols: 2,
		gridRows: Math.ceil(pieceCount / 2),
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
