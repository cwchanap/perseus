<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { fetchPuzzle, ApiError } from '$lib/services/api';
	import { getProgress, saveProgress, clearProgress } from '$lib/services/progress';
	import { getBestTime, saveCompletionTime } from '$lib/services/stats';
	import { createTimerStore, formatTime } from '$lib/stores/timer';
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
	import { selectedPieceId, clearSelectedPiece } from '$lib/stores/pieceSelection';
	import { createHistory } from '$lib/services/gameplay/history';
	import { getHintPieceId } from '$lib/services/gameplay/hints';
	import {
		rotateClockwise,
		generateRandomRotations,
		isUpright
	} from '$lib/services/gameplay/rotation';
	import { clampZoom, clampPan, calculateFitZoom } from '$lib/services/gameplay/viewport';

	const REJECTED_DURATION_MS = 500;
	const HINT_DURATION_MS = 1800;
	const ZOOM_STEP = 0.2;

	interface PlacementHistoryState {
		placedPieces: PlacedPiece[];
		pieceRotations: Record<number, Rotation>;
	}

	let puzzle: Puzzle | null = $state(null);
	let loading = $state(true);
	let error: string | null = $state(null);
	let errorStatus: number | null = $state(null);
	let placedPieces: PlacedPiece[] = $state([]);
	let showCelebration = $state(false);
	let rejectedPiece: number | null = $state(null);
	let shuffledPieceIds: number[] = $state([]);
	let rotationEnabled = $state(false);
	let pieceRotations = $state<Record<number, Rotation>>({});
	let showReferenceOverlay = $state(false);
	let activeHintPieceId = $state<number | null>(null);
	let activeHintTarget = $state<{ x: number; y: number } | null>(null);
	let canUndo = $state(false);
	let canRedo = $state(false);
	let currentSelectedPieceId = $state<number | null>(null);
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

	const timer = createTimerStore();
	let timerState: TimerState = $state({ elapsed: 0, running: false });
	let timerStarted = $state(false);
	let bestTime: number | null = $state(null);
	let isNewBest = $state(false);
	let completionRecorded = $state(false);

	let timerUnsubscribe: (() => void) | null = null;
	let selectionUnsubscribe: (() => void) | null = null;
	let rejectedPieceTimeout: ReturnType<typeof setTimeout> | null = null;
	let hintTimeout: ReturnType<typeof setTimeout> | null = null;
	let placementHistory = createHistory<PlacementHistoryState>({
		placedPieces: [],
		pieceRotations: {}
	});
	let activePanPointerId: number | null = null;
	let panStartClientX = 0;
	let panStartClientY = 0;
	let panOriginX = 0;
	let panOriginY = 0;

	timerUnsubscribe = timer.subscribe((state) => {
		timerState = state;
	});

	selectionUnsubscribe = selectedPieceId.subscribe((value) => {
		currentSelectedPieceId = value;
	});

	if (typeof window !== 'undefined') {
		window.addEventListener('pointermove', handleWindowPointerMove);
		window.addEventListener('pointerup', handleWindowPointerUp, true);
		window.addEventListener('pointercancel', handleWindowPointerUp, true);
		window.addEventListener('keydown', handleWindowKeyDown);
		window.addEventListener('blur', handleWindowBlur);
	}

	onDestroy(() => {
		if (timerUnsubscribe) {
			timerUnsubscribe();
			timerUnsubscribe = null;
		}

		if (selectionUnsubscribe) {
			selectionUnsubscribe();
			selectionUnsubscribe = null;
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
		}

		clearSelectedPiece();
		timer.destroy();
	});

	const puzzleId = $derived($page.params.id);
	const placedPieceIds = $derived.by(
		() => new Set(placedPieces.map((placement) => placement.pieceId))
	);
	const canPanBoard = $derived(zoom > minZoom + 0.001);

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
		shuffledPieceIds
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

	function clonePlacedPieces(pieces: PlacedPiece[]): PlacedPiece[] {
		return pieces.map((piece) => ({ ...piece }));
	}

	function clonePieceRotations(rotations: Record<number, Rotation>): Record<number, Rotation> {
		return { ...rotations };
	}

	function createPlacementHistoryState(
		nextPlacedPieces: PlacedPiece[] = placedPieces,
		nextPieceRotations: Record<number, Rotation> = pieceRotations
	): PlacementHistoryState {
		return {
			placedPieces: clonePlacedPieces(nextPlacedPieces),
			pieceRotations: clonePieceRotations(nextPieceRotations)
		};
	}

	function getRotationSeed(value: string): number {
		let hash = 0;
		for (const char of value) {
			hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
		}
		return hash || 1;
	}

	function getViewportBounds(scale = zoom): ViewportBounds {
		if (!puzzle || !boardViewportElement) {
			return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
		}

		const viewportWidth = boardViewportElement.clientWidth;
		const viewportHeight = boardViewportElement.clientHeight;
		const scaledWidth = puzzle.imageWidth * scale;
		const scaledHeight = puzzle.imageHeight * scale;
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
		if (puzzle.imageWidth <= 0 || puzzle.imageHeight <= 0) {
			console.error(
				`Puzzle ${puzzle.id} has invalid dimensions: ${puzzle.imageWidth}x${puzzle.imageHeight}`
			);
			return 1;
		}

		return calculateFitZoom(puzzle.imageWidth, puzzle.imageHeight, viewportWidth, viewportHeight);
	}

	function updateHistoryControls() {
		canUndo = placementHistory.canUndo();
		canRedo = placementHistory.canRedo();
	}

	function resetPlacementHistory(
		initialPlacedPieces: PlacedPiece[] = [],
		initialPieceRotations: Record<number, Rotation> = {}
	) {
		placementHistory = createHistory<PlacementHistoryState>(
			createPlacementHistoryState(initialPlacedPieces, initialPieceRotations)
		);
		updateHistoryControls();
	}

	function createInitialRotations(
		puzzleData: Puzzle,
		placements: PlacedPiece[],
		enabled: boolean,
		savedRotations: Record<number, Rotation> = {}
	): Record<number, Rotation> {
		if (!enabled) {
			return { ...savedRotations };
		}

		const rotations = Object.fromEntries(
			puzzleData.pieces.map((piece) => [piece.id, (savedRotations[piece.id] ?? 0) as Rotation])
		) as Record<number, Rotation>;

		const placedIds = new Set(placements.map((placement) => placement.pieceId));
		const missingIds = puzzleData.pieces
			.map((piece) => piece.id)
			.filter((pieceId) => !placedIds.has(pieceId) && savedRotations[pieceId] === undefined);

		if (missingIds.length === 0) {
			return rotations;
		}

		const generated = generateRandomRotations(
			missingIds,
			getRotationSeed(`${puzzleData.id}:${missingIds.join(',')}`)
		);

		return {
			...rotations,
			...generated
		};
	}

	function getDisplayedRotation(pieceId: number): Rotation {
		return rotationEnabled ? (pieceRotations[pieceId] ?? 0) : 0;
	}

	function persistProgress(
		nextPlacedPieces: PlacedPiece[] = placedPieces,
		nextRotationEnabled = rotationEnabled,
		nextPieceRotations: Record<number, Rotation> = pieceRotations
	) {
		if (!puzzle) return;

		saveProgress(puzzle.id, clonePlacedPieces(nextPlacedPieces), nextRotationEnabled, {
			...nextPieceRotations
		});
	}

	async function loadPuzzle(id: string) {
		loading = true;
		error = null;
		errorStatus = null;

		try {
			const loadedPuzzle = await fetchPuzzle(id);
			const savedProgress = getProgress(id);
			const restoredPlacedPieces = clonePlacedPieces(savedProgress?.placedPieces ?? []);
			const restoredRotationEnabled = savedProgress?.rotationEnabled ?? false;

			puzzle = loadedPuzzle;
			shuffledPieceIds = shuffleArray(loadedPuzzle.pieces.map((piece) => piece.id));
			placedPieces = restoredPlacedPieces;
			rotationEnabled = restoredRotationEnabled;
			pieceRotations = createInitialRotations(
				loadedPuzzle,
				restoredPlacedPieces,
				restoredRotationEnabled,
				savedProgress?.pieceRotations ?? {}
			);
			showCelebration = false;
			showReferenceOverlay = false;
			clearHintTarget();
			clearSelectedPiece();
			if (rejectedPieceTimeout !== null) {
				clearTimeout(rejectedPieceTimeout);
				rejectedPieceTimeout = null;
			}
			rejectedPiece = null;
			bestTime = getBestTime(id);
			timer.reset();
			timerStarted = false;
			isNewBest = false;
			completionRecorded = false;
			resetPlacementHistory(restoredPlacedPieces, pieceRotations);
			pendingViewportReset = true;
		} catch (e) {
			errorStatus = e instanceof ApiError ? e.status : null;
			if (e instanceof ApiError && e.status === 404) {
				clearProgress(id);
				error = 'Mission no longer available';
			} else {
				console.error(`Failed to load puzzle ${id}:`, e);
				error = 'Failed to load mission';
			}
		} finally {
			loading = false;
		}
	}

	function ensureTimerStarted() {
		if (!timerStarted) {
			timerStarted = true;
			timer.start();
		}
	}

	function syncCompletionState(previousCount: number, nextPlacedPieces: PlacedPiece[]) {
		if (!puzzle) return;

		const wasComplete = previousCount >= puzzle.pieceCount;
		const isComplete = nextPlacedPieces.length >= puzzle.pieceCount;

		if (isComplete && !wasComplete) {
			timer.pause();
			if (!completionRecorded) {
				isNewBest = saveCompletionTime(puzzle.id, timerState.elapsed);
				bestTime = getBestTime(puzzle.id);
				completionRecorded = true;
			}
			showCelebration = true;
			return;
		}

		if (!isComplete && wasComplete) {
			showCelebration = false;
			isNewBest = false;
			if (timerStarted) {
				timer.resume();
			}
		}
	}

	function handlePiecePlaced(pieceId: number, x: number, y: number) {
		ensureTimerStarted();
		if (activeHintPieceId === pieceId) {
			clearHintTarget();
		}

		const previousCount = placedPieces.length;
		const newPlacement: PlacedPiece = { pieceId, x, y };
		const nextPlacedPieces = [
			...placedPieces.filter((placement) => placement.pieceId !== pieceId),
			newPlacement
		];

		placedPieces = nextPlacedPieces;
		placementHistory.push(createPlacementHistoryState(nextPlacedPieces, pieceRotations));
		updateHistoryControls();
		persistProgress(nextPlacedPieces);
		syncCompletionState(previousCount, nextPlacedPieces);
	}

	function handleIncorrectPlacement(pieceId: number) {
		ensureTimerStarted();

		if (rejectedPieceTimeout !== null) {
			clearTimeout(rejectedPieceTimeout);
		}

		rejectedPiece = pieceId;
		rejectedPieceTimeout = setTimeout(() => {
			rejectedPiece = null;
			rejectedPieceTimeout = null;
		}, REJECTED_DURATION_MS);
	}

	function isPiecePlaced(pieceId: number): boolean {
		return placedPieceIds.has(pieceId);
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
		if (!puzzle) return;

		const hintPieceId = getHintPieceId(shuffledPieceIds, placedPieceIds, currentSelectedPieceId);
		if (hintPieceId === null) {
			clearHintTarget();
			return;
		}

		const hintedPiece = piecesMap.get(hintPieceId);
		if (!hintedPiece) return;

		showHintTarget(hintPieceId, { x: hintedPiece.correctX, y: hintedPiece.correctY });
	}

	function canPlacePiece(pieceId: number): boolean {
		return !rotationEnabled || isUpright(pieceRotations[pieceId] ?? 0);
	}

	function handleUndo() {
		const previousState = placementHistory.undo();
		if (previousState === undefined) return;

		const previousCount = placedPieces.length;
		placedPieces = clonePlacedPieces(previousState.placedPieces);
		pieceRotations = clonePieceRotations(previousState.pieceRotations);
		updateHistoryControls();
		persistProgress(placedPieces, rotationEnabled, pieceRotations);
		syncCompletionState(previousCount, placedPieces);
	}

	function handleRedo() {
		const nextState = placementHistory.redo();
		if (nextState === undefined) return;

		const previousCount = placedPieces.length;
		placedPieces = clonePlacedPieces(nextState.placedPieces);
		pieceRotations = clonePieceRotations(nextState.pieceRotations);
		updateHistoryControls();
		persistProgress(placedPieces, rotationEnabled, pieceRotations);
		syncCompletionState(previousCount, placedPieces);
	}

	function isRotationToggleLocked(): boolean {
		return placedPieces.length > 0;
	}

	function handleReferenceDown(event?: PointerEvent | KeyboardEvent) {
		const isPointerEvent = event instanceof PointerEvent;

		referenceHoldSource = isPointerEvent ? 'pointer' : 'keyboard';
		referencePointerId = isPointerEvent ? event.pointerId : null;
		showReferenceOverlay = true;
	}

	function handleReferenceUp(event?: PointerEvent | KeyboardEvent) {
		if (event instanceof PointerEvent) {
			return;
		}

		if (referenceHoldSource === 'pointer') {
			return;
		}

		showReferenceOverlay = false;
		referencePointerId = null;
		referenceHoldSource = null;
	}

	function handleRotationToggle() {
		if (!puzzle || isRotationToggleLocked()) return;

		const nextRotationEnabled = !rotationEnabled;
		const nextPieceRotations = nextRotationEnabled
			? createInitialRotations(puzzle, placedPieces, true, pieceRotations)
			: pieceRotations;

		rotationEnabled = nextRotationEnabled;
		pieceRotations = nextPieceRotations;
		persistProgress(placedPieces, nextRotationEnabled, nextPieceRotations);
	}

	function handlePieceRotate(pieceId: number) {
		if (!rotationEnabled || isPiecePlaced(pieceId)) return;

		ensureTimerStarted();

		const nextPieceRotations = {
			...pieceRotations,
			[pieceId]: rotateClockwise(pieceRotations[pieceId] ?? 0)
		} as Record<number, Rotation>;

		pieceRotations = nextPieceRotations;
		placementHistory.push(createPlacementHistoryState(placedPieces, nextPieceRotations));
		updateHistoryControls();

		persistProgress(placedPieces, rotationEnabled, nextPieceRotations);
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
		if (referenceHoldSource === 'pointer') {
			showReferenceOverlay = false;
			referencePointerId = null;
			referenceHoldSource = null;
		}

		isPanning = false;
		activePanPointerId = null;
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
		if (!puzzle) return;

		placedPieces = [];
		rotationEnabled = false;
		pieceRotations = {};
		showReferenceOverlay = false;
		showCelebration = false;
		clearHintTarget();
		rejectedPiece = null;
		referencePointerId = null;
		referenceHoldSource = null;
		clearProgress(puzzle.id);
		timer.reset();
		timerStarted = false;
		isNewBest = false;
		completionRecorded = false;
		clearSelectedPiece();
		shuffledPieceIds = shuffleArray(puzzle.pieces.map((piece) => piece.id));
		resetPlacementHistory([], {});
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
			<ReferenceOverlay puzzleId={currentPuzzle.id} active={showReferenceOverlay} />
			<div class="game-layout">
				<!-- Board panel -->
				<div class="board-panel">
					<div class="panel-header">
						<span class="panel-tag">PUZZLE BOARD</span>
					</div>
					<div class="board-toolbar">
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
							class="board-viewport"
							class:can-pan={canPanBoard}
							class:is-panning={isPanning}
							bind:this={boardViewportElement}
							data-testid="board-viewport"
						>
							<ZoomableBoardFrame scale={zoom} {panX} {panY} onWheel={handleBoardWheel}>
								<div class="board-canvas" style="width: {currentPuzzle.imageWidth}px;">
									<PuzzleBoard
										puzzle={currentPuzzle}
										{placedPieces}
										onPiecePlaced={handlePiecePlaced}
										onIncorrectPlacement={handleIncorrectPlacement}
										{activeHintTarget}
										{canPlacePiece}
										onBoardPointerDown={handleBoardPointerDown}
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
									class="piece-slot"
									class:rejected={rejectedPiece === piece.id}
									class:animate-shake={rejectedPiece === piece.id}
									class:hinted={activeHintPieceId === piece.id}
									data-testid={`piece-slot-${piece.id}`}
								>
									<PuzzlePiece
										{piece}
										isPlaced={false}
										{rotationEnabled}
										rotation={getDisplayedRotation(piece.id)}
										onRotate={handlePieceRotate}
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
		display: grid;
		grid-template-columns: 1fr;
		gap: 1.25rem;
		max-width: 80rem;
		margin: 0 auto;
	}

	@media (min-width: 1024px) {
		.game-layout {
			grid-template-columns: 1fr 280px;
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
		padding: 1rem;
		overflow: auto;
	}

	.board-toolbar {
		padding: 0.75rem 1rem 0;
	}

	.board-toolbar :global(.toolbar) {
		flex-wrap: wrap;
	}

	.board-viewport {
		min-height: 18rem;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.board-viewport.can-pan {
		cursor: grab;
		touch-action: none;
	}

	.board-viewport.is-panning {
		cursor: grabbing;
	}

	.board-canvas {
		margin: 0 auto;
	}

	.board-canvas :global(.puzzle-board) {
		width: 100%;
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
		grid-template-columns: repeat(3, 1fr);
		gap: 0.375rem;
		padding: 0.875rem;
		overflow-y: auto;
		flex: 1;
	}

	@media (min-width: 640px) and (max-width: 1023px) {
		.pieces-grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	.piece-slot {
		aspect-ratio: 1;
		border: 1px solid var(--border);
		padding: 0.2rem;
		transition: border-color 0.15s ease;
	}

	.piece-slot.rejected {
		border-color: var(--hot);
		box-shadow: 0 0 12px var(--hot-glow);
	}

	.piece-slot.hinted {
		border-color: var(--accent);
		box-shadow: 0 0 14px var(--accent-glow);
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
