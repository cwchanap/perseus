// PuzzleSession transition engine: lifecycle, clock, gameplay, and history.
//
// Framework-independent. Imports no Svelte, DOM, storage, fetch, or analytics.
// Time and scheduling arrive through one injected Clock; fresh run ids through
// one injected RunIdFactory; rotation generation through an optional factory.
// Completion sealing and typed effect coordination are layered on by Task 5.

import { createHistory, type History } from '$lib/services/gameplay/history';
import { getHintPieceId } from '$lib/services/gameplay/hints';
import {
	rotateClockwise,
	isUpright,
	generateRandomRotations
} from '$lib/services/gameplay/rotation';
import type { Rotation } from '$lib/types/gameplay';
import type {
	CreatePuzzleSessionOptions,
	PuzzleSessionAction,
	PuzzleSessionOutcome,
	PuzzleSessionState,
	PuzzleSessionEvent,
	PersistedPuzzleSessionV1,
	PersistedTrayOrganization,
	PlacementOutcome,
	ResultClass,
	ReferenceMode,
	SealedCompletion,
	CompletionEffect,
	CompletionEffectState,
	CompletionFailureCode,
	PlacedPiece,
	TrayOrganizationUpdate,
	SessionLifecycle,
	PuzzleMetadata
} from './types';

export interface PuzzleSession {
	getState(): Readonly<PuzzleSessionState>;
	dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome;
	setDocumentHidden(hidden: boolean): void;
	checkpointTime(): void;
	dispose(): void;
	/** Framework-neutral subscription; listeners fire on every state change. */
	subscribe(listener: () => void): () => void;
}

interface PlacementHistoryState {
	placedPieces: PlacedPiece[];
	pieceRotations: Record<number, Rotation>;
	rotationEnabled: boolean;
}

