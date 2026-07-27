// PuzzleSession transition engine: lifecycle and the single injected clock.
//
// The engine is framework-independent. It imports no Svelte, DOM, storage,
// fetch, or analytics. Time and scheduling arrive through one injected Clock;
// fresh run ids arrive through one injected RunIdFactory. Gameplay, assistance,
// and completion transitions are layered onto this same dispatch surface by
// later tasks; this module owns construction, lifecycle, timing, visibility,
// restart, and disposal.

import type {
	Clock,
	CreatePuzzleSessionOptions,
	PuzzleSessionAction,
	PuzzleSessionOutcome,
	PuzzleSessionState,
	PuzzleSessionEvent,
	PuzzleSessionEventCallback,
	PersistedPuzzleSessionV1,
	SessionLifecycle
} from './types';

export interface PuzzleSession {
	getState(): Readonly<PuzzleSessionState>;
	dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome;
	setDocumentHidden(hidden: boolean): void;
	checkpointTime(): void;
	dispose(): void;
}

export function createPuzzleSession(options: CreatePuzzleSessionOptions): PuzzleSession {
	const clock = options.clock;
	const runIdFactory = options.runIdFactory;
	const onEvent = options.onEvent;
	const metadata = options.metadata;

	let state = buildInitialState(options);
	let monotonicStart: number | null = null;
	let tickHandle: unknown = null;
	let clockRunning = false;
	let documentHidden = false;
	let disposed = false;

	function emit(event: PuzzleSessionEvent) {
		if (onEvent) onEvent(event);
	}

	function notify() {
		emit({ type: 'state_changed' });
	}

	// --- Clock management -----------------------------------------------------

	function startClock() {
		if (disposed) return;
		if (state.mode !== 'timed' || state.timingQuality !== 'known') return;
		if (clockRunning) return;
		monotonicStart = clock.monotonicNow();
		tickHandle = clock.setInterval(() => checkpointTime(), 1000);
		clockRunning = true;
	}

	function stopClock() {
		if (!clockRunning) return;
		checkpointTime();
		if (tickHandle !== null) {
			clock.clearInterval(tickHandle);
			tickHandle = null;
		}
		clockRunning = false;
		monotonicStart = null;
	}

	/**
	 * Begin accumulating time on the first counted gameplay action. Counted
	 * actions (placement attempt, accepted piece rotation) are wired by the
	 * gameplay layer; mode toggles, hints, and reference viewing do not start
	 * the clock.
	 */
	function ensureTimerStarted() {
		if (state.timerStarted) return;
		if (state.mode !== 'timed' || state.timingQuality !== 'known') return;
		if (state.lifecycle !== 'active') return;
		state.timerStarted = true;
		startClock();
		notify();
	}

	// --- Lifecycle transitions ------------------------------------------------

	function doStart(): PuzzleSessionOutcome {
		if (state.lifecycle !== 'setup') {
			return { type: 'lifecycle_noop', reason: 'invalid_transition' };
		}
		return transitionTo('active');
	}

	function doPause(): PuzzleSessionOutcome {
		if (state.lifecycle !== 'active') {
			return { type: 'lifecycle_noop', reason: 'invalid_transition' };
		}
		stopClock();
		return transitionTo('paused');
	}

	function doResume(): PuzzleSessionOutcome {
		if (state.lifecycle !== 'paused') {
			return { type: 'lifecycle_noop', reason: 'invalid_transition' };
		}
		transitionToInternal('active');
		if (
			state.timerStarted &&
			state.mode === 'timed' &&
			state.timingQuality === 'known' &&
			!documentHidden
		) {
			startClock();
		}
		notify();
		return { type: 'lifecycle_transitioned', from: 'paused', to: 'active' };
	}

	function transitionTo(to: SessionLifecycle): PuzzleSessionOutcome {
		const from = state.lifecycle;
		transitionToInternal(to);
		notify();
		return { type: 'lifecycle_transitioned', from, to };
	}

	function transitionToInternal(to: SessionLifecycle) {
		const from = state.lifecycle;
		state.lifecycle = to;
		emit({ type: 'lifecycle', from, to });
	}

	function doDispose(): PuzzleSessionOutcome {
		if (disposed) {
			return { type: 'disposed' };
		}
		stopClock();
		disposed = true;
		transitionToInternal('disposed');
		notify();
		return { type: 'disposed' };
	}

	// --- Visibility -----------------------------------------------------------

	function setDocumentHidden(hidden: boolean): void {
		if (disposed) return;
		documentHidden = hidden;
		if (hidden) {
			if (state.lifecycle === 'active') {
				stopClock();
			}
			return;
		}
		if (
			state.lifecycle === 'active' &&
			state.timerStarted &&
			state.mode === 'timed' &&
			state.timingQuality === 'known' &&
			!clockRunning
		) {
			startClock();
			notify();
		}
	}

	// --- Public checkpoint ----------------------------------------------------

	function checkpointTime(): void {
		if (!clockRunning) return;
		if (state.mode !== 'timed' || state.timingQuality !== 'known') return;
		if (monotonicStart === null) return;
		const now = clock.monotonicNow();
		const delta = Math.floor((now - monotonicStart) / 1000);
		if (delta > 0) {
			state.elapsedActiveSeconds = (state.elapsedActiveSeconds ?? 0) + delta;
			monotonicStart += delta * 1000;
			notify();
		}
	}

	// --- Dispatch (lifecycle subset; gameplay/completion added by later tasks) -

	function dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome {
		if (disposed) {
			return { type: 'lifecycle_noop', reason: 'disposed' };
		}
		switch (action.type) {
			case 'start':
				return doStart();
			case 'pause':
				return doPause();
			case 'resume':
				return doResume();
			case 'dispose':
				return doDispose();
			default:
				// Gameplay, assistance, completion, and effect actions are owned by
				// Tasks 3-5. Until then they are inert no-ops so the engine remains
				// usable in isolation.
				return { type: 'lifecycle_noop', reason: 'invalid_transition' };
		}
	}

	// --- Construction side-effects -------------------------------------------

	// A restored active known-timed session with the clock already started
	// resumes accumulating immediately (the tab is visible at construction).
	if (
		state.lifecycle === 'active' &&
		state.timerStarted &&
		state.mode === 'timed' &&
		state.timingQuality === 'known' &&
		!documentHidden
	) {
		startClock();
	}

	return {
		getState: () => state,
		dispatch,
		setDocumentHidden,
		checkpointTime,
		dispose: () => {
			void doDispose();
		}
	};
}

