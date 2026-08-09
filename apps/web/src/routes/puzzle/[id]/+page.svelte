<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onDestroy, untrack } from 'svelte';
	import { ApiError, recordCompletion } from '$lib/services/api';
	import { loadPuzzleSource, type LoadedPuzzleSource } from '$lib/services/puzzleSource';
	import { getBestTime, recordLocalCompletion } from '$lib/services/stats';
	import { formatTime } from '$lib/stores/timer';
	import type { TimerState } from '$lib/stores/timer';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Puzzle, PlacedPiece, PuzzlePiece as TPuzzlePiece } from '$lib/types/puzzle';
	import type { Rotation } from '$lib/types/gameplay';
	import type { ViewportBounds } from '$lib/services/gameplay/viewport';
	import { modalFocus } from '$lib/actions/modalFocus';
	import PuzzleBoard from '$lib/components/PuzzleBoard.svelte';
	import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
	import PuzzleToolbar from '$lib/components/PuzzleToolbar.svelte';
	import MissionSetupDialog from '$lib/components/MissionSetupDialog.svelte';
	import SessionPauseDialog from '$lib/components/SessionPauseDialog.svelte';
	import ExitSessionDialog from '$lib/components/ExitSessionDialog.svelte';
	import ZoomableBoardFrame from '$lib/components/ZoomableBoardFrame.svelte';
	import GameTimer from '$lib/components/GameTimer.svelte';
	import ReferenceOverlay from '$lib/components/ReferenceOverlay.svelte';
	import {
		DEFAULT_GAMEPLAY_PREFERENCES,
		loadGameplayPreferences,
		saveGameplayPreferences,
		type GameplayPreferences
	} from '$lib/services/gameplay/session/preferences';
	import { resolve } from '$app/paths';
	import {
		getResponsivePuzzleBoardMetrics,
		type ResponsivePuzzleBoardMetrics
	} from '$lib/services/puzzleLayout';
	import { clampZoom, clampPan, calculateFitZoom } from '$lib/services/gameplay/viewport';
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
		CompletionFailureCode
	} from '$lib/services/gameplay/session/types';
	import { completionRequestFromSeal } from '$lib/services/gameplay/session/types';
	import { playerAuth } from '$lib/stores/playerAuth';

	const REJECTED_DURATION_MS = 500;
	const HINT_DURATION_MS = 1800;
	const ZOOM_STEP = 0.2;
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
	let showReferenceOverlay = $state(false);
	let activeHintPieceId = $state<number | null>(null);
	let activeHintTarget = $state<{ x: number; y: number } | null>(null);
	let boardViewportElement = $state<HTMLElement | null>(null);
	let zoom = $state(1);
	let minZoom = $state(1);
	let maxZoom = $state(3);
	let panX = $state(0);
	let panY = $state(0);
	let isPanning = $state(false);
	let pendingViewportReset = $state(false);
	let referencePointerId = $state<number | null>(null);
	let referenceHoldSource = $state<'pointer' | 'keyboard' | null>(null);
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 900);

	// Session-driven canonical state.
	let sessionStore: PuzzleSessionStore | null = $state(null);
	let sessionState = $state<PuzzleSessionState | null>(null);

	// Route-local session-control state. This state is never serialized:
	// it only drives dialog presentation and entry orchestration, while the
	// PuzzleSession store remains the sole canonical owner of run state.
	type SessionDialog = 'setup' | 'pause' | 'exit' | null;

	let sessionDialog = $state<SessionDialog>(null);
	let setupMandatory = $state(false);
	let setupDraft = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
	let devicePreferences = $state<GameplayPreferences>({ ...DEFAULT_GAMEPLAY_PREFERENCES });
	// How the pause dialog presents itself: 'resume' (restored run awaiting
	// explicit re-engagement) or 'paused' (user-initiated toolbar pause).
	let pausePresentation = $state<'resume' | 'paused'>('paused');
	// True while the pause dialog shows the restart confirmation view.
	let restartConfirmation = $state(false);
	// Which lifecycle the exit request originated from, so Cancel can restore
	// the correct surface (active resumes the run; paused returns to pause).
	let exitOrigin = $state<'active' | 'paused'>('active');

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
	let hintTimeout: ReturnType<typeof setTimeout> | null = null;
	let activePanPointerId: number | null = null;
	let panStartClientX = 0;
	let panStartClientY = 0;

	// Track the previous player-auth status so a transition to authenticated
	// (login or session restore) triggers a one-shot retry of any unauthorized
	// server-submission failures. Hydration's auto-retry deliberately skips
	// unauthorized failures; this subscription closes that gap once auth is
	// actually present.
	let prevAuthStatus: 'loading' | 'authenticated' | 'anonymous' = 'loading';
	let authUnsubscribe: (() => void) | null = null;

	let panOriginX = 0;
	let panOriginY = 0;

	if (typeof window !== 'undefined') {
		window.addEventListener('pointermove', handleWindowPointerMove);
		window.addEventListener('pointerup', handleWindowPointerUp, true);
		window.addEventListener('pointercancel', handleWindowPointerUp, true);
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

		if (hintTimeout !== null) {
			clearTimeout(hintTimeout);
			hintTimeout = null;
		}

		if (typeof window !== 'undefined') {
			window.removeEventListener('pointermove', handleWindowPointerMove);
			window.removeEventListener('pointerup', handleWindowPointerUp, true);
			window.removeEventListener('pointercancel', handleWindowPointerUp, true);
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
	// runs have no clock; legacy-unknown restored runs have an elapsed value
	// that is not trustworthy. Both render a static indicator in place of the
	// live timer and a neutral completion without time/best fields.
	const showKnownTimedPresentation = $derived(
		sessionState?.mode === 'timed' && sessionState.timingQuality === 'known'
	);
	const showRelaxedPresentation = $derived(sessionState?.mode === 'relaxed');
	const showUnknownTimePresentation = $derived(
		sessionState?.mode === 'timed' && sessionState.timingQuality === 'legacy_unknown'
	);

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
	const canPanBoard = $derived(zoom > minZoom + 0.001);
	const boardMetrics: ResponsivePuzzleBoardMetrics | null = $derived(
		puzzle
			? getResponsivePuzzleBoardMetrics(puzzle, {
					width: viewportWidth,
					height: viewportHeight
				})
			: null
	);

	const piecesMap = $derived.by(() => {
		const map = new SvelteMap<number, TPuzzlePiece>();
		if (puzzle) {
			for (const piece of puzzle.pieces) {
				map.set(piece.id, piece);
			}
		}
		return map;
	});

	const shuffledPieces = $derived(
		(sessionState?.trayOrder ?? [])
			.map((id) => piecesMap.get(id))
			.filter((piece): piece is TPuzzlePiece => piece !== undefined)
	);

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

	$effect(() => {
		if (!pendingViewportReset || !puzzle || !boardViewportElement) return;
		resetViewport();
		pendingViewportReset = false;
	});

	function recomputeZoomBounds() {
		if (!puzzle || !boardViewportElement) return;
		const fitZoom = getFitZoom();
		minZoom = fitZoom;
		maxZoom = Math.max(fitZoom * 3, fitZoom + 1, 3);
		if (zoom < minZoom) {
			zoom = minZoom;
			panX = 0;
			panY = 0;
		} else if (zoom > maxZoom) {
			zoom = maxZoom;
			panX = 0;
			panY = 0;
		} else {
			const clampedPan = clampPan(panX, panY, getViewportBounds(zoom));
			panX = clampedPan.x;
			panY = clampedPan.y;
		}
	}

	$effect(() => {
		if (!boardViewportElement) return;
		const observer = new ResizeObserver(() => {
			recomputeZoomBounds();
		});
		observer.observe(boardViewportElement);
		return () => observer.disconnect();
	});

	function handleWindowResize() {
		viewportWidth = window.innerWidth;
		viewportHeight = window.innerHeight;
		recomputeZoomBounds();
	}

	function getDisplayedRotation(pieceId: number): Rotation {
		return rotationEnabled ? (pieceRotations[pieceId] ?? 0) : 0;
	}

	function isPiecePlaced(pieceId: number): boolean {
		return placedPieceIds.has(pieceId);
	}

	function isRotationToggleLocked(): boolean {
		return placedPieces.length > 0;
	}

	function handleSelectPiece(id: number) {
		sessionStore?.dispatch({ type: 'select_piece', pieceId: id });
	}

	function handleCancelSelection() {
		sessionStore?.dispatch({ type: 'cancel_selection' });
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
					? result.reason === 'incompatible_schema'
						? // A future-schema local-stats record was preserved
							// unread. This deployment can never overwrite it, so
							// the failure is terminal: auto-retry on hydration
							// would re-fail forever. The newer client that owns
							// the record must handle it on upgrade.
							{ status: 'failed', code: 'incompatible_schema', retryable: false }
						: // storage_error is recoverable: recordLocalCompletion
							// is idempotent per run id, so a replayed run does
							// not double count. Keeping it retryable lets the
							// next hydration re-drive the write instead of
							// permanently losing the completion count / personal
							// best.
							{ status: 'failed', code: 'storage_error', retryable: true }
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
		} else if (event.type === 'placement_rejected') {
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
				showHintTarget(event.pieceId, event.target);
			} else {
				clearHintTarget();
			}
		}
	}

	function getViewportBounds(scale = zoom): ViewportBounds {
		if (!puzzle || !boardViewportElement) {
			return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
		}

		const viewportWidth = boardViewportElement.clientWidth;
		const viewportHeight = boardViewportElement.clientHeight;
		const boardWidth = boardMetrics?.boardWidth ?? puzzle.imageWidth;
		const boardHeight = boardMetrics?.boardHeight ?? puzzle.imageHeight;
		const scaledWidth = boardWidth * scale;
		const scaledHeight = boardHeight * scale;
		const maxOffsetX = Math.max(0, (scaledWidth - viewportWidth) / 2);
		const maxOffsetY = Math.max(0, (scaledHeight - viewportHeight) / 2);

		return {
			minX: -maxOffsetX,
			maxX: maxOffsetX,
			minY: -maxOffsetY,
			maxY: maxOffsetY
		};
	}

	function getFitZoom(): number {
		if (!puzzle || !boardViewportElement) return 1;

		const viewportWidth = boardViewportElement.clientWidth;
		const viewportHeight = boardViewportElement.clientHeight;
		if (viewportWidth === 0 || viewportHeight === 0) return 1;
		const boardWidth = boardMetrics?.boardWidth ?? puzzle.imageWidth;
		const boardHeight = boardMetrics?.boardHeight ?? puzzle.imageHeight;
		if (boardWidth <= 0 || boardHeight <= 0) {
			console.error(
				`Puzzle ${puzzle.id} has invalid board dimensions: ${boardWidth}x${boardHeight}`
			);
			return 1;
		}

		return Math.min(1, calculateFitZoom(boardWidth, boardHeight, viewportWidth, viewportHeight, 1));
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
			// Restore the celebration modal for a previously completed session
			// so the user retains access to Play Again and retry controls.
			// Fresh sessions start without the modal. (The
			// dialog/celebration reset itself ran before the fetch above.)
			showCelebration = restored?.lifecycle === 'completed';
			showReferenceOverlay = false;
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
			// Restored active/paused runs are deliberately paused at entry and
			// presented for resume so the player re-engages explicitly.
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
				store.dispatch({ type: 'pause' });
				checkpointSession();
				pausePresentation = 'resume';
				sessionDialog = 'pause';
			} else if (restored.lifecycle === 'paused') {
				pausePresentation = 'resume';
				sessionDialog = 'pause';
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

			pendingViewportReset = true;
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
		if (activeHintPieceId === pieceId) {
			clearHintTarget();
		}
		sessionStore.dispatch({ type: 'attempt_placement', pieceId, x, y });
		checkpointSession();
	}

	function clearHintTarget() {
		if (hintTimeout !== null) {
			clearTimeout(hintTimeout);
			hintTimeout = null;
		}
		activeHintPieceId = null;
		activeHintTarget = null;
	}

	function showHintTarget(pieceId: number, target: { x: number; y: number }) {
		clearHintTarget();
		activeHintPieceId = pieceId;
		activeHintTarget = target;
		hintTimeout = setTimeout(() => {
			activeHintPieceId = null;
			activeHintTarget = null;
			hintTimeout = null;
		}, HINT_DURATION_MS);
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

	function handleReferenceDown(event?: PointerEvent | KeyboardEvent) {
		const isPointerEvent = event instanceof PointerEvent;
		referenceHoldSource = isPointerEvent ? 'pointer' : 'keyboard';
		referencePointerId = isPointerEvent ? event.pointerId : null;
		showReferenceOverlay = true;
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: 'hold' });
		checkpointSession();
	}

	function handleReferenceUp(event?: PointerEvent | KeyboardEvent) {
		if (referenceHoldSource === 'pointer' && !(event instanceof PointerEvent)) {
			return;
		}
		showReferenceOverlay = false;
		referencePointerId = null;
		referenceHoldSource = null;
		sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
	}

	function handleRotationToggle() {
		if (!sessionStore || isRotationToggleLocked()) return;
		sessionStore.dispatch({ type: 'set_rotation_mode', enabled: !rotationEnabled });
		checkpointSession();
	}

	function handlePieceRotate(pieceId: number) {
		if (!sessionStore || !rotationEnabled || isPiecePlaced(pieceId)) return;
		sessionStore.dispatch({ type: 'rotate_piece', pieceId });
		checkpointSession();
	}

	function setView(nextZoom: number, nextPanX = panX, nextPanY = panY) {
		const clampedScale = clampZoom(nextZoom, minZoom, maxZoom);
		const clampedPan = clampPan(nextPanX, nextPanY, getViewportBounds(clampedScale));
		zoom = clampedScale;
		panX = clampedPan.x;
		panY = clampedPan.y;
	}

	function resetViewport() {
		const fitZoom = getFitZoom();
		minZoom = fitZoom;
		maxZoom = Math.max(fitZoom * 3, fitZoom + 1, 3);
		zoom = fitZoom;
		panX = 0;
		panY = 0;
		isPanning = false;
		activePanPointerId = null;
	}

	function handleZoomIn() {
		setView(zoom + ZOOM_STEP);
	}

	function handleZoomOut() {
		setView(zoom - ZOOM_STEP);
	}

	function handleBoardWheel(event: WheelEvent) {
		event.preventDefault();
		const zoomFactor = event.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
		setView(zoom * zoomFactor);
	}

	function handleBoardPointerDown(event: PointerEvent) {
		if (!canPanBoard) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;

		event.preventDefault();
		isPanning = true;
		activePanPointerId = event.pointerId;
		panStartClientX = event.clientX;
		panStartClientY = event.clientY;
		panOriginX = panX;
		panOriginY = panY;
	}

	function handleWindowPointerMove(event: PointerEvent) {
		if (!isPanning || activePanPointerId !== event.pointerId) return;

		const deltaX = event.clientX - panStartClientX;
		const deltaY = event.clientY - panStartClientY;
		const clampedPan = clampPan(panOriginX + deltaX, panOriginY + deltaY, getViewportBounds());
		panX = clampedPan.x;
		panY = clampedPan.y;
	}

	function handleWindowPointerUp(event: PointerEvent) {
		if (referenceHoldSource === 'pointer' && referencePointerId === event.pointerId) {
			showReferenceOverlay = false;
			referencePointerId = null;
			referenceHoldSource = null;
			// End the reference hold in the session so a later press counts
			// as a new inactive-to-active activation.
			sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
		}

		if (activePanPointerId !== event.pointerId) return;

		isPanning = false;
		activePanPointerId = null;
	}

	function handleWindowBlur() {
		if (referenceHoldSource !== null) {
			sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
		}
		showReferenceOverlay = false;
		referencePointerId = null;
		referenceHoldSource = null;
		sessionStore?.dispatch({ type: 'cancel_selection' });
		isPanning = false;
		activePanPointerId = null;
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
		// (pause/exit/setup) — blocks gameplay shortcuts so undo/redo cannot
		// mutate placements behind the dialog while it is open.
		if (hasSessionModal) return;

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
		pendingViewportReset = true;
		sessionDialog = null;
	}

	function handleToolbarPause() {
		openPauseDialog('paused');
	}

	// --- Pause / resume / restart / exit composition ---------------------------

	// Consolidated route-local cleanup of transient gameplay presentation
	// (reference hold, selection, hint, rejection animation, panning). Invoked
	// before any lifecycle transition so a stale overlay/interaction cannot
	// leak into the next presentation. PuzzleSession remains the sole
	// canonical owner of run state; this only touches route-local UI state.
	function clearTransientGameplayState(): void {
		if (referenceHoldSource !== null) {
			sessionStore?.dispatch({ type: 'set_reference_mode', mode: null });
		}
		showReferenceOverlay = false;
		referencePointerId = null;
		referenceHoldSource = null;
		sessionStore?.dispatch({ type: 'cancel_selection' });
		clearHintTarget();
		if (rejectedPieceTimeout !== null) clearTimeout(rejectedPieceTimeout);
		rejectedPieceTimeout = null;
		rejectedPiece = null;
		isPanning = false;
		activePanPointerId = null;
	}

	function openPauseDialog(presentation: 'resume' | 'paused' = 'paused'): void {
		// Defensive guard: the pause dialog is only meaningful for a run that
		// is active or already paused. A programmatic call on a completed or
		// setup session (e.g. after the celebration modal was dismissed) must
		// not present "Mission Paused" — Resume would be a no-op behind it.
		if (sessionState?.lifecycle !== 'active' && sessionState?.lifecycle !== 'paused') return;
		if (sessionState?.lifecycle === 'active') {
			clearTransientGameplayState();
			sessionStore?.dispatch({ type: 'pause' });
			checkpointSession();
		}
		pausePresentation = presentation;
		restartConfirmation = false;
		sessionDialog = 'pause';
	}

	function resumeSession(): void {
		sessionStore?.dispatch({ type: 'resume' });
		restartConfirmation = false;
		sessionDialog = null;
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
		pendingViewportReset = true;
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

	function currentRunIsResumable(): boolean {
		if (!sessionState) return false;
		const snapshot = serializeSession(sessionState);
		return snapshot ? sessionStorageAdapter.isResumable(snapshot) : false;
	}

	function requestReturnToArcade(): void {
		if (!currentRunIsResumable()) {
			persistSessionFinal();
			void goto(resolve('/'));
			return;
		}

		exitOrigin = sessionState?.lifecycle === 'paused' ? 'paused' : 'active';
		if (exitOrigin === 'active') {
			clearTransientGameplayState();
			sessionStore?.dispatch({ type: 'pause' });
			checkpointSession();
		}
		sessionDialog = 'exit';
	}

	function saveAndExit(): void {
		persistSessionFinal();
		void goto(resolve('/'));
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

	function cancelExit(): void {
		if (exitOrigin === 'active') {
			sessionStore?.dispatch({ type: 'resume' });
			sessionDialog = null;
		} else {
			pausePresentation = 'paused';
			sessionDialog = 'pause';
		}
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
					requestReturnToArcade();
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
				{#if showKnownTimedPresentation}
					<!-- GameTimer renders its own data-testid="game-timer"; the
					     wrapper stays testid-free so existing assertions keep
					     resolving to the timer block. -->
					<div>
						<GameTimer {timerState} {bestTime} />
					</div>
				{:else if showRelaxedPresentation}
					<div data-testid="relaxed-mode-indicator">RELAXED</div>
				{:else if showUnknownTimePresentation}
					<div data-testid="time-unavailable-indicator">TIME UNAVAILABLE</div>
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
			<ReferenceOverlay
				imageUrl={puzzleSource?.resolveReferenceImage() ?? null}
				active={showReferenceOverlay}
			/>
			<div
				class="game-layout"
				data-board-tier={currentBoardMetrics?.tier}
				style={currentBoardMetrics
					? `--board-width: ${currentBoardMetrics.boardWidth}px; --board-height: ${currentBoardMetrics.boardHeight}px; --board-cell-size: ${currentBoardMetrics.cellSize}px; --piece-slot-size: ${currentBoardMetrics.pieceSlotSize}px;`
					: ''}
			>
				<!-- Board panel -->
				<div class="board-panel">
					<div class="panel-header">
						<span class="panel-tag">PUZZLE BOARD</span>
					</div>
					<div class="board-toolbar px-4 pt-3">
						<PuzzleToolbar
							onUndo={handleUndo}
							onRedo={handleRedo}
							onHint={handleHint}
							onReferenceDown={handleReferenceDown}
							onReferenceUp={handleReferenceUp}
							onZoomIn={handleZoomIn}
							onZoomOut={handleZoomOut}
							onResetView={resetViewport}
							onRotationToggle={handleRotationToggle}
							onPause={handleToolbarPause}
							onOpenSetup={() => showMissionSetup(false)}
							{canOpenSetup}
							{canPause}
							{canUndo}
							{canRedo}
							{rotationEnabled}
							rotationToggleDisabled={isRotationToggleLocked()}
							hasReference={currentPuzzle.hasReference === true}
						/>
					</div>
					<div class="board-wrap">
						<div
							class={`board-viewport flex min-h-72 items-center justify-center overflow-hidden ${
								isPanning
									? 'is-panning cursor-grabbing'
									: canPanBoard
										? 'can-pan cursor-grab touch-none'
										: ''
							}`}
							bind:this={boardViewportElement}
							data-testid="board-viewport"
						>
							<ZoomableBoardFrame scale={zoom} {panX} {panY} {isPanning} onWheel={handleBoardWheel}>
								<div
									class="board-canvas mx-auto"
									style={currentBoardMetrics
										? `--board-width: ${currentBoardMetrics.boardWidth}px; --board-height: ${currentBoardMetrics.boardHeight}px; --board-cell-size: ${currentBoardMetrics.cellSize}px; width: var(--board-width); height: var(--board-height);`
										: `width: ${currentPuzzle.imageWidth}px;`}
								>
									<PuzzleBoard
										puzzle={currentPuzzle}
										{placedPieces}
										onPiecePlaced={handlePiecePlaced}
										{activeHintTarget}
										onBoardPointerDown={handleBoardPointerDown}
										resolveImage={puzzleSource!.resolvePieceImage}
										selectedPieceId={currentSelectedPieceId}
									/>
								</div>
							</ZoomableBoardFrame>
						</div>
					</div>
				</div>

				<!-- Inventory panel -->
				<div class="inventory-panel">
					<div class="panel-header">
						<span class="panel-tag">INVENTORY</span>
						<span class="inv-count">{currentPuzzle.pieceCount - placedPieces.length} LEFT</span>
					</div>
					<div class="pieces-grid">
						{#each shuffledPieces as piece (piece.id)}
							{#if !isPiecePlaced(piece.id)}
								<div
									class={`piece-slot aspect-square border border-(--border) p-[0.2rem] transition-[border-color,box-shadow] duration-150 ${
										activeHintPieceId === piece.id
											? 'hinted border-(--accent) shadow-[0_0_14px_var(--accent-glow)]'
											: rejectedPiece === piece.id
												? 'rejected animate-shake border-(--hot) shadow-[0_0_12px_var(--hot-glow)]'
												: ''
									}`}
									style={currentBoardMetrics
										? `--piece-slot-size: ${currentBoardMetrics.pieceSlotSize}px;`
										: ''}
									data-testid={`piece-slot-${piece.id}`}
								>
									<PuzzlePiece
										{piece}
										isPlaced={false}
										{rotationEnabled}
										rotation={getDisplayedRotation(piece.id)}
										onRotate={handlePieceRotate}
										resolveImage={puzzleSource!.resolvePieceImage}
										selected={currentSelectedPieceId === piece.id}
										onSelect={handleSelectPiece}
										onCancelSelection={handleCancelSelection}
									/>
								</div>
							{/if}
						{/each}
					</div>
					{#if placedPieces.length === currentPuzzle.pieceCount}
						<div class="complete-msg">
							<span class="complete-icon">◆</span>
							ALL PIECES PLACED
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</main>
</div>

<!-- Mission Complete Modal -->
{#if showCelebration}
	<div
		class="modal-backdrop"
		data-testid="celebration-modal"
		role="presentation"
		onkeydown={(e) => e.key === 'Escape' && (showCelebration = false)}
	>
		<div
			class="modal-box"
			role="dialog"
			aria-modal="true"
			aria-labelledby="modal-title"
			use:modalFocus
		>
			<div class="modal-scan-line"></div>
			<div class="modal-top-line"></div>

			<div class="modal-tag">// MISSION COMPLETE</div>
			{#if showKnownTimedPresentation}
				<div class="modal-rank">S RANK</div>
			{/if}

			<h2 id="modal-title" class="modal-title">{puzzle?.name?.toUpperCase()}</h2>

			{#if showKnownTimedPresentation}
				<div class="modal-stats">
					<div class="modal-stat">
						<span class="mstat-label">FINAL TIME</span>
						<span class="mstat-value">{formatTime(timerState.elapsed)}</span>
					</div>
					{#if isNewBest}
						<div class="modal-stat new-best">
							<span class="mstat-label">PERSONAL BEST</span>
							<span class="mstat-value gold">{formatTime(bestTime ?? timerState.elapsed)}</span>
							{#if localStatsFailed}
								<span class="new-record-badge unsaved" data-testid="new-best-unsaved">UNSAVED</span>
							{:else}
								<span class="new-record-badge">NEW RECORD</span>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<div class="modal-bottom-line"></div>

			{#if serverSubmissionRetryable}
				<div class="modal-server-retry" role="alert" data-testid="server-retry-banner">
					<span class="server-retry-label">MISSION SYNC FAILED</span>
					<button
						onclick={handleRetryServerSubmission}
						class="arcade-btn-ghost"
						data-testid="retry-server-submission"
					>
						RETRY SYNC
					</button>
				</div>
			{/if}

			<div class="modal-actions">
				<button onclick={handlePlayAgain} class="arcade-btn">PLAY AGAIN</button>
				<button onclick={requestReturnToArcade} class="arcade-btn-ghost">BACK TO ARCADE</button>
			</div>
		</div>
	</div>
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
		inputHelp="Choose your mode and rotation settings before starting."
		onDraftChange={(draft) => (setupDraft = draft)}
		onStart={confirmMissionSetup}
		onCancel={() => (sessionDialog = null)}
		onExit={requestReturnToArcade}
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
		onExit={requestReturnToArcade}
	/>
{/if}

<!-- Exit Mission Modal (outside the inert page) -->
{#if sessionDialog === 'exit'}
	<ExitSessionDialog onSave={saveAndExit} onDiscard={discardAndExit} onCancel={cancelExit} />
{/if}

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
		gap: 1.25rem;
		max-width: min(96rem, calc(100vw - 2rem));
		margin: 0 auto;
	}

	@media (min-width: 1024px) {
		.game-layout {
			grid-template-columns:
				minmax(0, 1fr)
				minmax(
					17.5rem,
					calc(
						var(--piece-slot-size) * 3 + var(--inventory-gap) * 2 + var(--inventory-pad) * 2 + 2px
					)
				);
		}
	}

	/* Board panel */
	.board-panel {
		background: var(--bg-1);
		border: 1px solid var(--border);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-2);
	}

	.panel-tag {
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.board-wrap {
		padding: clamp(0.75rem, 2vw, 1.25rem);
		overflow: auto;
	}

	.board-canvas {
		width: var(--board-width);
		height: var(--board-height);
	}

	/* Inventory panel */
	.inventory-panel {
		background: var(--bg-1);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}

	.inv-count {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.15em;
	}

	.pieces-grid {
		display: grid;
		grid-template-columns: repeat(
			auto-fill,
			minmax(var(--piece-slot-size), var(--piece-slot-size))
		);
		justify-content: center;
		align-content: start;
		gap: var(--inventory-gap);
		padding: var(--inventory-pad);
		overflow-y: auto;
		flex: 1;
	}

	@media (min-width: 640px) and (max-width: 1023px) {
		.pieces-grid {
			grid-template-columns: repeat(
				auto-fill,
				minmax(var(--piece-slot-size), var(--piece-slot-size))
			);
		}
	}

	.piece-slot {
		width: var(--piece-slot-size);
		height: var(--piece-slot-size);
	}

	.complete-msg {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.875rem;
		font-family: var(--font-display);
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.2em;
		color: var(--green);
		text-shadow: 0 0 12px var(--green);
		border-top: 1px solid var(--border);
	}

	.complete-icon {
		font-size: 0.5rem;
		text-shadow: 0 0 8px var(--green);
	}

	/* ===== CELEBRATION MODAL ===== */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(4, 4, 13, 0.9);
		backdrop-filter: blur(6px);
	}

	.modal-box {
		position: relative;
		background: var(--bg-1);
		border: 1px solid var(--accent);
		padding: 2.5rem 2rem;
		text-align: center;
		max-width: 24rem;
		width: calc(100% - 2rem);
		box-shadow:
			0 0 60px var(--accent-glow-strong),
			0 0 120px var(--accent-glow),
			inset 0 0 60px rgba(0, 240, 255, 0.03);
		animation: celebration-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
		overflow: hidden;
	}

	/* Animated scan line inside modal */
	.modal-scan-line {
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		background: linear-gradient(90deg, transparent, var(--accent-dim), transparent);
		animation: scan 2s linear infinite;
		pointer-events: none;
	}

	@keyframes scan {
		0% {
			top: -2px;
		}
		100% {
			top: calc(100% + 2px);
		}
	}

	.modal-top-line,
	.modal-bottom-line {
		height: 1px;
		background: linear-gradient(90deg, transparent, var(--accent), transparent);
		opacity: 0.4;
		margin: 0.75rem 0;
	}

	.modal-tag {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		opacity: 0.7;
		margin-bottom: 0.5rem;
	}

	.modal-rank {
		font-family: var(--font-display);
		font-size: 3rem;
		font-weight: 900;
		color: var(--accent);
		text-shadow:
			0 0 30px var(--accent),
			0 0 60px var(--accent-glow-strong);
		letter-spacing: 0.2em;
		line-height: 1;
		animation: neon-flicker 4s ease-in-out infinite;
	}

	.modal-title {
		font-family: var(--font-display);
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		color: var(--text-1);
		margin-top: 0.5rem;
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	.modal-stats {
		margin: 1.25rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.modal-stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
	}

	.mstat-label {
		font-family: var(--font-mono);
		font-size: 0.58rem;
		letter-spacing: 0.25em;
		color: var(--text-2);
	}

	.mstat-value {
		font-family: var(--font-mono);
		font-size: 1.5rem;
		letter-spacing: 0.1em;
		color: var(--text-0);
	}

	.mstat-value.gold {
		color: var(--gold);
		text-shadow: 0 0 15px var(--gold-glow);
	}

	.new-record-badge {
		font-family: var(--font-display);
		font-size: 0.55rem;
		font-weight: 700;
		letter-spacing: 0.25em;
		color: var(--gold);
		border: 1px solid var(--gold-dim);
		padding: 0.15rem 0.625rem;
		text-shadow: 0 0 8px var(--gold);
		box-shadow: 0 0 15px var(--gold-glow);
	}

	.new-record-badge.unsaved {
		color: var(--hot, #ff4444);
		border-color: var(--hot-dim, rgba(255, 68, 68, 0.4));
		text-shadow: 0 0 8px var(--hot-glow, rgba(255, 68, 68, 0.5));
		box-shadow: 0 0 12px var(--hot-glow, rgba(255, 68, 68, 0.3));
	}

	.modal-actions {
		display: flex;
		justify-content: center;
		gap: 0.875rem;
		flex-wrap: wrap;
		padding-top: 0.5rem;
	}

	.modal-server-retry {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0 0.25rem;
	}

	.server-retry-label {
		color: var(--accent-warn, #ffb86b);
		font-size: 0.7rem;
		letter-spacing: 0.12em;
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

		.modal-scan-line {
			animation: none;
		}

		.modal-box {
			animation: none;
		}

		.modal-rank {
			animation: none;
		}

		.piece-slot.rejected {
			box-shadow: none;
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