export function createPuzzleSession(options: CreatePuzzleSessionOptions): PuzzleSession {
	const clock = options.clock;
	const onEvent = options.onEvent;
	// Validate and clone caller-supplied metadata before retaining it. The
	// engine is the invariant boundary: construction throws when metadata
	// violates required invariants (per the approved design). Cloning
	// prevents a caller from mutating the pieces array or tray order after
	// construction and bypassing dispatch.
	const { metadata, initialTrayOrder } = validateAndCloneMetadata(
		options.metadata,
		options.initialTrayOrder
	);
	const safeOptions: CreatePuzzleSessionOptions = { ...options, metadata, initialTrayOrder };
	const pieceById = new Map(metadata.pieces.map((piece) => [piece.id, piece]));
	const createRotations =
		options.createRotations ??
		((ids: number[]) => generateRandomRotations(ids, hashSeed(metadata.puzzleId)));

	let state = buildInitialState(safeOptions);
	let placementHistory = makeHistoryBaseline(state);
	let monotonicStart: number | null = null;
	let tickHandle: unknown = null;
	let clockRunning = false;
	let documentHidden = false;
	let disposed = false;
	const listeners = new Set<() => void>();

	function emit(event: PuzzleSessionEvent) {
		if (onEvent) onEvent(cloneEventPayload(event));
	}
	function notify() {
		emit({ type: 'state_changed' });
		for (const listener of listeners) listener();
	}

	// --- Clock ----------------------------------------------------------------

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

	function ensureTimerStarted() {
		if (state.timerStarted) return;
		if (state.mode !== 'timed' || state.timingQuality !== 'known') return;
		if (state.lifecycle !== 'active') return;
		state.timerStarted = true;
		startClock();
	}

	// --- Lifecycle ------------------------------------------------------------

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
		if (disposed) return { type: 'disposed' };
		stopClock();
		disposed = true;
		transitionToInternal('disposed');
		notify();
		return { type: 'disposed' };
	}

	// --- Gameplay helpers -----------------------------------------------------

	function isPiecePlaced(pieceId: number): boolean {
		return state.placedPieces.some((placement) => placement.pieceId === pieceId);
	}

	function uniquePlacedCount(): number {
		return new Set(state.placedPieces.map((placement) => placement.pieceId)).size;
	}

	function isBoardComplete(): boolean {
		return state.pieceCount > 0 && uniquePlacedCount() >= state.pieceCount;
	}

	function recomputeResultClass(): ResultClass {
		if (state.mode === 'relaxed') return 'relaxed';
		if (state.facts.hintUsed || state.facts.ghostReferenceUsed) return 'assisted_timed';
		if (state.facts.rotationUsed) return 'rotation_timed';
		return 'standard_timed';
	}

	function snapshot(): PlacementHistoryState {
		return {
			placedPieces: state.placedPieces.map((piece) => ({ ...piece })),
			pieceRotations: { ...state.pieceRotations },
			rotationEnabled: state.rotationEnabled
		};
	}

	function pushHistory() {
		placementHistory.push(snapshot());
		updateHistoryFlags();
	}

	function updateHistoryFlags() {
		state.canUndo = placementHistory.canUndo();
		state.canRedo = placementHistory.canRedo();
	}

	function applyHistorySnapshot(snapshotState: PlacementHistoryState) {
		state.placedPieces = snapshotState.placedPieces.map((piece) => ({ ...piece }));
		state.pieceRotations = { ...snapshotState.pieceRotations };
		state.rotationEnabled = snapshotState.rotationEnabled;
	}

	// --- Selection ------------------------------------------------------------

	function doSelect(pieceId: number): PuzzleSessionOutcome {
		if (state.lifecycle !== 'active') {
			return { type: 'selection_noop', reason: 'lifecycle_disallows_gameplay' };
		}
		if (!pieceById.has(pieceId)) {
			return { type: 'selection_noop', reason: 'unknown_piece' };
		}
		if (isPiecePlaced(pieceId)) {
			return { type: 'selection_noop', reason: 'already_placed' };
		}
		state.selectedPieceId = pieceId;
		notify();
		return { type: 'selection_changed', pieceId };
	}

	function doCancelSelection(): PuzzleSessionOutcome {
		state.selectedPieceId = null;
		notify();
		return { type: 'selection_changed', pieceId: null };
	}

	// --- Rotation mode + per-piece rotation -----------------------------------

	function doConfigureSetup(
		mode: PuzzleSessionState['mode'],
		rotationEnabled: boolean
	): PuzzleSessionOutcome {
		if (state.lifecycle !== 'setup') {
			return { type: 'lifecycle_noop', reason: 'lifecycle_disallows' };
		}

		const ids = metadata.pieces.map((piece) => piece.id);
		const pieceRotations = rotationEnabled
			? validateAndCloneRotations(createRotations(ids), pieceById)
			: {};

		state.mode = mode;
		state.elapsedActiveSeconds = mode === 'timed' ? 0 : null;
		state.timerStarted = false;
		state.rotationEnabled = rotationEnabled;
		state.pieceRotations = pieceRotations;
		state.facts = { ...state.facts, rotationUsed: rotationEnabled };
		state.resultClass = recomputeResultClass();
		state.hasUserActivity = false;
		state.selectedPieceId = null;
		state.activeReferenceMode = null;
		state.canUndo = false;
		state.canRedo = false;
		placementHistory = makeHistoryBaseline(state);
		notify();

		return { type: 'setup_configured', mode, rotationEnabled };
	}

	function doSetRotationMode(enabled: boolean): PuzzleSessionOutcome {
		if (state.lifecycle !== 'active') {
			return { type: 'rotation_mode_noop', reason: 'lifecycle_disables_rotation_toggle' };
		}
		if (state.placedPieces.length > 0) {
			return { type: 'rotation_mode_noop', reason: 'pieces_already_placed' };
		}
		const previous = state.rotationEnabled;
		const next = enabled;
		if (next && !previous) {
			const ids = metadata.pieces.map((piece) => piece.id);
			// Clone and validate the factory output before assigning: a
			// factory that retains its returned object could otherwise mutate
			// state.pieceRotations later without dispatch, and a malformed
			// mapping (unknown ids / invalid rotation values) would corrupt
			// placement gating.
			state.pieceRotations = validateAndCloneRotations(createRotations(ids), pieceById);
		}
		// Enabling or disabling rotation is a persistent state change that
		// permanently affects result eligibility, so it must count as user
		// activity for resume discovery (isResumable). Required by the
		// approved persistence contract.
		if (next !== previous) {
			state.hasUserActivity = true;
		}
		state.rotationEnabled = next;
		if (next) {
			state.facts = { ...state.facts, rotationUsed: true };
		}
		state.resultClass = recomputeResultClass();
		pushHistory();
		notify();
		return { type: 'rotation_mode_changed', enabled: next };
	}

	function doRotatePiece(pieceId: number): PuzzleSessionOutcome {
		if (state.lifecycle !== 'active')
			return { type: 'rotation_noop', reason: 'piece_not_rotatable' };
		if (!state.rotationEnabled) return { type: 'rotation_noop', reason: 'piece_not_rotatable' };
		if (!pieceById.has(pieceId) || isPiecePlaced(pieceId)) {
			return { type: 'rotation_noop', reason: 'piece_not_rotatable' };
		}
		ensureTimerStarted();
		const current = state.pieceRotations[pieceId] ?? 0;
		state.pieceRotations = { ...state.pieceRotations, [pieceId]: rotateClockwise(current) };
		state.hasUserActivity = true;
		pushHistory();
		notify();
		return { type: 'piece_rotated', pieceId };
	}

	// --- Placement ------------------------------------------------------------

	function doAttemptPlacement(pieceId: number, x: number, y: number): PuzzleSessionOutcome {
		const placementOutcome = validatePlacement(pieceId, x, y);
		if (placementOutcome.status !== 'accepted') {
			if (placementOutcome.status === 'rejected') {
				ensureTimerStarted();
				state.counters = {
					...state.counters,
					incorrectAttempts: state.counters.incorrectAttempts + 1
				};
				state.hasUserActivity = true;
				emit({ type: 'placement_rejected', pieceId, reason: placementOutcome.reason });
				notify();
			}
			return { type: 'placement', outcome: placementOutcome };
		}

		const nextPlacement: PlacedPiece = { pieceId, x, y };
		state.placedPieces = [...state.placedPieces, nextPlacement];
		ensureTimerStarted();
		state.hasUserActivity = true;
		if (state.selectedPieceId === pieceId) {
			state.selectedPieceId = null;
		}
		const completed = isBoardComplete();
		pushHistory();
		emit({ type: 'placement_accepted', pieceId, completed });
		if (completed) {
			handleBoardCompletion();
		}
		notify();
		return { type: 'placement', outcome: { status: 'accepted', completed } };
	}

	function validatePlacement(pieceId: number, x: number, y: number): PlacementOutcome {
		if (state.lifecycle !== 'active') {
			return { status: 'noop', reason: 'lifecycle_disallows_gameplay' };
		}
		const piece = pieceById.get(pieceId);
		if (!piece) {
			return { status: 'noop', reason: 'unknown_piece' };
		}
		if (isPiecePlaced(pieceId)) {
			return { status: 'noop', reason: 'duplicate_piece' };
		}
		if (
			!Number.isInteger(x) ||
			!Number.isInteger(y) ||
			x < 0 ||
			y < 0 ||
			x >= state.gridCols ||
			y >= state.gridRows
		) {
			return { status: 'noop', reason: 'invalid_coordinates' };
		}
		if (x !== piece.correctX || y !== piece.correctY) {
			return { status: 'rejected', reason: 'wrong_slot', counted: true };
		}
		if (state.rotationEnabled && !isUpright(state.pieceRotations[pieceId] ?? 0)) {
			return { status: 'rejected', reason: 'non_upright', counted: true };
		}
		return { status: 'accepted', completed: false };
	}

	// --- Assistance: hints and reference --------------------------------------

	function doUseHint(): PuzzleSessionOutcome {
		if (state.lifecycle !== 'active') {
			return { type: 'hint_noop', reason: 'lifecycle_disallows_gameplay' };
		}
		const placedIds = new Set(state.placedPieces.map((placement) => placement.pieceId));
		const hintPieceId = getHintPieceId(state.trayOrder, placedIds, state.selectedPieceId);
		if (hintPieceId === null) {
			return { type: 'hint_noop', reason: 'all_placed' };
		}
		state.counters = { ...state.counters, hintsUsed: state.counters.hintsUsed + 1 };
		state.facts = { ...state.facts, hintUsed: true };
		state.hasUserActivity = true;
		state.resultClass = recomputeResultClass();
		const piece = pieceById.get(hintPieceId);
		const target = piece ? { x: piece.correctX, y: piece.correctY } : null;
		emit({ type: 'hint_target', pieceId: hintPieceId, target });
		notify();
		return { type: 'hint_used', pieceId: hintPieceId };
	}

	function doSetReferenceMode(mode: ReferenceMode | null): PuzzleSessionOutcome {
		if (state.lifecycle !== 'active') {
			return { type: 'reference_mode_noop', reason: 'lifecycle_disallows_gameplay' };
		}
		const previous = state.activeReferenceMode;
		state.activeReferenceMode = mode;
		let activationCounted = false;
		if (mode !== null && previous === null) {
			state.counters = {
				...state.counters,
				referenceActivations: state.counters.referenceActivations + 1
			};
			activationCounted = true;
			state.hasUserActivity = true;
		}
		if (mode === 'ghost') {
			state.facts = { ...state.facts, ghostReferenceUsed: true };
		}
		state.resultClass = recomputeResultClass();
		notify();
		return { type: 'reference_mode_changed', mode, activationCounted };
	}

	// --- Tray organization ----------------------------------------------------

	function doUpdateTrayOrganization(update: TrayOrganizationUpdate): PuzzleSessionOutcome {
		const base: PersistedTrayOrganization = state.organization ?? {
			filter: 'all',
			activeTray: 'main',
			membership: {},
			names: {}
		};
		const organization: PersistedTrayOrganization = {
			filter: base.filter,
			activeTray: base.activeTray,
			membership: { ...base.membership },
			names: { ...base.names }
		};

		switch (update.type) {
			case 'set_filter':
				organization.filter = update.filter;
				break;
			case 'set_active_tray':
				organization.activeTray = update.trayId;
				break;
			case 'rename_tray':
				organization.names[update.trayId] = update.name;
				break;
			case 'remove_tray':
				if (Object.values(organization.membership).includes(update.trayId)) {
					return { type: 'tray_organization_noop', reason: 'invalid_update' };
				}
				delete organization.names[update.trayId];
				if (organization.activeTray === update.trayId) {
					organization.activeTray = 'main';
				}
				break;
			case 'move_piece':
				if (!pieceById.has(update.pieceId)) {
					return { type: 'tray_organization_noop', reason: 'invalid_update' };
				}
				organization.membership[update.pieceId] = update.toTrayId;
				break;
			case 'reorder':
				// Reorder is not implemented in this HPA; tray-organization UI is
				// owned by HPA-220/237. Return a no-op so the branch cannot be
				// mistaken for working. Do not mutate state or notify.
				return { type: 'tray_organization_noop', reason: 'not_implemented' };
		}
		state.organization = organization;
		state.hasUserActivity = true;
		notify();
		return { type: 'tray_organization_applied', update };
	}

	// --- Restart --------------------------------------------------------------

	function doRestart(): PuzzleSessionOutcome {
		if (state.lifecycle === 'setup') {
			return { type: 'lifecycle_noop', reason: 'nothing_to_restart' };
		}
		// 'disposed' is unreachable here: dispatch() guards disposed sessions
		// before routing to doRestart.
		const from = state.lifecycle;
		const retainedMode = state.mode;
		const retainedOrganization = state.organization;
		// Compute and validate the restart tray order BEFORE stopping the
		// clock or replacing state. If createTrayOrder() throws or returns a
		// malformed order, the session is left in its prior consistent state
		// rather than a half-applied transition (state replaced, history not
		// rebuilt, subscribers not notified). Cloning prevents a factory that
		// retains its returned array from mutating state.trayOrder later.
		const restartOrder = validateAndCloneTrayOrder(
			safeOptions.createTrayOrder
				? safeOptions.createTrayOrder()
				: metadata.pieces
						.map((piece) => piece.id)
						.slice()
						.sort((a, b) => a - b),
			metadata.pieces
		);
		// Generate the next run id BEFORE stopping the clock. If the factory
		// throws, the prior state remains fully intact with its tick interval
		// still live; otherwise stopClock() would clear the interval while
		// state.timerStarted stayed true, freezing elapsed time permanently
		// (ensureTimerStarted no-ops on timerStarted, checkpointTime no-ops on
		// clockRunning). A collision with the current run id would make the new
		// run indistinguishable from the old one for completion tracking, so
		// treat it as a bug rather than silently reusing it.
		const nextRunId = safeOptions.runIdFactory.create();
		if (nextRunId === state.runId) {
			throw new Error(
				`runIdFactory produced a run id equal to the current run id (${nextRunId}); restart requires a fresh run id`
			);
		}
		stopClock();
		state = freshState({ ...safeOptions, mode: retainedMode }, nextRunId);
		state.organization = retainedOrganization;
		state.trayOrder = restartOrder;
		placementHistory = makeHistoryBaseline(state);
		emit({ type: 'lifecycle', from, to: 'setup' });
		notify();
		return { type: 'lifecycle_transitioned', from, to: 'setup' };
	}

	// --- Completion sealing and typed effects ---------------------------------

	/**
	 * Called after a placement that completes the board. If a seal already exists
	 * (undo-then-recomplete), restores the completed lifecycle without resealing
	 * or re-emitting. Otherwise seals once.
	 */
	function handleBoardCompletion() {
		if (state.sealedCompletion) {
			if (state.lifecycle !== 'completed') {
				transitionToInternal('completed');
			}
			return;
		}
		doComplete();
	}

	function doComplete(): PuzzleSessionOutcome {
		if (state.sealedCompletion) {
			return { type: 'completion_noop', reason: 'already_sealed' };
		}
		if (state.lifecycle !== 'active') {
			return { type: 'completion_noop', reason: 'lifecycle_disallows' };
		}
		if (!isBoardComplete()) {
			return { type: 'completion_noop', reason: 'board_incomplete' };
		}
		stopClock();
		const seal: SealedCompletion = {
			runId: state.runId,
			resultClass: state.resultClass,
			timingQuality: state.timingQuality,
			elapsedActiveSeconds: sealElapsed(),
			completedAt: clock.wallNow(),
			localStats: { status: 'pending' },
			serverSubmission:
				state.source === 'api' ? { status: 'pending' } : { status: 'not_applicable' }
		};
		state.sealedCompletion = seal;
		transitionToInternal('completed');
		emit({ type: 'completion_sealed', seal });
		// Defer effect requests until after notify() so the route's synchronous
		// acknowledge_completion_effect dispatch cannot reassign state.sealedCompletion
		// mid-transition (re-entrant dispatch). Listeners observe the sealed state
		// before any effect handler mutates it.
		const pendingEffects: CompletionEffect[] = ['local_stats'];
		if (seal.serverSubmission.status === 'pending') {
			pendingEffects.push('server_submission');
		}
		notify();
		for (const effect of pendingEffects) {
			emit({ type: 'completion_effect_request', effect, seal });
		}
		// Return a deep-frozen clone so a consumer cannot mutate the engine's
		// internal state.sealedCompletion through the dispatch outcome (the
		// returned seal would otherwise be the same object retained in state).
		return { type: 'completion_sealed', seal: deepFreeze(cloneSeal(seal)) };
	}

	function sealElapsed(): number | null {
		if (state.mode === 'relaxed' || state.timingQuality !== 'known') {
			return null;
		}
		return Math.max(1, state.elapsedActiveSeconds ?? 0);
	}

	function doAcknowledge(
		runId: string,
		effect: CompletionEffect,
		result:
			| { status: 'succeeded' }
			| { status: 'failed'; code: CompletionFailureCode; retryable: boolean }
	): PuzzleSessionOutcome {
		const seal = state.sealedCompletion;
		if (!seal || seal.runId !== runId) {
			return { type: 'effect_acknowledgement_noop', reason: 'run_id_mismatch' };
		}
		const current = effect === 'local_stats' ? seal.localStats : seal.serverSubmission;
		if (
			current.status === 'succeeded' ||
			current.status === 'not_applicable' ||
			(current.status === 'failed' && !current.retryable)
		) {
			return { type: 'effect_acknowledgement_noop', reason: 'effect_terminal' };
		}
		// Clone the caller-supplied result before retaining it: a caller that
		// holds the result object could otherwise mutate the engine's sealed
		// effect state after dispatch without a transition or notification.
		const nextState = cloneEffectState(result);
		state.sealedCompletion =
			effect === 'local_stats'
				? { ...seal, localStats: nextState }
				: { ...seal, serverSubmission: nextState };
		notify();
		return { type: 'effect_acknowledged', effect };
	}

	function doRetryCompletionEffects(includeUnauthorized: boolean): PuzzleSessionOutcome {
		const seal = state.sealedCompletion;
		if (!seal) {
			return { type: 'completion_noop', reason: 'board_incomplete' };
		}
		let localStats = seal.localStats;
		let serverSubmission = seal.serverSubmission;
		// Track only effects whose failed state was actually reset to pending.
		// Re-emitting for effects that were already pending (e.g. an in-flight
		// initial submission) would duplicate side effects.
		const retryEffects: CompletionEffect[] = [];
		if (localStats.status === 'failed' && localStats.retryable) {
			localStats = { status: 'pending' };
			retryEffects.push('local_stats');
		}
		if (
			serverSubmission.status === 'failed' &&
			serverSubmission.retryable &&
			// Skip unauthorized failures unless the caller explicitly opts in
			// (e.g. after a newly authenticated transition). Hydration
			// auto-retry must not re-submit a guaranteed-to-fail 401 for an
			// anonymous user on every reload.
			(includeUnauthorized || serverSubmission.code !== 'unauthorized')
		) {
			serverSubmission = { status: 'pending' };
			retryEffects.push('server_submission');
		}
		if (retryEffects.length === 0) {
			return { type: 'completion_noop', reason: 'no_retryable_effects' };
		}
		const updated = { ...seal, localStats, serverSubmission };
		state.sealedCompletion = updated;
		// Defer effect requests until after notify() to avoid re-entrant dispatch
		// mutating state.sealedCompletion mid-transition (see doComplete).
		notify();
		for (const effect of retryEffects) {
			emit({ type: 'completion_effect_request', effect, seal: updated });
		}
		// Return a deep-frozen clone; the internal seal is `updated`, retained
		// in state.sealedCompletion, and must not leak to the caller.
		return { type: 'completion_sealed', seal: deepFreeze(cloneSeal(updated)) };
	}

	/**
	 * Re-emit completion_effect_request for any effect currently in the
	 * `pending` state. Used after restoring a session from persistence so that
	 * effects whose side effects never completed (e.g. a server submission
	 * interrupted by a page close) are re-driven. Unlike retry, this does not
	 * reset failed effects — it only resumes ones that were never acknowledged.
	 * Idempotent: effects already succeeded/failed are left untouched.
	 */
	function doResumeCompletionEffects(): PuzzleSessionOutcome {
		const seal = state.sealedCompletion;
		if (!seal) {
			return { type: 'completion_noop', reason: 'board_incomplete' };
		}
		const resumeEffects: CompletionEffect[] = [];
		if (seal.localStats.status === 'pending') {
			resumeEffects.push('local_stats');
		}
		if (seal.serverSubmission.status === 'pending') {
			resumeEffects.push('server_submission');
		}
		if (resumeEffects.length === 0) {
			return { type: 'completion_noop', reason: 'no_pending_effects' };
		}
		// This function re-emits pending completion_effect_request events
		// without mutating state (unlike doComplete/doRetryCompletionEffects,
		// which reassign state.sealedCompletion and must notify before emitting
		// so subscribers observe the new seal). No state change means no notify()
		// is needed; the effect requests are emitted directly.
		for (const effect of resumeEffects) {
			emit({ type: 'completion_effect_request', effect, seal });
		}
		// Return a deep-frozen clone; the internal seal is retained in
		// state.sealedCompletion and must not leak to the caller.
		return { type: 'completion_sealed', seal: deepFreeze(cloneSeal(seal)) };
	}

	// --- Undo / redo ----------------------------------------------------------

	function doUndo(): PuzzleSessionOutcome {
		if (!placementHistory.canUndo()) {
			// History always has an initial-state baseline, so getCurrent() is
			// never undefined when canUndo() is false — the reason is 'at_start'.
			return { type: 'history_noop', reason: 'at_start' };
		}
		const previous = placementHistory.undo();
		// canUndo() was true, so undo() always returns a value.
		const wasCompleted = state.lifecycle === 'completed';
		applyHistorySnapshot(previous!);
		state.resultClass = recomputeResultClass();
		updateHistoryFlags();
		// Undo from a completed run reactivates the board/lifecycle, but the
		// immutable seal is retained and a fresh completion is a no-op.
		if (wasCompleted && state.lifecycle === 'completed') {
			transitionToInternal('active');
		}
		notify();
		return { type: 'history_restored', direction: 'undo' };
	}

	function doRedo(): PuzzleSessionOutcome {
		if (!placementHistory.canRedo()) {
			return { type: 'history_noop', reason: 'at_end' };
		}
		const next = placementHistory.redo();
		// canRedo() was true, so redo() always returns a value.
		applyHistorySnapshot(next!);
		state.resultClass = recomputeResultClass();
		updateHistoryFlags();
		// Restoring the completed board after an undo returns lifecycle to
		// completed without emitting a second completion (seal is retained).
		if (state.sealedCompletion && isBoardComplete() && state.lifecycle !== 'completed') {
			transitionToInternal('completed');
		}
		notify();
		return { type: 'history_restored', direction: 'redo' };
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
		// clockRunning is only true for timed+known sessions with a live
		// monotonicStart (startClock sets both together, stopClock clears both).
		if (!clockRunning || monotonicStart === null) return;
		const now = clock.monotonicNow();
		const delta = Math.floor((now - monotonicStart) / 1000);
		if (delta > 0) {
			state.elapsedActiveSeconds = (state.elapsedActiveSeconds ?? 0) + delta;
			monotonicStart += delta * 1000;
			notify();
		}
	}

	// --- Dispatch -------------------------------------------------------------

	function dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome {
		if (disposed) {
			return { type: 'lifecycle_noop', reason: 'disposed' };
		}
		switch (action.type) {
			case 'configure_setup':
				return doConfigureSetup(action.mode, action.rotationEnabled);
			case 'start':
				return doStart();
			case 'pause':
				return doPause();
			case 'resume':
				return doResume();
			case 'dispose':
				return doDispose();
			case 'select_piece':
				return doSelect(action.pieceId);
			case 'cancel_selection':
				return doCancelSelection();
			case 'set_rotation_mode':
				return doSetRotationMode(action.enabled);
			case 'rotate_piece':
				return doRotatePiece(action.pieceId);
			case 'attempt_placement':
				return doAttemptPlacement(action.pieceId, action.x, action.y);
			case 'undo':
				return doUndo();
			case 'redo':
				return doRedo();
			case 'use_hint':
				return doUseHint();
			case 'set_reference_mode':
				return doSetReferenceMode(action.mode);
			case 'update_tray_organization':
				return doUpdateTrayOrganization(action.update);
			case 'restart':
				return doRestart();
			case 'complete':
				return doComplete();
			case 'acknowledge_completion_effect':
				return doAcknowledge(action.runId, action.effect, action.result);
			case 'retry_completion_effects':
				return doRetryCompletionEffects(action.includeUnauthorized ?? false);
			case 'resume_completion_effects':
				return doResumeCompletionEffects();
			default:
				return { type: 'lifecycle_noop', reason: 'invalid_transition' };
		}
	}

	// --- Construction side-effects -------------------------------------------

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
		getState: () => deepFreeze(cloneState(state)),
		dispatch,
		setDocumentHidden,
		checkpointTime,
		dispose: () => {
			void doDispose();
		},
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}

