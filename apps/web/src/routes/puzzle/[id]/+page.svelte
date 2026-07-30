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
	import PuzzleBoard from '$lib/components/PuzzleBoard.svelte';
	import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
	import PuzzleToolbar from '$lib/components/PuzzleToolbar.svelte';
	import ZoomableBoardFrame from '$lib/components/ZoomableBoardFrame.svelte';
	import GameTimer from '$lib/components/GameTimer.svelte';
	import ReferenceOverlay from '$lib/components/ReferenceOverlay.svelte';
	import { shuffleArray } from '$lib/utils/shuffle';
	import { resolve } from '$app/paths';
	import {
		getResponsivePuzzleBoardMetrics,
		type ResponsivePuzzleBoardMetrics
	} from '$lib/services/puzzleLayout';
	import { generateRandomRotations } from '$lib/services/gameplay/rotation';
	import { clampZoom, clampPan, calculateFitZoom } from '$lib/services/gameplay/viewport';
	import {
		createPuzzleSessionStore,
		type PuzzleSessionStore
	} from '$lib/services/gameplay/session/store';
	import {
		createBrowserRunIdFactory,
		createSessionStorageAdapter,
		serializeSession
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

	const runIdFactory = createBrowserRunIdFactory();
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

	let bestTime: number | null = $state(null);
	let isNewBest = $state(false);
	let activeLoadRequestId = 0;

	let sessionUnsubscribe: (() => void) | null = null;
	let checkpointInterval: ReturnType<typeof setInterval> | null = null;
	let rejectedPieceTimeout: ReturnType<typeof setTimeout> | null = null;
	let hintTimeout: ReturnType<typeof setTimeout> | null = null;
	let activePanPointerId: number | null = null;
	let panStartClientX = 0;
	let panStartClientY = 0;

	// Guard against Svelte 5 event delegation double-fire: when a component
	// re-renders mid-event (e.g. after selection changes a prop), Svelte can
	// invoke the same handler a second time with the updated prop. Without
	// this guard, select→cancel fires synchronously and the selection is
	// immediately undone. The flag is set on select and cleared on the next
	// cancel (the double-fire). Note: clearing this flag with a timer
	// (setTimeout/queueMicrotask/rAF) breaks the guard because the
	// double-fire fires after all those scheduling tiers in the test
	// environment, so the flag is intentionally only cleared in
	// handleCancelSelection.
	let suppressCancel = false;
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

	onDestroy(() => {
		if (sessionUnsubscribe) {
			sessionUnsubscribe();
			sessionUnsubscribe = null;
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

		// Flush the clock and persist a final snapshot before disposing so
		// the periodic 5s checkpoint interval does not leave a data-loss
		// window of several seconds (including recent hint/reference usage).
		persistSessionFinal();

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
		suppressCancel = true;
		sessionStore?.dispatch({ type: 'select_piece', pieceId: id });
	}

	function handleCancelSelection() {
		if (suppressCancel) {
			suppressCancel = false;
			return;
		}
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
		if (err instanceof ApiError) {
			switch (err.status) {
				case 400:
					return { code: 'bad_request', retryable: false };
				case 401:
					return { code: 'unauthorized', retryable: true };
				case 404:
					return { code: 'not_found', retryable: false };
				case 409:
					return { code: 'run_id_conflict', retryable: false };
				case 429:
					return { code: 'completion_quota_exceeded', retryable: false };
				default:
					return { code: 'internal_error', retryable: true };
			}
		}
		return { code: 'network_error', retryable: true };
	}

	function handleLocalStatsEffect(seal: SealedCompletion) {
		if (!puzzle) return;
		const result = recordLocalCompletion(puzzle.id, seal);

		if (result.status === 'failed') {
			isNewBest = result.isNewStandardBest;
		} else {
			isNewBest = result.isNewStandardBest;
			bestTime = result.stats.standardBestTime;
		}
		showCelebration = true;

		sessionStore?.dispatch({
			type: 'acknowledge_completion_effect',
			runId: seal.runId,
			effect: 'local_stats',
			result:
				result.status === 'failed'
					? { status: 'failed', code: 'storage_error', retryable: false }
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
		// completion_effect_request, which handleServerSubmissionEffect picks up.
		sessionStore?.dispatch({ type: 'retry_completion_effects' });
	}

	function handleSessionEvent(event: PuzzleSessionEvent) {
		if (event.type === 'completion_sealed') {
			showCelebration = true;
		} else if (event.type === 'completion_effect_request') {
			if (event.effect === 'local_stats') {
				handleLocalStatsEffect(event.seal);
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

			// Load/migrate/validate persisted session.
			const loadResult = sessionStorageAdapter.loadSession(loadedPuzzle.id, {
				puzzleId: loadedPuzzle.id,
				source: source.source,
				pieceIds: loadedPuzzle.pieces.map((p) => p.id),
				gridCols: loadedPuzzle.gridCols,
				gridRows: loadedPuzzle.gridRows,
				pieceCount: loadedPuzzle.pieceCount
			});

			const restored =
				loadResult.status === 'loaded' || loadResult.status === 'migrated'
					? loadResult.snapshot
					: undefined;

			puzzle = loadedPuzzle;
			showCelebration = false;
			showReferenceOverlay = false;
			clearHintTarget();
			if (rejectedPieceTimeout !== null) {
				clearTimeout(rejectedPieceTimeout);
				rejectedPieceTimeout = null;
			}
			rejectedPiece = null;
			bestTime = getBestTime(id);
			isNewBest = false;

			// Construct the session store.
			const store = createPuzzleSessionStore({
				metadata,
				runIdFactory,
				clock,
				onEvent: handleSessionEvent,
				restored,
				createTrayOrder: () => shuffleArray(loadedPuzzle.pieces.map((p) => p.id)),
				createRotations: (pieceIds: number[]) => {
					let hash = 0;
					const seedStr = `${loadedPuzzle.id}:${pieceIds.join(',')}`;
					for (const ch of seedStr) {
						hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
					}
					return generateRandomRotations(pieceIds, hash || 1);
				}
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

			// Auto-start fresh sessions immediately.
			if (!restored) {
				store.dispatch({ type: 'start' });
			}

			// Resume any pending completion effects that were interrupted by a
			// page close/navigate before the server submission or local stats
			// could be acknowledged. The engine re-emits completion_effect_request
			// for effects still in the pending state; succeeded/failed effects are
			// left untouched (idempotent).
			if (restored?.sealedCompletion) {
				store.dispatch({ type: 'resume_completion_effects' });
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
		}

		if (activePanPointerId !== event.pointerId) return;

		isPanning = false;
		activePanPointerId = null;
	}

	function handleWindowBlur() {
		showReferenceOverlay = false;
		referencePointerId = null;
		referenceHoldSource = null;
		sessionStore?.dispatch({ type: 'cancel_selection' });
		isPanning = false;
		activePanPointerId = null;
	}

	function handleVisibilityChange() {
		sessionStore?.setDocumentHidden(document.hidden);
	}

	function handleWindowKeyDown(event: KeyboardEvent) {
		if (showCelebration) return;

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

	function handlePlayAgain() {
		if (!puzzle || !sessionStore) return;

		showReferenceOverlay = false;
		showCelebration = false;
		clearHintTarget();
		rejectedPiece = null;
		referencePointerId = null;
		referenceHoldSource = null;
		isNewBest = false;
		sessionStorageAdapter.clearSession(puzzle.id);
		sessionStore.dispatch({ type: 'restart' });
		sessionStore.dispatch({ type: 'start' });
		pendingViewportReset = true;
	}

	function handleGoHome() {
		goto(resolve('/'));
	}

	function manageModalFocus(node: HTMLElement, isOpen: boolean) {
		let previousFocus: HTMLElement | null = null;
		let focusableElements: HTMLElement[] = [];
		let firstElement: HTMLElement | null = null;
		let lastElement: HTMLElement | null = null;
		let focusTimeout: ReturnType<typeof setTimeout> | null = null;
		let restoreFocusTimeout: ReturnType<typeof setTimeout> | null = null;

		const getFocusableElements = (element: HTMLElement) => {
			return Array.from(
				element.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				)
			).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
		};

		const trapFocus = (e: KeyboardEvent) => {
			if (e.key !== 'Tab') return;

			if (e.shiftKey) {
				if (document.activeElement === firstElement) {
					e.preventDefault();
					lastElement?.focus();
				}
			} else if (document.activeElement === lastElement) {
				e.preventDefault();
				firstElement?.focus();
			}
		};

		if (isOpen) {
			previousFocus = document.activeElement as HTMLElement;
			focusableElements = getFocusableElements(node);
			firstElement = focusableElements[0] || null;
			lastElement = focusableElements[focusableElements.length - 1] || null;
			focusTimeout = setTimeout(() => firstElement?.focus(), 100);
			document.addEventListener('keydown', trapFocus);
		}

		return {
			destroy() {
				if (focusTimeout !== null) {
					clearTimeout(focusTimeout);
					focusTimeout = null;
				}
				if (restoreFocusTimeout !== null) {
					clearTimeout(restoreFocusTimeout);
					restoreFocusTimeout = null;
				}

				document.removeEventListener('keydown', trapFocus);

				if (previousFocus) {
					restoreFocusTimeout = setTimeout(() => previousFocus?.focus(), 0);
				}
			}
		};
	}
</script>

<svelte:head>
	<title>{puzzle?.name || 'Mission'} | Perseus Arcade</title>
</svelte:head>

<div class="puzzle-page" inert={showCelebration} aria-hidden={showCelebration}>
	<!-- HUD Header -->
	<header class="hud-header">
		<div class="hud-left">
			<a
				href={resolve('/')}
				class="back-btn"
				aria-label="Return to arcade"
				data-testid="back-to-arcade-link"
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
				<GameTimer {timerState} {bestTime} />
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
			use:manageModalFocus={showCelebration}
		>
			<div class="modal-scan-line"></div>
			<div class="modal-top-line"></div>

			<div class="modal-tag">// MISSION COMPLETE</div>
			<div class="modal-rank">S RANK</div>

			<h2 id="modal-title" class="modal-title">{puzzle?.name?.toUpperCase()}</h2>

			<div class="modal-stats">
				<div class="modal-stat">
					<span class="mstat-label">FINAL TIME</span>
					<span class="mstat-value">{formatTime(timerState.elapsed)}</span>
				</div>
				{#if isNewBest}
					<div class="modal-stat new-best">
						<span class="mstat-label">PERSONAL BEST</span>
						<span class="mstat-value gold">{formatTime(bestTime ?? timerState.elapsed)}</span>
						<span class="new-record-badge">NEW RECORD</span>
					</div>
				{/if}
			</div>

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
				<button onclick={handleGoHome} class="arcade-btn-ghost">BACK TO ARCADE</button>
			</div>
		</div>
	</div>
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
