<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onDestroy, untrack } from 'svelte';
	import { ApiError, recordCompletion } from '$lib/services/api';
	import { loadPuzzleSource, type LoadedPuzzleSource } from '$lib/services/puzzleSource';
	import { getBestTime, recordLocalCompletion } from '$lib/services/stats';
	import type { TimerState } from '$lib/stores/timer';
	import type { Puzzle, PlacedPiece } from '$lib/types/puzzle';
	import type { Rotation } from '$lib/types/gameplay';
	import PuzzleBoardPanel from '$lib/components/PuzzleBoardPanel.svelte';
	import PuzzleInventoryPanel from '$lib/components/PuzzleInventoryPanel.svelte';
	import PuzzleCompletionDialog from '$lib/components/PuzzleCompletionDialog.svelte';
	import MissionSetupDialog from '$lib/components/MissionSetupDialog.svelte';
	import SessionPauseDialog from '$lib/components/SessionPauseDialog.svelte';
	import DiscardSessionDialog from '$lib/components/DiscardSessionDialog.svelte';
	import GameTimer from '$lib/components/GameTimer.svelte';
	import {
		DEFAULT_GAMEPLAY_PREFERENCES,
		loadGameplayPreferences,
		saveGameplayPreferences,
		type GameplayPreferences
	} from '$lib/services/gameplay/session/preferences';
	import { resolve } from '$app/paths';
	import {
		DESKTOP_TRAY_BASE_WIDTH,
		DESKTOP_TRAY_MIN_WIDTH,
		DESKTOP_TRAY_SEPARATOR_WIDTH,
		clampTrayWidth,
		getDefaultPuzzleTrayWidth,
		getResponsivePuzzleBoardMetrics,
		type ResponsivePuzzleBoardMetrics
	} from '$lib/services/puzzleLayout';
	import { createGameplayRuntimeDependencies } from '$lib/services/gameplay/runtime';
	import {
		createPuzzleSessionStore,
		type PuzzleSessionStore
	} from '$lib/services/gameplay/session/store';
	import {
		createSessionStorageAdapter,
		serializeSession,
		isFailureRetryable
	} from '$lib/services/gameplay/session/persistence';
	import type {
		Clock,
		PuzzleMetadata,
		PuzzleSessionState,
		PuzzleSessionEvent,
		SealedCompletion,
		CompletionFailureCode,
		InventoryFilter
	} from '$lib/services/gameplay/session/types';
	import { completionRequestFromSeal } from '$lib/services/gameplay/session/types';
	import { playerAuth } from '$lib/stores/playerAuth';
	import { shuffleArray } from '$lib/utils/shuffle';

	const REJECTED_DURATION_MS = 500;
	const CHECKPOINT_INTERVAL_MS = 5_000;

	function createBrowserClock(): Clock {
		return {
			monotonicNow: () => performance.now(),
			wallNow: () => Date.now(),
			setInterval: (cb: () => void, ms: number) => globalThis.setInterval(cb, ms),
			clearInterval: (handle: unknown) =>
				globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
		};
	}

	const sessionStorageAdapter = createSessionStorageAdapter();
	const clock = createBrowserClock();

	let puzzle: Puzzle | null = $state(null);
	let puzzleSource: LoadedPuzzleSource | null = $state(null);
	let loading = $state(true);
	let error: string | null = $state(null);
	let errorStatus: number | null = $state(null);
	let showCelebration = $state(false);
	let rejectedPiece: number | null = $state(null);
	let activeHintPieceId = $state<number | null>(null);
	let activeHintTarget = $state<{ x: number; y: number } | null>(null);
	let boardViewResetVersion = $state(0);
	let referencePointerId = $state<number | null>(null);
	let referenceHoldSource = $state<'pointer' | 'keyboard' | null>(null);
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 900);
	let gameLayoutElement = $state<HTMLElement | null>(null);
	let gameLayoutWidth = $state(0);
	let requestedTrayWidth = $state(DESKTOP_TRAY_BASE_WIDTH);
	let trayResizePointerId = $state<number | null>(null);
	let trayResizeStartX = $state(0);
	let trayResizeStartWidth = $state(DESKTOP_TRAY_BASE_WIDTH);

	const appliedTrayWidth = $derived(
		gameLayoutWidth > 0 ? clampTrayWidth(gameLayoutWidth, requestedTrayWidth) : requestedTrayWidth
	);

	// Route-owned polite status region: the single synchronous announcement
	// source for gameplay feedback, rendered outside the inert page subtree so
	// screen readers hear it while a dialog or overlay holds focus.
	let gameplayAnnouncement = $state('');
	// Monotonic revision bumped on every announceGameplay call. The live
	// region's content node is wrapped in a {#key} block on this value so
	// consecutive identical messages (e.g. repeated rotations or placement
	// rejections) replace the node and re-trigger the screen-reader
	// announcement, which aria-live otherwise suppresses for unchanged text.
	let gameplayAnnouncementRevision = $state(0);

	function announceGameplay(message: string): void {
		gameplayAnnouncement = message;
		gameplayAnnouncementRevision += 1;
	}

	// Session-driven canonical state.
	let sessionStore: PuzzleSessionStore | null = $state(null);
	let sessionState = $state<PuzzleSessionState | null>(null);

	// Route-local session-control state. This state is never serialized:
	// it only drives dialog presentation and entry orchestration, while the
	// PuzzleSession store remains the sole canonical owner of run state.
	type SessionDialog = 'setup' | 'pause' | 'discard' | null;

	let sessionDialog = $state<SessionDialog>(null);
	let setupMandatory = $state(false);
	let setupDraft = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
	let devicePreferences = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
	// How the pause dialog presents itself: 'resume' (restored run awaiting
	// explicit re-engagement) or 'paused' (user-initiated toolbar pause).
	let pausePresentation = $state<'resume' | 'paused'>('paused');
	// True while the pause dialog shows the restart confirmation view.
	let restartConfirmation = $state(false);
	let bestTime: number | null = $state(null);
	let isNewBest = $state(false);
	// True when the local stats write failed for the current completion. The
	// in-memory new-best presentation is still shown, but the persisted-best
	// wording (NEW RECORD) is suppressed until the write succeeds.
	let localStatsFailed = $state(false);
	let activeLoadRequestId = 0;

	let sessionUnsubscribe: (() => void) | null = null;
	let checkpointInterval: ReturnType<typeof setInterval> | null = null;
	let rejectedPieceTimeout: ReturnType<typeof setTimeout> | null = null;

	// Track the previous player-auth status so a transition to authenticated
	// (login or session restore) triggers a one-shot retry of any unauthorized
	// server-submission failures. Hydration's auto-retry deliberately skips
	// unauthorized failures; this subscription closes that gap once auth is
	// actually present.
	let prevAuthStatus: 'loading' | 'authenticated' | 'anonymous' = 'loading';
	let authUnsubscribe: (() => void) | null = null;

	if (typeof window !== 'undefined') {
		window.addEventListener('pointerup', handleWindowPointerUp, true);
		window.addEventListener('pointercancel', handleWindowPointerUp, true);
		window.addEventListener('pointermove', handleWindowPointerMove);
		window.addEventListener('keydown', handleWindowKeyDown);
		window.addEventListener('blur', handleWindowBlur);
		window.addEventListener('resize', handleWindowResize);
		window.addEventListener('pagehide', handlePageHide);
		document.addEventListener('visibilitychange', handleVisibilityChange);
	}

	// Subscribe to playerAuth so a transition to authenticated triggers a
	// one-shot retry of any unauthorized server-submission failures. The
	// hydration auto-retry (loadPuzzle) deliberately skips unauthorized
	// failures; this subscription closes that gap once auth is present.
	authUnsubscribe = playerAuth.subscribe((authState) => {
		const prev = prevAuthStatus;
		prevAuthStatus = authState.status;
		// Only retry on a real transition into authenticated (not the initial
		// loading -> authenticated, which the hydration path handles for
		// non-unauthorized failures; and not authenticated -> authenticated
		// re-emissions).
		if (prev !== 'authenticated' && authState.status === 'authenticated') {
			sessionStore?.dispatch({
				type: 'retry_completion_effects',
				includeUnauthorized: true
			});
		}
	});

	onDestroy(() => {
		// Flush the clock and persist a final snapshot before disposing so
		// the periodic 5s checkpoint interval does not leave a data-loss
		// window of several seconds (including recent hint/reference usage).
		// This must run BEFORE sessionUnsubscribe: checkpointTime() updates the
		// store snapshot and notifies subscribers, which writes the fresh
		// value into sessionState; checkpointSession() then serializes that
		// fresh value. Unsubscribing first would leave sessionState stale, so
		// the final checkpoint would persist the pre-checkpoint elapsed time.
		persistSessionFinal();

		if (sessionUnsubscribe) {
			sessionUnsubscribe();
			sessionUnsubscribe = null;
		}
		if (authUnsubscribe) {
			authUnsubscribe();
			authUnsubscribe = null;
		}
		if (checkpointInterval !== null) {
			clearInterval(checkpointInterval);
			checkpointInterval = null;
		}

		if (rejectedPieceTimeout !== null) {
			clearTimeout(rejectedPieceTimeout);
			rejectedPieceTimeout = null;
		}

		if (typeof window !== 'undefined') {
			window.removeEventListener('pointerup', handleWindowPointerUp, true);
			window.removeEventListener('pointercancel', handleWindowPointerUp, true);
			window.removeEventListener('pointermove', handleWindowPointerMove);
			window.removeEventListener('keydown', handleWindowKeyDown);
			window.removeEventListener('blur', handleWindowBlur);
			window.removeEventListener('resize', handleWindowResize);
			window.removeEventListener('pagehide', handlePageHide);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}

		activeLoadRequestId += 1;
		if (puzzleSource) {
			puzzleSource.cleanup();
			puzzleSource = null;
		}
		if (sessionStore) {
			sessionStore.dispose();
			sessionStore = null;
		}
	});

	const puzzleId = $derived($page.params.id);

	// --- Session-derived canonical state -----------------------------------------
	const placedPieces = $derived<PlacedPiece[]>(sessionState?.placedPieces ?? []);
	const rotationEnabled = $derived(sessionState?.rotationEnabled ?? false);
	const pieceRotations = $derived<Record<number, Rotation>>(sessionState?.pieceRotations ?? {});
	const currentSelectedPieceId = $derived(sessionState?.selectedPieceId ?? null);
	const canUndo = $derived(sessionState?.canUndo ?? false);
	const canRedo = $derived(sessionState?.canRedo ?? false);
	// The session is the canonical owner of reference presentation; the route
	// only mirrors it for overlay visibility and the persistent pressed state.
	const activeReferenceMode = $derived(sessionState?.activeReferenceMode ?? null);
	const referenceActive = $derived(activeReferenceMode !== null);
	const referenceToggled = $derived(activeReferenceMode === 'toggle');
	// A retryable server-submission failure surfaces a manual retry affordance
	// in the celebration modal. The engine's retry_completion_effects action
	// re-emits the server_submission effect request, which re-runs
	// recordCompletion through handleServerSubmissionEffect.
	const serverSubmissionRetryable = $derived.by(() => {
		const submission = sessionState?.sealedCompletion?.serverSubmission;
		return submission?.status === 'failed' && submission.retryable === true;
	});
	const timerState = $derived<TimerState>({
		elapsed: sessionState?.elapsedActiveSeconds ?? 0,
		running: sessionState?.lifecycle === 'active' && (sessionState?.timerStarted ?? false)
	});

	// Presentation gating for the HUD timer and completion stats. Relaxed
	// runs have no clock; timed runs show the elapsed time and completion stats.
	const showTimedPresentation = $derived(sessionState?.mode === 'timed');
	const showRelaxedPresentation = $derived(sessionState?.mode === 'relaxed');

	// Setup may be reopened while the run is active but has not yet seen any
	// user activity. After the first placement the choices are locked.
	const canOpenSetup = $derived(
		sessionState?.lifecycle === 'active' && sessionState.hasUserActivity === false
	);

	// The Pause control is only meaningful while a run is actively playing:
	// on a completed session (celebration dismissed) pausing would open a
	// dialog whose Resume is a no-op.
	const canPause = $derived(sessionState?.lifecycle === 'active');

	// Any open session dialog (or the celebration modal) makes the page inert
	// so focus and interaction stay contained in the dialog surface.
	const hasSessionModal = $derived(sessionDialog !== null || showCelebration);

	const placedPieceIds = $derived.by(
		() => new Set(placedPieces.map((placement) => placement.pieceId))
	);

	const activeInventoryFilter = $derived<InventoryFilter>(
		sessionState?.organization?.filter ?? 'all'
	);
	const boardMetrics: ResponsivePuzzleBoardMetrics | null = $derived(
		puzzle
			? getResponsivePuzzleBoardMetrics(
					puzzle,
					{ width: viewportWidth, height: viewportHeight },
					appliedTrayWidth
				)
			: null
	);

	$effect(() => {
		const layout = gameLayoutElement;
		if (!layout) return;

		const update = () => {
			gameLayoutWidth = layout.clientWidth;
		};
		update();

		const observer = new ResizeObserver(update);
		observer.observe(layout);
		return () => observer.disconnect();
	});

	function requestBoardViewReset(): void {
		boardViewResetVersion += 1;
	}

	const progressPct = $derived.by(() => {
		if (!puzzle || puzzle.pieceCount === 0) return 0;
		if (placedPieces.length >= puzzle.pieceCount) return 100;
		return Math.floor((placedPieces.length / puzzle.pieceCount) * 100);
	});

	$effect(() => {
		if (puzzleId) {
			void loadPuzzle(puzzleId);
		}
	});

	function handleWindowResize() {
		viewportWidth = window.innerWidth;
		viewportHeight = window.innerHeight;
		if (gameLayoutElement) gameLayoutWidth = gameLayoutElement.clientWidth;
	}

	function setRequestedTrayWidth(width: number): void {
		if (gameLayoutWidth <= 0) return;
		requestedTrayWidth = clampTrayWidth(gameLayoutWidth, width);
	}

	function currentMaxTrayWidth(): number {
		if (gameLayoutWidth <= 0) return Math.max(DESKTOP_TRAY_MIN_WIDTH, appliedTrayWidth);
		return clampTrayWidth(gameLayoutWidth, Number.POSITIVE_INFINITY);
	}

	function isPiecePlaced(pieceId: number): boolean {
		return placedPieceIds.has(pieceId);
	}

	function isRotationToggleLocked(): boolean {
		return placedPieces.length > 0;
	}

	function handleSelectPiece(id: number) {
		const outcome = sessionStore?.dispatch({ type: 'select_piece', pieceId: id });
		if (outcome?.type === 'selection_changed' && outcome.pieceId === id) {
			announceGameplay(`Puzzle piece ${id} selected.`);
		}
	}

	function handleCancelSelection() {
		const hadSelection = currentSelectedPieceId !== null;
		const outcome = sessionStore?.dispatch({ type: 'cancel_selection' });
		if (hadSelection && outcome?.type === 'selection_changed' && outcome.pieceId === null) {
			announceGameplay('Selection canceled.');
		}
	}

	// --- Persistence -------------------------------------------------------------

	function checkpointSession() {
		if (!sessionStore || !sessionState || !puzzle) return;
		if (sessionState.lifecycle === 'disposed') return;
		const serialized = serializeSession(sessionState);
		if (serialized) {
			sessionStorageAdapter.saveSession(puzzle.id, serialized);
		}
	}

	/**
	 * Flush the session clock into elapsedActiveSeconds and persist the
	 * snapshot immediately. Used before teardown and page hide to minimize
	 * the data-loss window of the periodic 5s checkpoint.
	 */
	function persistSessionFinal() {
		if (!sessionStore || !sessionState || !puzzle) return;
		if (sessionState.lifecycle === 'disposed') return;
		sessionStore.checkpointTime();
		checkpointSession();
	}

	function handlePageHide() {
		persistSessionFinal();
	}

	// --- Completion effects -------------------------------------------------------

	function mapCompletionError(err: unknown): {
		code: CompletionFailureCode;
		retryable: boolean;
	} {
		let code: CompletionFailureCode;
		if (err instanceof ApiError) {
			switch (err.status) {
				case 400:
					code = 'bad_request';
					break;
				case 401:
					code = 'unauthorized';
					break;
				case 404:
					code = 'not_found';
					break;
				case 409:
					code = 'run_id_conflict';
					break;
				case 429:
					code = 'completion_quota_exceeded';
					break;
				default:
					code = 'internal_error';
					break;
			}
		} else {
			code = 'network_error';
		}
		// Derive retryable from the shared policy so the persisted flag stays
		// consistent with the persistence validator's isFailureRetryable.
		return { code, retryable: isFailureRetryable(code) };
	}

	async function handleLocalStatsEffect(seal: SealedCompletion) {
		if (!puzzle) return;
		// Capture the originating puzzle + run before awaiting: the Web Lock
		// write can be queued behind another tab. If the user hits Play Again
		// or navigates to another puzzle while the write is pending, the stale
		// completion must not reopen the modal or apply its best-time
		// presentation to the new run. The acknowledge dispatch below is
		// run-id guarded by the engine, but the UI mutations are not, so they
		// are fenced here against the current session's active seal.
		const originPuzzleId = puzzle.id;
		const originRunId = seal.runId;
		const result = await recordLocalCompletion(originPuzzleId, seal);

		// A delayed response from an earlier run is ignored for UI purposes.
		// The acknowledge is still dispatched; the engine rejects it as a
		// run_id_mismatch no-op when the run no longer matches. `sessionState`
		// is the route's live mirror of the store (updated synchronously on
		// dispatch), so after Play Again (restart → null seal) or navigation
		// (new puzzle id) the stale run no longer matches.
		const stillActiveRun =
			puzzle?.id === originPuzzleId && sessionState?.sealedCompletion?.runId === originRunId;

		if (stillActiveRun) {
			if (result.status === 'failed') {
				isNewBest = result.isNewStandardBest;
				bestTime = result.inMemoryStats.standardBestTime;
				localStatsFailed = true;
			} else {
				isNewBest = result.isNewStandardBest;
				bestTime = result.stats.standardBestTime;
				localStatsFailed = false;
			}
			// Do not independently reopen the celebration modal here. The
			// completion_sealed and lifecycle->completed events already open
			// it when the run seals. Reopening on the local-stats resolution
			// would re-trigger a modal the user deliberately dismissed
			// (Escape / Play Again's dismissal path) whenever the Web-Lock
			// write resolves late against the same retained seal — e.g. after
			// undoing the final move, which retains the seal. The badge data
			// above still updates for the active run.
		}

		sessionStore?.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result:
				result.status === 'failed'
					? { status: 'failed', code: 'storage_error', retryable: true }
					: { status: 'succeeded' }
		});
	}

	async function handleServerSubmissionEffect(seal: SealedCompletion) {
		if (!puzzle || puzzleSource?.source !== 'api') return;

		try {
			await recordCompletion(puzzle.id, completionRequestFromSeal(seal));
			sessionStore?.dispatch({
				type: 'acknowledge_completion_effect',
				runId: seal.runId,
				effect: 'server_submission',
				result: { status: 'succeeded' }
			});
		} catch (err) {
			const { code, retryable } = mapCompletionError(err);
			console.error('Failed to submit completion to server', err);
			sessionStore?.dispatch({
				type: 'acknowledge_completion_effect',
				runId: seal.runId,
				effect: 'server_submission',
				result: { status: 'failed', code, retryable }
			});
		}
	}

	function handleRetryServerSubmission() {
		// Re-emits any retryable-failed completion effects (here, the server
		// submission). The engine resets the effect to pending and fires a new
		// completion_effect_request, which handleServerSubmissionEffect picks
		// up. includeUnauthorized lets an explicit user retry attempt an
		// unauthorized submission (e.g. after the user logs in).
		sessionStore?.dispatch({
			type: 'retry_completion_effects',
			includeUnauthorized: true
		});
	}

	function handleSessionEvent(event: PuzzleSessionEvent) {
		if (event.type === 'completion_sealed') {
			showCelebration = true;
		} else if (event.type === 'completion_effect_request') {
			if (event.effect === 'local_stats') {
				void handleLocalStatsEffect(event.seal);
			} else if (event.effect === 'server_submission') {
				void handleServerSubmissionEffect(event.seal);
			}
		} else if (
			event.type === 'lifecycle' &&
			event.to === 'completed' &&
			event.from !== 'completed'
		) {
			showCelebration = true;
		} else if (event.type === 'placement_accepted') {
			if (activeHintPieceId === event.pieceId) {
				clearHintTarget();
			}
			announceGameplay(
				event.completed
					? `Puzzle piece ${event.pieceId} placed. Puzzle complete.`
					: `Puzzle piece ${event.pieceId} placed.`
			);
		} else if (event.type === 'placement_rejected') {
			announceGameplay(
				event.reason === 'non_upright'
					? `Puzzle piece ${event.pieceId} must be upright.`
					: `Puzzle piece ${event.pieceId} does not fit there.`
			);
			if (rejectedPieceTimeout !== null) {
				clearTimeout(rejectedPieceTimeout);
			}
			rejectedPiece = event.pieceId;
			rejectedPieceTimeout = setTimeout(() => {
				rejectedPiece = null;
				rejectedPieceTimeout = null;
			}, REJECTED_DURATION_MS);
		} else if (event.type === 'hint_target') {
			if (event.pieceId !== null && event.target) {
				announceGameplay(
					`Hint: puzzle piece ${event.pieceId} goes to row ${event.target.y + 1}, ` +
						`column ${event.target.x + 1}.`
				);
				showHintTarget(event.pieceId, event.target);
			} else {
				clearHintTarget();
			}
		}
	}

	async function loadPuzzle(id: string) {
		const requestId = ++activeLoadRequestId;
		loading = true;
		error = null;
		errorStatus = null;

		try {
			const priorSource = untrack(() => puzzleSource);
			if (priorSource) {
				priorSource.cleanup();
				puzzleSource = null;
			}
			// Flush the prior session's clock and persist a final snapshot
			// before tearing it down. When switching directly between
			// /puzzle/[id] routes the component is reused and onDestroy does
			// not fire, so without this flush recent activity since the last
			// 5-second checkpoint would be lost. untrack prevents the $state
			// reads inside persistSessionFinal from registering as effect
			// dependencies (which would re-trigger loadPuzzle infinitely).
			untrack(persistSessionFinal);
			// Dispose any prior session before constructing a new one.
			const priorUnsub = untrack(() => sessionUnsubscribe);
			const priorCheckpoint = untrack(() => checkpointInterval);
			const priorStore = untrack(() => sessionStore);
			if (priorUnsub) {
				priorUnsub();
				sessionUnsubscribe = null;
			}
			if (priorCheckpoint !== null) {
				clearInterval(priorCheckpoint);
				checkpointInterval = null;
			}
			if (priorStore) {
				priorStore.dispose();
				sessionStore = null;
				sessionState = null;
			}

			// Route-local dialog state is never serialized; clear it as soon
			// as the prior session is torn down and BEFORE the next puzzle
			// fetch, so a stale dialog or celebration cannot linger over the
			// loading screen or the error panel if the load fails. The entry
			// handling below re-opens dialogs as needed from the new puzzle's
			// restored state.
			sessionDialog = null;
			restartConfirmation = false;
			showCelebration = false;
			referencePointerId = null;
			referenceHoldSource = null;
			// The route-owned announcer is route-local presentation state too:
			// a stale status (e.g. "Puzzle complete.") must not survive direct
			// puzzle-to-puzzle navigation, where the component is reused.
			gameplayAnnouncement = '';

			const source = await loadPuzzleSource(id);
			if (requestId !== activeLoadRequestId) {
				source.cleanup();
				return;
			}
			const loadedPuzzle = source.puzzle;
			puzzleSource = source;

			// Build session metadata and validation context.
			const metadata: PuzzleMetadata = {
				puzzleId: loadedPuzzle.id,
				source: source.source,
				pieceCount: loadedPuzzle.pieceCount,
				gridCols: loadedPuzzle.gridCols,
				gridRows: loadedPuzzle.gridRows,
				pieces: loadedPuzzle.pieces.map((p) => ({
					id: p.id,
					correctX: p.correctX,
					correctY: p.correctY
				}))
			};

			// Load and validate the current persisted session.
			const loadResult = sessionStorageAdapter.loadSession(loadedPuzzle.id, {
				puzzleId: loadedPuzzle.id,
				source: source.source,
				pieceIds: loadedPuzzle.pieces.map((p) => p.id),
				gridCols: loadedPuzzle.gridCols,
				gridRows: loadedPuzzle.gridRows,
				pieceCount: loadedPuzzle.pieceCount,
				pieces: loadedPuzzle.pieces.map((p) => ({
					id: p.id,
					correctX: p.correctX,
					correctY: p.correctY
				}))
			});

			const restored = loadResult.status === 'loaded' ? loadResult.snapshot : undefined;

			puzzle = loadedPuzzle;
			requestedTrayWidth = getDefaultPuzzleTrayWidth(loadedPuzzle, {
				width: viewportWidth,
				height: viewportHeight
			});
			// Restore the celebration modal for a previously completed session
			// so the user retains access to Play Again and retry controls.
			// Fresh sessions start without the modal. (The
			// dialog/celebration reset itself ran before the fetch above.)
			showCelebration = restored?.lifecycle === 'completed';
			clearHintTarget();
			if (rejectedPieceTimeout !== null) {
				clearTimeout(rejectedPieceTimeout);
				rejectedPieceTimeout = null;
			}
			rejectedPiece = null;
			bestTime = getBestTime(id);
			isNewBest = false;
			localStatsFailed = false;

			// Construct the session store. Runtime gameplay dependencies (run-id
			// factory, tray order, rotations) are sourced from the gameplay runtime
			// adapter, which the E2E harness can override for deterministic play.
			const pieceIds = loadedPuzzle.pieces.map((piece) => piece.id);
			const runtime = createGameplayRuntimeDependencies(loadedPuzzle.id, pieceIds);

			const store = createPuzzleSessionStore({
				metadata,
				runIdFactory: runtime.runIdFactory,
				clock,
				restored,
				initialTrayOrder: runtime.createInitialTrayOrder(pieceIds),
				createTrayOrder: () => runtime.createRestartTrayOrder(pieceIds),
				createRotations: (requestedPieceIds: number[]) =>
					runtime.createRotations(loadedPuzzle.id, requestedPieceIds),
				onEvent: handleSessionEvent
			});
			sessionStore = store;
			sessionState = null;

			// Subscribe for reactive state updates.
			sessionUnsubscribe = store.subscribe((state) => {
				sessionState = state;
			});

			// Initialize the session with the current page visibility so the
			// engine's hidden-time exclusion is correct from the first tick.
			store.setDocumentHidden(typeof document !== 'undefined' ? document.hidden : false);

			// Route entry: a fresh session is configured from device
			// preferences and either started immediately or presented as a
			// mandatory setup dialog. A restored setup session always presents
			// setup (Start Immediately applies only to fresh route entry).
			// Restored timed runs retain explicit resume through the pause dialog
			// ("Resume Mission"): active runs are paused and checkpointed, while paused
			// runs keep the dialog. Relaxed active runs stay active; paused runs resume
			// and checkpoint without a popup.
			devicePreferences = loadGameplayPreferences();

			if (!restored) {
				store.dispatch({
					type: 'configure_setup',
					mode: devicePreferences.mode,
					rotationEnabled: devicePreferences.rotationEnabled
				});
				if (devicePreferences.startImmediately) {
					store.dispatch({ type: 'start' });
				} else {
					showMissionSetup(true);
				}
			} else if (restored.lifecycle === 'setup') {
				showMissionSetup(true);
			} else if (restored.lifecycle === 'active') {
				if (restored.mode === 'timed') {
					store.dispatch({ type: 'pause' });
					checkpointSession();
					pausePresentation = 'resume';
					sessionDialog = 'pause';
				}
			} else if (restored.lifecycle === 'paused') {
				if (restored.mode === 'relaxed') {
					store.dispatch({ type: 'resume' });
					checkpointSession();
				} else {
					pausePresentation = 'resume';
					sessionDialog = 'pause';
				}
			}

			// Resume any pending completion effects that were interrupted by a
			// page close/navigate before the server submission or local stats
			// could be acknowledged. resume_completion_effects re-emits
			// completion_effect_request for effects still in the pending state.
			// retry_completion_effects resets retryable-failed effects to pending
			// and re-emits them, recovering persisted failures that the user has
			// not yet manually retried. Calling resume first then retry avoids
			// double-emit: resume only touches already-pending effects, retry
			// only touches failed effects — the two sets are disjoint.
			//
			// When auth is already authenticated at mount time (SPA navigation),
			// the auth subscription above fired before sessionStore existed and
			// no-oped. Include unauthorized effects in this retry so a persisted
			// unauthorized failure is recovered immediately rather than waiting
			// for an auth transition that will never come.
			if (restored?.sealedCompletion) {
				store.dispatch({ type: 'resume_completion_effects' });
				store.dispatch({
					type: 'retry_completion_effects',
					includeUnauthorized: prevAuthStatus === 'authenticated'
				});
			}

			// Periodic checkpoint.
			checkpointInterval = setInterval(() => {
				checkpointSession();
			}, CHECKPOINT_INTERVAL_MS);

			requestBoardViewReset();
		} catch (e) {
			if (requestId !== activeLoadRequestId) return;

			errorStatus = e instanceof ApiError ? e.status : null;
			if (e instanceof ApiError && e.status === 404) {
				sessionStorageAdapter.clearSession(id);
				error = 'Mission no longer available';
			} else {
				console.error(`Failed to load puzzle ${id}:`, e);
				error = 'Failed to load mission';
			}
		} finally {
			if (requestId === activeLoadRequestId) {
				loading = false;
			}
		}
	}

	function handlePiecePlaced(pieceId: number, x: number, y: number) {
		if (!sessionStore) return;
		sessionStore.dispatch({ type: 'attempt_placement', pieceId, x, y });
		checkpointSession();
	}

	function clearHintTarget(): void {
		activeHintPieceId = null;
		activeHintTarget = null;
	}

	function showHintTarget(pieceId: number, target: { x: number; y: number }): void {
		activeHintPieceId = pieceId;
		activeHintTarget = target;
	}

	function handleHint() {
		if (!sessionStore) return;
		sessionStore.dispatch({ type: 'use_hint' });
		checkpointSession();
	}

	function handleUndo() {
		if (!sessionStore) return;
		sessionStore.dispatch({ type: 'undo' });
		checkpointSession();
	}

	function handleRedo() {
		if (!sessionStore) return;
		sessionStore.dispatch({ type: 'redo' });
		checkpointSession();
	}

	function handleInventoryFilterChange(filter: InventoryFilter) {
		if (!sessionStore) return;
		sessionStore.dispatch({
			type: 'update_tray_organization',
			update: { type: 'set_filter', filter }
		});
		checkpointSession();
	}

	function handleInventoryShuffle() {
		if (!sessionStore || !sessionState) return;
		const unplacedPieceIds = sessionState.trayOrder.filter((id) => !placedPieceIds.has(id));
		if (unplacedPieceIds.length <= 1) return;
		sessionStore.dispatch({
			type: 'update_tray_organization',
			update: {
				type: 'reorder',
				trayId: 'main',
				pieceIds: shuffleArray([...unplacedPieceIds])
			}
		});
		checkpointSession();
	}

	function handleReferenceDown(event?: PointerEvent | KeyboardEvent) {
		const isPointerEvent = event instanceof PointerEvent;
		referenceHoldSource = isPointerEvent ? 'pointer' : 'keyboard';
		referencePointerId = isPointerEvent ? event.pointerId : null;
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: 'hold' });
		checkpointSession();
	}

	// Hold-only cleanup: ends a hold in the session and always resets the
	// route-local pointer/keyboard bookkeeping. The session mode is only
	// cleared when it is still a hold, so a stale release after Hold -> Toggle
	// cannot close the persistent reference.
	function clearReferenceHold(): void {
		const shouldClearMode = sessionState?.activeReferenceMode === 'hold';
		referencePointerId = null;
		referenceHoldSource = null;
		if (shouldClearMode) sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}

	function handleReferenceUp(event?: PointerEvent | KeyboardEvent) {
		if (referenceHoldSource === 'pointer') {
			if (event instanceof PointerEvent && event.pointerId === referencePointerId) {
				clearReferenceHold();
			}
			return;
		}
		if (referenceHoldSource === 'keyboard' && !(event instanceof PointerEvent)) {
			clearReferenceHold();
		}
	}

	function handleReferenceToggle(): void {
		if (!sessionStore || sessionState?.lifecycle !== 'active') return;
		const wasInactive = sessionState.activeReferenceMode === null;
		const nextMode = sessionState.activeReferenceMode === 'toggle' ? null : 'toggle';
		referencePointerId = null;
		referenceHoldSource = null;
		sessionStore.dispatch({ type: 'set_reference_mode', mode: nextMode });
		if (wasInactive && nextMode === 'toggle') checkpointSession();
	}

	function handleRotationToggle() {
		if (!sessionStore || isRotationToggleLocked()) return;
		sessionStore.dispatch({ type: 'set_rotation_mode', enabled: !rotationEnabled });
		checkpointSession();
	}

	function handlePieceRotate(pieceId: number) {
		if (!sessionStore || !rotationEnabled || isPiecePlaced(pieceId)) return;
		const outcome = sessionStore.dispatch({ type: 'rotate_piece', pieceId });
		if (outcome.type === 'piece_rotated') {
			announceGameplay(`Puzzle piece ${pieceId} rotated.`);
		}
		checkpointSession();
	}

	function handleWindowPointerUp(event: PointerEvent) {
		if (referenceHoldSource === 'pointer' && referencePointerId === event.pointerId) {
			clearReferenceHold();
		}
		if (trayResizePointerId === event.pointerId) {
			trayResizePointerId = null;
		}
	}

	function handleWindowPointerMove(event: PointerEvent): void {
		if (trayResizePointerId !== event.pointerId) return;
		const deltaX = event.clientX - trayResizeStartX;
		setRequestedTrayWidth(trayResizeStartWidth - deltaX);
	}

	function handleTrayResizePointerDown(event: PointerEvent): void {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		event.preventDefault();
		trayResizePointerId = event.pointerId;
		trayResizeStartX = event.clientX;
		trayResizeStartWidth = appliedTrayWidth;
	}

	function handleTrayResizeKeyDown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowLeft':
				event.preventDefault();
				setRequestedTrayWidth(appliedTrayWidth + 16);
				break;
			case 'ArrowRight':
				event.preventDefault();
				setRequestedTrayWidth(appliedTrayWidth - 16);
				break;
			case 'Home':
				event.preventDefault();
				setRequestedTrayWidth(DESKTOP_TRAY_MIN_WIDTH);
				break;
			case 'End':
				event.preventDefault();
				setRequestedTrayWidth(currentMaxTrayWidth());
				break;
		}
	}

	function handleWindowBlur() {
		// Hold ends on blur; the persistent Toggle survives because
		// clearReferenceHold only clears a hold mode.
		clearReferenceHold();
		trayResizePointerId = null;
		sessionStore?.dispatch({ type: 'cancel_selection' });
	}

	function handleVisibilityChange() {
		sessionStore?.setDocumentHidden(document.hidden);
		// When the document is hidden the engine suspends the timer and
		// checkpoints the in-memory clock. Persist the resulting snapshot
		// immediately so a mobile browser that kills the hidden page without
		// delivering pagehide does not lose the last visible interval.
		if (document.hidden) {
			checkpointSession();
		}
	}

	function handleWindowKeyDown(event: KeyboardEvent) {
		// Any open modal — the celebration overlay or a session dialog
		// (pause/discard/setup) — blocks gameplay shortcuts so undo/redo cannot
		// mutate placements behind the dialog while it is open.
		if (hasSessionModal) return;
		// Escape closes exactly the highest-priority gameplay layer: the
		// persistent reference overlay first (it visually obscures the board
		// and traps focus on its Close control), then a reference hold, then
		// the current selection. Only after those layers are exhausted do the
		// undo/redo shortcuts run, still gated against the persistent overlay.
		if (event.key === 'Escape' && referenceToggled) {
			event.preventDefault();
			handleReferenceToggle();
			return;
		}

		if (event.key === 'Escape') {
			if (sessionState?.activeReferenceMode === 'hold') {
				event.preventDefault();
				clearReferenceHold();
				return;
			}
			if (currentSelectedPieceId !== null) {
				event.preventDefault();
				handleCancelSelection();
				return;
			}
		}

		// The persistent reference overlay visually obscures the board and
		// traps keyboard focus on its Close control; gameplay shortcuts must
		// no-op while it is active so Ctrl+Z/Ctrl+Y cannot mutate placements
		// behind the overlay. Hold-to-Peek is transient and click-through, so
		// it is intentionally not gated here.
		if (referenceToggled) return;

		const key = event.key.toLowerCase();
		const modifierPressed = event.metaKey || event.ctrlKey;
		const isUndoShortcut = modifierPressed && !event.shiftKey && key === 'z';
		const isRedoShortcut = modifierPressed && ((event.shiftKey && key === 'z') || key === 'y');

		if (isUndoShortcut) {
			event.preventDefault();
			handleUndo();
			return;
		}

		if (isRedoShortcut) {
			event.preventDefault();
			handleRedo();
		}
	}

	// --- Session-control entry and setup ---------------------------------------

	// Seed the setup draft from the live session configuration when one
	// exists (fresh runs are pre-configured from device preferences before
	// the dialog opens), falling back to device preferences. Start Immediately
	// is a device preference, never a per-run session field.
	function draftFromSession(): GameplayPreferences {
		return {
			mode: sessionState?.mode ?? devicePreferences.mode,
			rotationEnabled: sessionState?.rotationEnabled ?? devicePreferences.rotationEnabled,
			startImmediately: devicePreferences.startImmediately
		};
	}

	function showMissionSetup(mandatory: boolean): void {
		setupDraft = draftFromSession();
		setupMandatory = mandatory;
		sessionDialog = 'setup';
	}

	function confirmMissionSetup(): void {
		if (!sessionStore || !sessionState) return;
		saveGameplayPreferences(setupDraft);
		devicePreferences = { ...setupDraft };

		if (sessionState.lifecycle === 'setup') {
			sessionStore.dispatch({
				type: 'configure_setup',
				mode: setupDraft.mode,
				rotationEnabled: setupDraft.rotationEnabled
			});
			sessionStore.dispatch({ type: 'start' });
			checkpointSession();
			sessionDialog = null;
			return;
		}

		const settingsChanged =
			setupDraft.mode !== sessionState.mode ||
			setupDraft.rotationEnabled !== sessionState.rotationEnabled;
		if (!settingsChanged) {
			sessionDialog = null;
			return;
		}

		// Reconfiguring an active pre-activity run composes restart →
		// configure_setup → start so the new choices get a fresh run and the
		// tray/rotation state is rebuilt deterministically.
		const next = { ...setupDraft };
		sessionStore.dispatch({ type: 'restart' });
		sessionStore.dispatch({
			type: 'configure_setup',
			mode: next.mode,
			rotationEnabled: next.rotationEnabled
		});
		sessionStore.dispatch({ type: 'start' });
		checkpointSession();
		requestBoardViewReset();
		sessionDialog = null;
	}

	function handleToolbarPause() {
		openPauseDialog('paused');
	}

	// --- Pause / resume / restart / exit composition ---------------------------

	// Consolidated route-local cleanup of transient gameplay presentation
	// (selection, hint, rejection animation). Pan cancellation is panel-local
	// and follows the interactionBlocked signal. Invoked before any lifecycle
	// transition so stale overlay/interaction cannot leak into the next
	// presentation. PuzzleSession remains the sole canonical owner of run
	// state (including reference mode, which the engine clears for every
	// non-active lifecycle target); this only touches route-local UI state.
	function clearTransientGameplayState(): void {
		sessionStore?.dispatch({ type: 'cancel_selection' });
		clearHintTarget();
		if (rejectedPieceTimeout !== null) clearTimeout(rejectedPieceTimeout);
		rejectedPieceTimeout = null;
		rejectedPiece = null;
	}

	function openPauseDialog(presentation: 'resume' | 'paused' = 'paused'): void {
		// Defensive guard: the pause dialog is only meaningful for a run that
		// is active or already paused. A programmatic call on a completed or
		// setup session (e.g. after the celebration modal was dismissed) must
		// not present "Mission Paused" — Resume would be a no-op behind it.
		if (sessionState?.lifecycle !== 'active' && sessionState?.lifecycle !== 'paused') return;
		if (sessionState?.lifecycle === 'active') {
			clearTransientGameplayState();
			const outcome = sessionStore?.dispatch({ type: 'pause' });
			checkpointSession();
			if (
				presentation === 'paused' &&
				outcome?.type === 'lifecycle_transitioned' &&
				outcome.to === 'paused'
			) {
				announceGameplay('Mission paused.');
			}
		}
		pausePresentation = presentation;
		restartConfirmation = false;
		sessionDialog = 'pause';
	}

	function resumeSession(): void {
		const outcome = sessionStore?.dispatch({ type: 'resume' });
		restartConfirmation = false;
		sessionDialog = null;
		if (outcome?.type === 'lifecycle_transitioned' && outcome.to === 'active') {
			announceGameplay('Mission resumed.');
		}
	}

	function restartWithCurrentChoices(): void {
		if (!sessionStore || !sessionState) return;
		const mode = sessionState.mode;
		const rotationEnabled = sessionState.rotationEnabled;

		clearTransientGameplayState();
		showCelebration = false;
		isNewBest = false;
		localStatsFailed = false;
		sessionStore.dispatch({ type: 'restart' });
		sessionStore.dispatch({ type: 'configure_setup', mode, rotationEnabled });
		// Checkpoint immediately so the new run's tray order and retained
		// organization survive an abrupt browser kill before the periodic
		// interval fires. The approved persistence contract requires an
		// immediate write after restart.
		checkpointSession();
		devicePreferences = loadGameplayPreferences();
		showMissionSetup(true);
		restartConfirmation = false;
		requestBoardViewReset();
	}

	function requestRestart(): void {
		if (sessionState?.hasUserActivity) {
			restartConfirmation = true;
			return;
		}
		restartWithCurrentChoices();
	}

	function handlePlayAgain() {
		if (!puzzle || !sessionStore) return;

		// Play Again is a deliberate abandonment of the current record. Clear
		// the current entry, then open setup with the current choices (no
		// auto-start).
		sessionStorageAdapter.clearSession(puzzle.id);
		restartWithCurrentChoices();
	}

	function exitToArcade(): void {
		clearTransientGameplayState();
		if (sessionState?.lifecycle === 'active') {
			sessionStore?.dispatch({ type: 'pause' });
		}
		persistSessionFinal();
		void goto(resolve('/'));
	}

	function requestDiscard(): void {
		sessionDialog = 'discard';
	}

	function cancelDiscard(): void {
		// Preserve 'resume' vs 'paused'.
		sessionDialog = 'pause';
	}

	function discardAndExit(): void {
		// Dispose before clearing so teardown and any in-flight checkpoint tick
		// see no live session to persist while navigation completes.
		if (checkpointInterval !== null) {
			clearInterval(checkpointInterval);
			checkpointInterval = null;
		}
		sessionStore?.dispose();
		sessionState = null;
		if (puzzle) sessionStorageAdapter.clearSession(puzzle.id);
		void goto(resolve('/'));
	}