// --- State construction -------------------------------------------------------

function buildInitialState(options: CreatePuzzleSessionOptions): PuzzleSessionState {
	if (options.restored) {
		return hydrate(options.restored, options.metadata);
	}
	// Initial construction has no prior state to leave inconsistent, so a
	// factory throw here simply fails session creation as expected.
	return freshState(options, options.runIdFactory.create());
}

function freshState(options: CreatePuzzleSessionOptions, runId: string): PuzzleSessionState {
	const mode = options.mode ?? 'timed';
	const ids = options.metadata.pieces.map((piece) => piece.id);
	return {
		puzzleId: options.metadata.puzzleId,
		source: options.metadata.source,
		runId,
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
		organization: null,
		viewport: null,
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
		organization: snapshot.organization ? cloneOrganization(snapshot.organization) : null,
		viewport: snapshot.viewport ? { ...snapshot.viewport } : null,
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
					localStats: cloneEffectState(snapshot.sealedCompletion.localStats),
					serverSubmission: cloneEffectState(snapshot.sealedCompletion.serverSubmission)
				}
			: null,
		canUndo: false,
		canRedo: false
	};
}

function makeHistoryBaseline(state: PuzzleSessionState): History<PlacementHistoryState> {
	return createHistory<PlacementHistoryState>({
		placedPieces: state.placedPieces.map((piece) => ({ ...piece })),
		pieceRotations: { ...state.pieceRotations },
		rotationEnabled: state.rotationEnabled
	});
}

