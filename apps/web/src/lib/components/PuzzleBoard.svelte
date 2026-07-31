<script lang="ts">
	import type { Puzzle, PuzzlePiece, PlacedPiece } from '$lib/types/puzzle';
	import { EXPANSION_FACTOR, TAB_RATIO } from '$lib/constants/puzzle';

	interface Props {
		puzzle: Puzzle;
		placedPieces: PlacedPiece[];
		onPiecePlaced: (pieceId: number, x: number, y: number) => void;
		activeHintTarget?: { x: number; y: number } | null;
		onBoardPointerDown?: (event: PointerEvent) => void;
		resolveImage: (piece: PuzzlePiece) => string;
		selectedPieceId?: number | null;
	}

	let {
		puzzle,
		placedPieces,
		onPiecePlaced,
		activeHintTarget = null,
		onBoardPointerDown,
		resolveImage,
		selectedPieceId = null
	}: Props = $props();

	let dragOverCell: { x: number; y: number } | null = $state(null);

	function isPiecePlaced(x: number, y: number, excludePieceId?: number): PlacedPiece | undefined {
		return placedPieces.find((p) => p.x === x && p.y === y && p.pieceId !== excludePieceId);
	}

	function getPieceAtPosition(x: number, y: number): PuzzlePiece | undefined {
		const placed = isPiecePlaced(x, y);
		if (!placed) return undefined;
		return puzzle.pieces.find((p) => p.id === placed.pieceId);
	}

	function handleDragOver(event: DragEvent, x: number, y: number) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		dragOverCell = { x, y };
	}

	function handleDragLeave() {
		dragOverCell = null;
	}

	function placePiece(pieceId: number, x: number, y: number): void {
		const piece = puzzle.pieces.find((p) => p.id === pieceId);
		if (!piece) return;

		// Route every valid piece/coordinate to the session via onPiecePlaced.
		// The session engine determines accept vs. reject and emits
		// placement_rejected for rejected attempts; the route drives the shake
		// animation from that event. Filtering here would bypass the session's
		// canonical counter/timer/rejection logic.
		onPiecePlaced(pieceId, x, y);
	}

	function handleDrop(event: DragEvent, x: number, y: number) {
		event.preventDefault();
		dragOverCell = null;

		if (!event.dataTransfer) return;

		const pieceIdStr = event.dataTransfer.getData('text/plain');
		if (!pieceIdStr) return;

		const pieceId = parseInt(pieceIdStr, 10);
		if (Number.isNaN(pieceId)) return;

		placePiece(pieceId, x, y);
	}

	function handleKeyDown(event: KeyboardEvent, x: number, y: number) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		if (selectedPieceId === null) return;
		event.preventDefault();
		// The session engine clears selectedPieceId on accepted placements;
		// on rejected placements the selection is retained so the user can
		// try another cell. placePiece routes the attempt to the session.
		placePiece(selectedPieceId, x, y);
	}

	function getCellStyle(x: number, y: number): string {
		const isOver = dragOverCell?.x === x && dragOverCell?.y === y;
		const hasPlaced = isPiecePlaced(x, y);

		if (hasPlaced) return 'bg-transparent';
		if (isOver) return 'bg-blue-100 border-blue-400';
		return 'bg-gray-100 border-gray-300';
	}

	function isHintTarget(x: number, y: number): boolean {
		return activeHintTarget?.x === x && activeHintTarget?.y === y;
	}

	function handleBoardPointerDown(event: PointerEvent) {
		onBoardPointerDown?.(event);
	}
</script>

<div
	class="puzzle-board grid gap-0 rounded-lg bg-gray-200 p-1"
	style="
		grid-template-columns: repeat({puzzle.gridCols}, 1fr);
		grid-template-rows: repeat({puzzle.gridRows}, 1fr);
		aspect-ratio: {puzzle.imageWidth} / {puzzle.imageHeight};
	"
	data-testid="puzzle-board"
	onpointerdown={handleBoardPointerDown}
>
	{#each Array(puzzle.gridRows) as _, y (y)}
		{#each Array(puzzle.gridCols) as _, x (x)}
			{@const placedPiece = getPieceAtPosition(x, y)}
			<div
				class="drop-zone relative overflow-visible border border-dashed transition-colors {getCellStyle(
					x,
					y
				)}"
				ondragover={(e) => handleDragOver(e, x, y)}
				ondragleave={handleDragLeave}
				ondrop={(e) => handleDrop(e, x, y)}
				onkeydown={(e) => handleKeyDown(e, x, y)}
				data-testid="drop-zone"
				data-x={x}
				data-y={y}
				role="button"
				tabindex="0"
				aria-label="Drop zone at position {x}, {y}"
			>
				{#if isHintTarget(x, y)}
					<div
						class="pointer-events-none absolute inset-1 rounded-md border-2 border-amber-400 bg-amber-200/40"
						data-testid="hint-target"
						data-x={x}
						data-y={y}
						aria-hidden="true"
					></div>
				{/if}

				{#if placedPiece}
					<!-- Pre-masked jigsaw piece from server (140% size, offset to align base with cell) -->
					<div
						class="placed-piece-shadow pointer-events-none absolute"
						style="
							z-index: {y * puzzle.gridCols + x + 1};
							width: {EXPANSION_FACTOR * 100}%;
							height: {EXPANSION_FACTOR * 100}%;
							left: -{TAB_RATIO * 100}%;
							top: -{TAB_RATIO * 100}%;
						"
					>
						<img src={resolveImage(placedPiece)} alt="Placed piece" class="h-full w-full" />
					</div>
				{/if}
			</div>
		{/each}
	{/each}
</div>

<style>
	/* Subtle shadow for placed pieces */
	.placed-piece-shadow {
		filter: drop-shadow(1px 2px 3px rgba(0, 0, 0, 0.15));
	}
</style>