</script>

<svelte:head>
	<title>{puzzle?.name || 'Mission'} | Perseus Arcade</title>
</svelte:head>

<div class="puzzle-page" inert={hasSessionModal} aria-hidden={hasSessionModal}>
	<!-- HUD Header -->
	<header class="hud-header">
		<div class="hud-left">
			<a
				href={resolve('/')}
				class="back-btn"
				aria-label="Return to arcade"
				data-testid="back-to-arcade-link"
				onclick={(e) => {
					e.preventDefault();
					exitToArcade();
				}}
			>
				<svg
					class="back-icon"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M10 19l-7-7m0 0l7-7m-7 7h18"
					/>
				</svg>
				<span>ARCADE</span>
			</a>
		</div>

		{#if puzzle}
			<div class="hud-center">
				<div class="mission-tag">// MISSION</div>
				<div class="mission-name">{puzzle.name.toUpperCase()}</div>
			</div>

			<div class="hud-right">
				<div class="progress-stat">
					<span class="stat-label">PIECES</span>
					<span class="stat-value"
						>{placedPieces.length}<span class="stat-total">/{puzzle.pieceCount}</span></span
					>
				</div>
				<div class="hud-divider"></div>
				{#if showTimedPresentation}
					<!-- GameTimer renders its own data-testid="game-timer"; the
					     wrapper stays testid-free so existing assertions keep
					     resolving to the timer block. -->
					<div>
						<GameTimer {timerState} {bestTime} />
					</div>
				{:else if showRelaxedPresentation}
					<div data-testid="relaxed-mode-indicator">RELAXED</div>
				{/if}
			</div>
		{/if}
	</header>

	<!-- Progress bar -->
	{#if puzzle}
		<div class="progress-bar-wrap">
			<div class="progress-bar-fill" style="width: {progressPct}%"></div>
		</div>
	{/if}

	<!-- Content -->
	<main class="puzzle-main">
		{#if loading}
			<div class="state-center">
				<div class="loading-ring"></div>
				<span class="state-label">LOADING MISSION...</span>
			</div>
		{:else if error}
			<div class="error-panel">
				<svg
					class="err-icon"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
				<h2 class="err-title">{error}</h2>
				<p class="err-sub">
					{#if errorStatus === 404}
						This mission may have been deleted.
					{:else}
						An error occurred while loading the mission. Please try again later.
					{/if}
				</p>
				<a href={resolve('/')} class="arcade-btn">RETURN TO ARCADE</a>
			</div>
		{:else if puzzle}
			{@const currentPuzzle = puzzle}
			{@const currentBoardMetrics = boardMetrics}
			{@const source = puzzleSource!}
			<div
				bind:this={gameLayoutElement}
				class="game-layout"
				data-board-tier={currentBoardMetrics?.tier}
				style={`--tray-width: ${appliedTrayWidth}px; --tray-resizer-width: ${DESKTOP_TRAY_SEPARATOR_WIDTH}px; ${
					currentBoardMetrics
						? `--board-width: ${currentBoardMetrics.boardWidth}px; --board-height: ${currentBoardMetrics.boardHeight}px; --board-cell-size: ${currentBoardMetrics.cellSize}px; --piece-slot-size: ${currentBoardMetrics.pieceSlotSize}px;`
						: ''
				}`}
			>
				<!-- Board panel -->
				<PuzzleBoardPanel
					puzzle={currentPuzzle}
					boardMetrics={currentBoardMetrics}
					{placedPieces}
					selectedPieceId={currentSelectedPieceId}
					{activeHintTarget}
					resolveImage={source.resolvePieceImage}
					referenceImageUrl={source.resolveReferenceImage() ?? null}
					{referenceActive}
					{referenceToggled}
					{canUndo}
					{canRedo}
					{canOpenSetup}
					{canPause}
					{rotationEnabled}
					rotationToggleDisabled={isRotationToggleLocked()}
					interactionBlocked={hasSessionModal}
					viewResetVersion={boardViewResetVersion}
					onPiecePlaced={handlePiecePlaced}
					onUndo={handleUndo}
					onRedo={handleRedo}
					onHint={handleHint}
					onReferenceDown={handleReferenceDown}
					onReferenceUp={handleReferenceUp}
					onReferenceToggle={handleReferenceToggle}
					onRotationToggle={handleRotationToggle}
					onPause={handleToolbarPause}
					onOpenSetup={() => showMissionSetup(false)}
				/>

				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					class="tray-resizer"
					data-testid="tray-resizer"
					role="separator"
					aria-label="Resize puzzle tray"
					aria-orientation="vertical"
					aria-valuemin={DESKTOP_TRAY_MIN_WIDTH}
					aria-valuemax={Math.round(currentMaxTrayWidth())}
					aria-valuenow={Math.round(appliedTrayWidth)}
					tabindex="0"
					onpointerdown={handleTrayResizePointerDown}
					onkeydown={handleTrayResizeKeyDown}
				></div>

				<!-- Inventory panel -->
				<PuzzleInventoryPanel
					puzzle={currentPuzzle}
					trayOrder={sessionState?.trayOrder ?? []}
					{placedPieces}
					{rotationEnabled}
					{pieceRotations}
					selectedPieceId={currentSelectedPieceId}
					{activeHintPieceId}
					rejectedPieceId={rejectedPiece}
					resolveImage={source.resolvePieceImage}
					onRotate={handlePieceRotate}
					onSelect={handleSelectPiece}
					onCancelSelection={handleCancelSelection}
					activeFilter={activeInventoryFilter}
					onFilterChange={handleInventoryFilterChange}
					onShuffle={handleInventoryShuffle}
				/>
			</div>
		{/if}
	</main>
</div>

<!-- Mission Complete Modal -->
{#if showCelebration && sessionState}
	<PuzzleCompletionDialog
		puzzleName={puzzle?.name ?? ''}
		resultClass={sessionState.sealedCompletion?.resultClass ?? sessionState.resultClass}
		elapsedSeconds={sessionState.sealedCompletion
			? sessionState.sealedCompletion.elapsedActiveSeconds
			: sessionState.elapsedActiveSeconds}
		pieceCount={sessionState.pieceCount}
		hintsUsed={sessionState.sealedCompletion?.hintsUsed ?? sessionState.counters.hintsUsed}
		incorrectAttempts={sessionState.sealedCompletion?.incorrectAttempts ??
			sessionState.counters.incorrectAttempts}
		rotationEnabled={sessionState.sealedCompletion?.rotationEnabled ?? sessionState.rotationEnabled}
		rotationUsed={sessionState.sealedCompletion?.rotationUsed ?? sessionState.facts.rotationUsed}
		{bestTime}
		{isNewBest}
		{localStatsFailed}
		{serverSubmissionRetryable}
		onRetryServerSubmission={handleRetryServerSubmission}
		onPlayAgain={handlePlayAgain}
		onBackToArcade={exitToArcade}
		onDismiss={() => (showCelebration = false)}
	/>
{/if}

<!-- Mission Setup Modal (outside the inert page) -->
{#if sessionDialog === 'setup'}
	<MissionSetupDialog
		puzzleName={puzzle?.name ?? ''}
		pieceCount={puzzle?.pieceCount ?? 0}
		gridCols={puzzle?.gridCols ?? 0}
		gridRows={puzzle?.gridRows ?? 0}
		draft={setupDraft}
		mandatory={setupMandatory}
		inputHelp="Choose your mode and rotation settings before starting. Hint affects timed results; Peek and Reference do not."
		onDraftChange={(draft) => (setupDraft = draft)}
		onStart={confirmMissionSetup}
		onCancel={() => (sessionDialog = null)}
		onExit={exitToArcade}
	/>
{/if}

<!-- Mission Pause Modal (outside the inert page) -->
{#if sessionDialog === 'pause'}
	<SessionPauseDialog
		presentation={pausePresentation}
		mode={sessionState?.mode ?? 'timed'}
		confirmingRestart={restartConfirmation}
		onResume={resumeSession}
		onRequestRestart={requestRestart}
		onConfirmRestart={restartWithCurrentChoices}
		onCancelRestart={() => (restartConfirmation = false)}
		onExit={exitToArcade}
		onDiscard={requestDiscard}
	/>
{/if}

<!-- Discard saved progress modal (outside the inert page) -->
{#if sessionDialog === 'discard'}
	<DiscardSessionDialog
		puzzleName={puzzle?.name ?? 'this mission'}
		onConfirm={discardAndExit}
		onCancel={cancelDiscard}
	/>
{/if}

<!-- Gameplay status announcer: a sibling of the (potentially inert) page so
     screen readers hear announcements while a dialog or overlay holds focus. -->
<div
	class="sr-only"
	role="status"
	aria-live="polite"
	aria-atomic="true"
	data-testid="gameplay-announcer"
	data-announcement-revision={gameplayAnnouncementRevision}
>
	{#key gameplayAnnouncementRevision}{gameplayAnnouncement}{/key}
</div>

<style>
	/* ===== PAGE STRUCTURE ===== */
	.puzzle-page {
		min-height: 100vh;
		background-color: var(--bg-0);
		background-image:
			linear-gradient(rgba(0, 240, 255, 0.02) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0, 240, 255, 0.02) 1px, transparent 1px);
		background-size: 40px 40px;
		display: flex;
		flex-direction: column;
	}

	/* Mobile: pin the page to the dynamic viewport so the board panel can shrink
	   (its .board-wrap scrolls) and the open inventory drawer's bottom stays
	   within the fold at 390x844. Desktop keeps the content-driven min-height so
	   the sidebar layout grows with the board. */
	@media (max-width: 1023px) {
		.puzzle-page {
			height: 100vh;
			height: 100dvh;
			min-height: 100vh;
			min-height: 100dvh;
		}
	}

	/* ===== HUD HEADER ===== */
	.hud-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1.25rem;
		background: var(--bg-1);
		border-bottom: 1px solid var(--border);
		gap: 1rem;
		flex-shrink: 0;
	}

	.hud-left {
		flex-shrink: 0;
	}

	.back-btn {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
		text-decoration: none;
		transition: color 0.15s ease;
		padding: 0.3rem 0;
	}

	.back-btn:hover {
		color: var(--accent);
	}

	.back-icon {
		width: 0.875rem;
		height: 0.875rem;
	}

	.hud-center {
		flex: 1;
		text-align: center;
		min-width: 0;
	}

	.mission-tag {
		font-family: var(--font-mono);
		font-size: 0.55rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		opacity: 0.6;
	}

	.mission-name {
		font-family: var(--font-display);
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: var(--text-0);
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	.hud-right {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		flex-shrink: 0;
	}

	.progress-stat {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.1rem;
	}

	.stat-label {
		font-family: var(--font-mono);
		font-size: 0.5rem;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.stat-value {
		font-family: var(--font-mono);
		font-size: 0.9rem;
		color: var(--text-0);
		letter-spacing: 0.05em;
	}

	.stat-total {
		color: var(--text-2);
		font-size: 0.75rem;
	}

	.hud-divider {
		width: 1px;
		height: 2rem;
		background: var(--border);
	}

	/* Progress bar */
	.progress-bar-wrap {
		height: 2px;
		background: var(--bg-3);
		flex-shrink: 0;
	}

	.progress-bar-fill {
		height: 100%;
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
		transition: width 0.3s ease;
	}

	/* ===== MAIN CONTENT ===== */
	.puzzle-main {
		min-height: 0;
		flex: 1;
		padding: 1.25rem;
		overflow: auto;
	}

	.state-center {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 5rem 0;
		gap: 1.5rem;
	}

	.loading-ring {
		width: 2.5rem;
		height: 2.5rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
		box-shadow: 0 0 20px var(--accent-glow);
	}

	.state-label {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.25em;
		color: var(--accent);
		animation: neon-flicker 3s ease-in-out infinite;
	}

	/* Error panel */
	.error-panel {
		max-width: 32rem;
		margin: 3rem auto;
		background: var(--bg-1);
		border: 1px solid var(--hot);
		padding: 3rem 2rem;
		text-align: center;
		box-shadow: 0 0 40px var(--hot-glow);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.875rem;
	}

	.err-icon {
		width: 3rem;
		height: 3rem;
		color: var(--hot);
		filter: drop-shadow(0 0 8px var(--hot));
	}

	.err-title {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-0);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.err-sub {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-2);
	}

	/* ===== GAME LAYOUT ===== */
	.game-layout {
		--piece-slot-size: 4rem;
		--inventory-gap: 0.375rem;
		--inventory-pad: 0.875rem;
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: minmax(0, 1fr) auto;
		min-height: 0;
		gap: 1.25rem;
		max-width: min(96rem, calc(100vw - 2rem));
		margin: 0 auto;
	}

	/* Mobile: fill the viewport-bound main so the board's 1fr row shrinks
	   (instead of the grid growing past the fold) and the auto inventory row
	   anchors to the bottom. Desktop stays content-sized. */
	@media (max-width: 1023px) {
		.game-layout {
			height: 100%;
		}
	}

	@media (min-width: 1024px) {
		.game-layout {
			grid-template-columns:
				minmax(0, 1fr)
				var(--tray-resizer-width)
				var(--tray-width);
			column-gap: 0;
		}

		.tray-resizer {
			display: block;
			cursor: col-resize;
			touch-action: none;
		}
	}

	@media (max-width: 1023px) {
		.tray-resizer {
			display: none;
		}
	}

	/* ===== REDUCED MOTION ACCESSIBILITY ===== */
	@media (prefers-reduced-motion: reduce) {
		.progress-bar-fill {
			transition: none;
		}

		.loading-ring {
			animation: none;
			box-shadow: none;
		}

		.state-label {
			animation: none;
		}

		.arcade-btn:hover {
			box-shadow: none;
			text-shadow: none;
		}

		.err-icon {
			filter: none;
		}

		.error-panel {
			box-shadow: none;
		}
	}
</style>