function hashSeed(value: string): number {
	let hash = 0;
	for (const char of value) {
		hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
	}
	return hash || 1;
}

function cloneOrganization(org: PersistedTrayOrganization): PersistedTrayOrganization {
	return {
		filter: org.filter,
		activeTray: org.activeTray,
		membership: { ...org.membership },
		names: { ...org.names }
	};
}

// --- Snapshot / event immutability -------------------------------------------
//
// getState() and event payloads are the engine's invariant boundary: a
// consumer must not be able to mutate internal state (e.g. push into
// placedPieces) and bypass dispatch. getState() therefore returns a
// deep-cloned, deep-frozen copy, and seal-bearing events are emitted with
// cloned seals so an event consumer cannot mutate state.sealedCompletion.

function cloneSeal(seal: SealedCompletion): SealedCompletion {
	return {
		runId: seal.runId,
		resultClass: seal.resultClass,
		timingQuality: seal.timingQuality,
		elapsedActiveSeconds: seal.elapsedActiveSeconds,
		completedAt: seal.completedAt,
		localStats: cloneEffectState(seal.localStats),
		serverSubmission: cloneEffectState(seal.serverSubmission)
	};
}

// Effect states are flat discriminated unions; a shallow spread is a complete
// clone. Used at every boundary that retains or publishes an effect state
// (cloneSeal, doAcknowledge, hydrate) so a caller or persisted snapshot
// cannot mutate the engine's sealed effect state by reference.
function cloneEffectState(state: CompletionEffectState): CompletionEffectState {
	return { ...state };
}

