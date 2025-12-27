<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Puzzle, PuzzlePiece, PlacedPiece } from '$lib/types/puzzle';
	import { getPieceImageUrl } from '$lib/services/api';
	import { selectedPieceId, clearSelectedPiece } from '$lib/stores/pieceSelection';

	interface Props {
		puzzle: Puzzle;
		placedPieces: PlacedPiece[];
		onPiecePlaced: (pieceId: number, x: number, y: number) => void;
		onIncorrectPlacement: (pieceId: number) => void;
	}

	let { puzzle, placedPieces, onPiecePlaced, onIncorrectPlacement }: Props = $props();

	let dragOverCell: { x: number; y: number } | null = $state(null);
	let currentSelectedId = $state<number | null>(null);

	const unsubscribeSelection = selectedPieceId.subscribe((value) => {
		currentSelectedId = value;
	});

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

		if (isPiecePlaced(x, y, pieceId)) return;

		if (piece.correctX === x && piece.correctY === y) {
			onPiecePlaced(pieceId, x, y);
		} else {
			onIncorrectPlacement(pieceId);
		}
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
		if (currentSelectedId === null) return;
		event.preventDefault();
		placePiece(currentSelectedId, x, y);
		clearSelectedPiece();
	}

	function getCellStyle(x: number, y: number): string {
		const isOver = dragOverCell?.x === x && dragOverCell?.y === y;
		const hasPlaced = isPiecePlaced(x, y);

		if (hasPlaced) return 'bg-transparent';
		if (isOver) return 'bg-blue-100 border-blue-400';
		return 'bg-gray-100 border-gray-300';
	}

	onDestroy(() => {
		unsubscribeSelection();
	});

	// Piece sizing constants (must match server TAB_RATIO = 0.2)
	const TAB_RATIO = 0.2;
	const expansionFactor = 1 + 2 * TAB_RATIO; // 1.4 (140%)
	const baseOffset = TAB_RATIO / expansionFactor; // ~14.29%
</script>

<div
	class="puzzle-board grid gap-0 rounded-lg bg-gray-200 p-1"
	style="grid-template-columns: repeat({puzzle.gridCols}, 1fr); aspect-ratio: {puzzle.imageWidth} / {puzzle.imageHeight};"
	data-testid="puzzle-board"
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
				{#if placedPiece}
					<!-- Pre-masked jigsaw piece from server (140% size, offset to align base with cell) -->
					<div
						class="placed-piece-shadow pointer-events-none absolute"
						style="
							z-index: {y * puzzle.gridCols + x + 1};
							width: {expansionFactor * 100}%;
							height: {expansionFactor * 100}%;
							left: -{baseOffset * 100}%;
							top: -{baseOffset * 100}%;
						"
					>
						<img
							src={getPieceImageUrl(puzzle.id, placedPiece.id)}
							alt="Placed piece"
							class="h-full w-full"
						/>
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
