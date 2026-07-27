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
	SessionLifecycle
} from './types';

export interface PuzzleSession {
	getState(): Readonly<PuzzleSessionState>;
	dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome;
	setDocumentHidden(hidden: boolean): void;
	checkpointTime(): void;
	dispose(): void;
}

interface PlacementHistoryState {
	placedPieces: PlacedPiece[];
	pieceRotations: Record<number, Rotation>;
	rotationEnabled: boolean;
}

export function createPuzzleSession(options: CreatePuzzleSessionOptions): PuzzleSession {
	const clock = options.clock;
	const runIdFactory = options.runIdFactory;
	const onEvent = options.onEvent;
	const metadata = options.metadata;
	const pieceById = new Map(metadata.pieces.map((piece) => [piece.id, piece]));
	const createRotations =
		options.createRotations ??
		((ids: number[]) => generateRandomRotations(ids, hashSeed(metadata.puzzleId)));

	let state = buildInitialState(options);
	let placementHistory = makeHistoryBaseline(state);
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

	function doSetRotationMode(enabled: boolean): PuzzleSessionOutcome {
		if (state.lifecycle !== 'active') {
			return { type: 'rotation_mode_noop', reason: 'lifecycle_disables_rotation_toggle' };
		}
		if (state.placedPieces.length > 0) {
			return { type: 'rotation_mode_noop', reason: 'pieces_already_placed' };
		}
		const next = enabled;
		if (next && !state.rotationEnabled) {
			const ids = metadata.pieces.map((piece) => piece.id);
			state.pieceRotations = createRotations(ids);
		}
		state.rotationEnabled = next;
		if (next) {
			state.facts.rotationUsed = true;
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
			return { type: 'hint_noop', reason: 'all_placed' };
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
				break;
			case 'move_piece':
				if (!pieceById.has(update.pieceId)) {
					return { type: 'tray_organization_noop', reason: 'invalid_update' };
				}
				organization.membership[update.pieceId] = update.toTrayId;
				break;
			case 'reorder':
				for (const id of update.pieceIds) {
					if (!pieceById.has(id)) {
						return { type: 'tray_organization_noop', reason: 'invalid_update' };
					}
				}
				break;
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
		if (state.lifecycle === 'disposed') {
			return { type: 'lifecycle_noop', reason: 'disposed' };
		}
		const from = state.lifecycle;
		const retainedMode = state.mode;
		const retainedOrganization = state.organization;
		stopClock();
		state = freshState({ ...options, mode: retainedMode });
		state.organization = retainedOrganization;
		state.trayOrder = options.createTrayOrder
			? options.createTrayOrder()
			: metadata.pieces
					.map((piece) => piece.id)
					.slice()
					.sort((a, b) => a - b);
		placementHistory = makeHistoryBaseline(state);
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
		emit({ type: 'completion_effect_request', effect: 'local_stats', seal });
		if (seal.serverSubmission.status === 'pending') {
			emit({ type: 'completion_effect_request', effect: 'server_submission', seal });
		}
		notify();
		return { type: 'completion_sealed', seal };
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
		const nextState = result as CompletionEffectState;
		state.sealedCompletion =
			effect === 'local_stats'
				? { ...seal, localStats: nextState }
				: { ...seal, serverSubmission: nextState };
		notify();
		return { type: 'effect_acknowledged', effect };
	}

	function doRetryCompletionEffects(): PuzzleSessionOutcome {
		const seal = state.sealedCompletion;
		if (!seal) {
			return { type: 'completion_noop', reason: 'board_incomplete' };
		}
		let localStats = seal.localStats;
		let serverSubmission = seal.serverSubmission;
		if (localStats.status === 'failed' && localStats.retryable) {
			localStats = { status: 'pending' };
		}
		if (serverSubmission.status === 'failed' && serverSubmission.retryable) {
			serverSubmission = { status: 'pending' };
		}
		const updated = { ...seal, localStats, serverSubmission };
		state.sealedCompletion = updated;
		if (localStats.status === 'pending') {
			emit({ type: 'completion_effect_request', effect: 'local_stats', seal: updated });
		}
		if (serverSubmission.status === 'pending') {
			emit({ type: 'completion_effect_request', effect: 'server_submission', seal: updated });
		}
		notify();
		return { type: 'completion_sealed', seal: updated };
	}

	// --- Undo / redo ----------------------------------------------------------

	function doUndo(): PuzzleSessionOutcome {
		if (!placementHistory.canUndo()) {
			return {
				type: 'history_noop',
				reason: placementHistory.getCurrent() === undefined ? 'empty' : 'at_start'
			};
		}
		const previous = placementHistory.undo();
		if (previous === undefined) {
			return { type: 'history_noop', reason: 'at_start' };
		}
		const wasCompleted = state.lifecycle === 'completed';
		applyHistorySnapshot(previous);
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
		if (next === undefined) {
			return { type: 'history_noop', reason: 'at_end' };
		}
		applyHistorySnapshot(next);
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

	// --- Dispatch -------------------------------------------------------------

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
				return doRetryCompletionEffects();
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
		organization: null,
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