function cloneState(state: PuzzleSessionState): PuzzleSessionState {
	return {
		...state,
		placedPieces: state.placedPieces.map((piece) => ({ ...piece })),
		trayOrder: state.trayOrder.slice(),
		pieceRotations: { ...state.pieceRotations },
		organization: state.organization ? cloneOrganization(state.organization) : null,
		viewport: state.viewport ? { ...state.viewport } : null,
		counters: { ...state.counters },
		facts: { ...state.facts },
		sealedCompletion: state.sealedCompletion ? cloneSeal(state.sealedCompletion) : null
	};
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) {
		Object.freeze(value);
		for (const item of value) deepFreeze(item);
	} else {
		Object.freeze(value);
		for (const key of Object.keys(value as object)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
	}
	return value;
}

function cloneEventPayload(event: PuzzleSessionEvent): PuzzleSessionEvent {
	switch (event.type) {
		case 'completion_sealed':
			return deepFreeze({ ...event, seal: cloneSeal(event.seal) });
		case 'completion_effect_request':
			return deepFreeze({ ...event, seal: cloneSeal(event.seal) });
		default:
			return event;
	}
}

// --- Construction metadata validation ----------------------------------------
//
// createPuzzleSession is the invariant boundary: it throws when caller
// metadata violates required invariants (per the approved design). This
// guards production paths where fetchPuzzle() casts the API response to
// Puzzle without runtime validation. The shared metadata guard checks
// grid math and finite coordinates but not unique ids, integer/in-bounds
// coordinates, or unique canonical cells — those are established here.
// Accepted metadata and tray order are cloned so a caller cannot mutate
// them after construction.

