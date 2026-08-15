<script lang="ts">
	import { untrack } from 'svelte';
	import PuzzleBoard from '$lib/components/PuzzleBoard.svelte';
	import PuzzleToolbar from '$lib/components/PuzzleToolbar.svelte';
	import ReferenceOverlay from '$lib/components/ReferenceOverlay.svelte';
	import ZoomableBoardFrame from '$lib/components/ZoomableBoardFrame.svelte';
	import { calculateFitZoom, clampPan, clampZoom } from '$lib/services/gameplay/viewport';
	import type { ViewportBounds } from '$lib/services/gameplay/viewport';
	import type { ResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';
	import type { PlacedPiece, Puzzle, PuzzlePiece } from '$lib/types/puzzle';

	const ZOOM_STEP = 0.2;

	type ReferenceHoldEvent = PointerEvent | KeyboardEvent;

	interface Props {
		puzzle: Puzzle;
		boardMetrics: ResponsivePuzzleBoardMetrics | null;
		placedPieces: PlacedPiece[];
		selectedPieceId: number | null;
		activeHintTarget: { x: number; y: number } | null;
		resolveImage: (piece: Pick<PuzzlePiece, 'id'>) => string;
		referenceImageUrl: string | null;
		referenceActive: boolean;
		canUndo: boolean;
		canRedo: boolean;
		canOpenSetup: boolean;
		canPause: boolean;
		rotationEnabled: boolean;
		rotationToggleDisabled: boolean;
		interactionBlocked: boolean;
		viewResetVersion: number;
		referenceToggled: boolean;
		onPiecePlaced: (pieceId: number, x: number, y: number) => void;
		onUndo: () => void;
		onRedo: () => void;
		onHint: () => void;
		onReferenceDown: (event?: ReferenceHoldEvent) => void;
		onReferenceUp: (event?: ReferenceHoldEvent) => void;
		onReferenceToggle: () => void;
		onRotationToggle: () => void;
		onPause: () => void;
		onOpenSetup: () => void;
	}

	let {
		puzzle,
		boardMetrics,
		placedPieces,
		selectedPieceId,
		activeHintTarget,
		resolveImage,
		referenceImageUrl,
		referenceActive,
		canUndo,
		canRedo,
		canOpenSetup,
		canPause,
		rotationEnabled,
		rotationToggleDisabled,
		interactionBlocked,
		viewResetVersion,
		referenceToggled,
		onPiecePlaced,
		onUndo,
		onRedo,
		onHint,
		onReferenceDown,
		onReferenceUp,
		onReferenceToggle,
		onRotationToggle,
		onPause,
		onOpenSetup
	}: Props = $props();

	let boardViewportElement = $state<HTMLElement | null>(null);
	let zoom = $state(1);
	let minZoom = $state(1);
	let maxZoom = $state(3);
	let panX = $state(0);
	let panY = $state(0);
	let isPanning = $state(false);
	let activePanPointerId = $state<number | null>(null);
	let panStartClientX = $state(0);
	let panStartClientY = $state(0);
	let panOriginX = $state(0);
	let panOriginY = $state(0);

	const canPanBoard = $derived(selectedPieceId === null && zoom > minZoom + 0.001);
	const puzzleId = $derived(puzzle.id);
	const viewResetSignal = $derived(viewResetVersion);
	// A declared reference with no image URL cannot be shown: REF and Peek
	// render (hasReference gates that) but stay disabled.
	const referenceAvailable = $derived(puzzle.hasReference === true && referenceImageUrl !== null);

	$effect(() => {
		void puzzleId;
		void viewResetSignal;
		const viewport = boardViewportElement;
		if (!viewport) return;
		untrack(() => resetViewport());
	});

	$effect(() => {
		void boardMetrics;
		const viewport = boardViewportElement;
		if (!viewport) return;
		untrack(() => recomputeZoomBounds());
	});

	$effect(() => {
		const viewport = boardViewportElement;
		if (!viewport) return;
		const observer = new ResizeObserver(() => recomputeZoomBounds());
		observer.observe(viewport);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (interactionBlocked || selectedPieceId !== null) cancelPan();
	});

	function getViewportBounds(scale = zoom): ViewportBounds {
		if (!boardViewportElement) {
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
		if (!boardViewportElement) return 1;

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

	function applyZoomBounds() {
		const fitZoom = getFitZoom();
		minZoom = fitZoom;
		maxZoom = Math.max(fitZoom * 3, fitZoom + 1, 3);
	}

	function recomputeZoomBounds() {
		if (!boardViewportElement) return;
		applyZoomBounds();
		if (zoom < minZoom) {
			zoom = minZoom;
			panX = 0;
			panY = 0;
		} else {
			const clampedPan = clampPan(panX, panY, getViewportBounds(zoom));
			panX = clampedPan.x;
			panY = clampedPan.y;
		}
	}

	function setView(nextZoom: number, nextPanX = panX, nextPanY = panY) {
		const clampedScale = clampZoom(nextZoom, minZoom, maxZoom);
		const clampedPan = clampPan(nextPanX, nextPanY, getViewportBounds(clampedScale));
		zoom = clampedScale;
		panX = clampedPan.x;
		panY = clampedPan.y;
	}

	function resetViewport() {
		applyZoomBounds();
		zoom = minZoom;
		panX = 0;
		panY = 0;
		cancelPan();
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
		if (interactionBlocked || !canPanBoard) return;
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
		if (interactionBlocked || !isPanning || activePanPointerId !== event.pointerId) return;

		const deltaX = event.clientX - panStartClientX;
		const deltaY = event.clientY - panStartClientY;
		const clampedPan = clampPan(panOriginX + deltaX, panOriginY + deltaY, getViewportBounds());
		panX = clampedPan.x;
		panY = clampedPan.y;
	}

	function handleWindowPointerUp(event: PointerEvent) {
		if (activePanPointerId !== event.pointerId) return;
		cancelPan();
	}

	function cancelPan() {
		isPanning = false;
		activePanPointerId = null;
	}
</script>

<svelte:window
	onpointermove={handleWindowPointerMove}
	onpointerupcapture={handleWindowPointerUp}
	onpointercancelcapture={handleWindowPointerUp}
	onblur={cancelPan}
/>

<ReferenceOverlay imageUrl={referenceImageUrl} active={referenceActive} />

<div class="board-panel">
	<div class="panel-header">
		<span class="panel-tag">PUZZLE BOARD</span>
	</div>
	<div class="board-toolbar px-4 pt-3">
		<PuzzleToolbar
			{onUndo}
			{onRedo}
			{onHint}
			{onReferenceDown}
			{onReferenceUp}
			{onReferenceToggle}
			onZoomIn={handleZoomIn}
			onZoomOut={handleZoomOut}
			onResetView={resetViewport}
			{onRotationToggle}
			{onPause}
			{onOpenSetup}
			{canOpenSetup}
			{canPause}
			{canUndo}
			{canRedo}
			{rotationEnabled}
			{rotationToggleDisabled}
			{referenceToggled}
			{referenceAvailable}
			hasReference={puzzle.hasReference === true}
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
					style={boardMetrics
						? `--board-width: ${boardMetrics.boardWidth}px; --board-height: ${boardMetrics.boardHeight}px; --board-cell-size: ${boardMetrics.cellSize}px; width: var(--board-width); height: var(--board-height);`
						: `width: ${puzzle.imageWidth}px;`}
				>
					<PuzzleBoard
						{puzzle}
						{placedPieces}
						{onPiecePlaced}
						{activeHintTarget}
						{resolveImage}
						{selectedPieceId}
						onBoardPointerDown={handleBoardPointerDown}
					/>
				</div>
			</ZoomableBoardFrame>
		</div>
	</div>
</div>

<style>
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

	/* Mobile: the page is pinned to the viewport and .game-layout fills main,
	   so the board's 1fr grid row gets a definite height. Turn the panel into a
	   shrinking flex column so .board-wrap absorbs the height variance and
	   scrolls instead of pushing the inventory drawer past the fold. Desktop is
	   content-sized (no definite row height), so this stays inert there. */
	@media (max-width: 1023px) {
		.board-panel {
			display: flex;
			flex-direction: column;
			min-height: 0;
		}

		.panel-header,
		.board-toolbar {
			flex-shrink: 0;
		}

		.board-wrap {
			flex: 1 1 0;
			min-height: 0;
		}
	}
</style>