// --- State construction -------------------------------------------------------

function buildInitialState(options: CreatePuzzleSessionOptions): PuzzleSessionState {
	if (options.restored) {
		return hydrate(options.restored, options.metadata);
	}
	return freshState(options);
}

function freshState(options: CreatePuzzleSessionOptions): PuzzleSessionState {
	const mode = options.mode ?? 'timed';
	const ids = options.metadata.pieces.map((piece) => piece.id);
	return {
		puzzleId: options.metadata.puzzleId,
		source: options.metadata.source,
		runId: options.runIdFactory.create(),
		origin: 'new',
		lifecycle: 'setup',
		mode,
		timingQuality: 'known',
		elapsedActiveSeconds: mode === 'timed' ? 0 : null,
		timerStarted: false,
		pieceCount: options.metadata.pieceCount,
		gridCols: options.metadata.gridCols,
		gridRows: options.metadata.gridRows,
		placedPieces: [],
		trayOrder: options.initialTrayOrder ?? ids.slice().sort((a, b) => a - b),
		rotationEnabled: false,
		pieceRotations: {},
		selectedPieceId: null,
		activeReferenceMode: null,
		counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
		facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
		hasUserActivity: false,
		resultClass: mode === 'relaxed' ? 'relaxed' : 'standard_timed',
		sealedCompletion: null,
		canUndo: false,
		canRedo: false
	};
}

function hydrate(
	snapshot: PersistedPuzzleSessionV1,
	metadata: CreatePuzzleSessionOptions['metadata']
): PuzzleSessionState {
	// Runtime-only fields are reset on hydration; persisted projection is the
	// source of truth for everything below. pieceCount/gridCols/gridRows come
	// from the resolved puzzle metadata (not the persisted projection). History
	// is not persisted, so a restored session starts with undo/redo unavailable.
	return {
		puzzleId: snapshot.puzzleId,
		source: snapshot.source,
		runId: snapshot.runId,
		origin: snapshot.origin,
		lifecycle: snapshot.lifecycle,
		mode: snapshot.mode,
		timingQuality: snapshot.timingQuality,
		elapsedActiveSeconds: snapshot.elapsedActiveSeconds,
		timerStarted: snapshot.timerStarted,
		pieceCount: metadata.pieceCount,
		gridCols: metadata.gridCols,
		gridRows: metadata.gridRows,
		placedPieces: snapshot.placedPieces.map((piece) => ({ ...piece })),
		trayOrder: snapshot.trayOrder.slice(),
		rotationEnabled: snapshot.rotationEnabled,
		pieceRotations: { ...snapshot.pieceRotations },
		selectedPieceId: null,
		activeReferenceMode: null,
		counters: { ...snapshot.counters },
		facts: { ...snapshot.facts },
		hasUserActivity: snapshot.hasUserActivity,
		resultClass: snapshot.resultClass,
		sealedCompletion: snapshot.sealedCompletion
			? {
					runId: snapshot.sealedCompletion.runId,
					resultClass: snapshot.sealedCompletion.resultClass,
					timingQuality: snapshot.sealedCompletion.timingQuality,
					elapsedActiveSeconds: snapshot.sealedCompletion.elapsedActiveSeconds,
					completedAt: snapshot.sealedCompletion.completedAt,
					localStats: snapshot.sealedCompletion.localStats,
					serverSubmission: snapshot.sealedCompletion.serverSubmission
				}
			: null,
		canUndo: false,
		canRedo: false
	};
}