function validateAndCloneMetadata(
	metadata: PuzzleMetadata,
	initialTrayOrder: number[] | undefined
): { metadata: PuzzleMetadata; initialTrayOrder: number[] | undefined } {
	if (typeof metadata.puzzleId !== 'string' || metadata.puzzleId.length === 0) {
		throw new Error('Invalid puzzle metadata: puzzleId must be a non-empty string');
	}
	if (metadata.source !== 'api' && metadata.source !== 'local') {
		throw new Error('Invalid puzzle metadata: source must be "api" or "local"');
	}
	if (!Number.isInteger(metadata.gridCols) || metadata.gridCols < 1) {
		throw new Error('Invalid puzzle metadata: gridCols must be a positive integer');
	}
	if (!Number.isInteger(metadata.gridRows) || metadata.gridRows < 1) {
		throw new Error('Invalid puzzle metadata: gridRows must be a positive integer');
	}
	if (!Number.isInteger(metadata.pieceCount) || metadata.pieceCount < 1) {
		throw new Error('Invalid puzzle metadata: pieceCount must be a positive integer');
	}
	if (metadata.gridCols * metadata.gridRows !== metadata.pieceCount) {
		throw new Error('Invalid puzzle metadata: gridCols * gridRows must equal pieceCount');
	}
	const pieces = metadata.pieces;
	if (!Array.isArray(pieces)) {
		throw new Error('Invalid puzzle metadata: pieces must be an array');
	}
	if (pieces.length !== metadata.pieceCount) {
		throw new Error('Invalid puzzle metadata: pieces.length must equal pieceCount');
	}
	const ids = new Set<number>();
	const cells = new Set<string>();
	const clonedPieces: Array<{ id: number; correctX: number; correctY: number }> = [];
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i];
		if (!piece || typeof piece !== 'object') {
			throw new Error(`Invalid puzzle metadata: piece ${i} is not an object`);
		}
		const { id, correctX, correctY } = piece;
		if (!Number.isInteger(id)) {
			throw new Error(`Invalid puzzle metadata: piece ${i} id must be an integer`);
		}
		if (!Number.isInteger(correctX) || correctX < 0 || correctX >= metadata.gridCols) {
			throw new Error(`Invalid puzzle metadata: piece ${i} correctX out of bounds`);
		}
		if (!Number.isInteger(correctY) || correctY < 0 || correctY >= metadata.gridRows) {
			throw new Error(`Invalid puzzle metadata: piece ${i} correctY out of bounds`);
		}
		if (ids.has(id)) {
			throw new Error(`Invalid puzzle metadata: duplicate piece id ${id}`);
		}
		ids.add(id);
		const cellKey = `${correctX},${correctY}`;
		if (cells.has(cellKey)) {
			throw new Error(
				`Invalid puzzle metadata: duplicate canonical cell (${correctX}, ${correctY})`
			);
		}
		cells.add(cellKey);
		clonedPieces.push({ id, correctX, correctY });
	}
	const clonedMetadata: PuzzleMetadata = {
		puzzleId: metadata.puzzleId,
		source: metadata.source,
		pieceCount: metadata.pieceCount,
		gridCols: metadata.gridCols,
		gridRows: metadata.gridRows,
		pieces: clonedPieces
	};
	let clonedTrayOrder: number[] | undefined;
	if (initialTrayOrder !== undefined) {
		clonedTrayOrder = validateAndCloneTrayOrder(initialTrayOrder, clonedPieces, 'initialTrayOrder');
	}
	return { metadata: clonedMetadata, initialTrayOrder: clonedTrayOrder };
}

// --- Factory result validation ----------------------------------------------
//
// createRotations and createTrayOrder are caller-supplied factories whose
// output is assigned directly to engine state. Like construction metadata,
// their results are validated and cloned at the invariant boundary so a
// factory that retains its returned object cannot mutate state later without
// dispatch, and a malformed result (unknown ids, duplicates, invalid rotation
// values) is rejected rather than corrupting placement gating.

const VALID_ROTATIONS = new Set<Rotation>([0, 90, 180, 270]);

function validateAndCloneRotations(
	rotations: Record<number, Rotation>,
	pieceById: Map<number, unknown>
): Record<number, Rotation> {
	if (!rotations || typeof rotations !== 'object') {
		throw new Error('Invalid createRotations result: must be an object');
	}
	const cloned: Record<number, Rotation> = {};
	for (const key of Object.keys(rotations)) {
		const id = Number(key);
		if (!Number.isInteger(id) || !pieceById.has(id)) {
			throw new Error(`Invalid createRotations result: unknown piece id ${key}`);
		}
		const value = rotations[id];
		if (!VALID_ROTATIONS.has(value)) {
			throw new Error(
				`Invalid createRotations result: invalid rotation ${String(value)} for piece ${id}`
			);
		}
		cloned[id] = value;
	}
	return cloned;
}

/**
 * Validate that `order` is an exact permutation of the piece ids in `pieces`
 * (correct length, all ids known, no duplicates) and return a cloned array.
 * Used at construction (initialTrayOrder) and restart (createTrayOrder) so a
 * malformed order is rejected before any state is committed.
 */
function validateAndCloneTrayOrder(
	order: number[],
	pieces: ReadonlyArray<{ id: number }>,
	label = 'trayOrder'
): number[] {
	if (!Array.isArray(order)) {
		throw new Error(`Invalid ${label}: must be an array`);
	}
	if (order.length !== pieces.length) {
		throw new Error(`Invalid ${label}: length must equal pieceCount`);
	}
	const validIds = new Set(pieces.map((piece) => piece.id));
	const seen = new Set<number>();
	for (const id of order) {
		if (!Number.isInteger(id) || !validIds.has(id)) {
			throw new Error(`Invalid ${label}: unknown piece id ${String(id)}`);
		}
		if (seen.has(id)) {
			throw new Error(`Invalid ${label}: duplicate piece id ${id}`);
		}
		seen.add(id);
	}
	return order.slice();
}
