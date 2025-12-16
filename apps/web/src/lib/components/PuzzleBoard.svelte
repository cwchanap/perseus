<script lang="ts">
  import type { Puzzle, PuzzlePiece, PlacedPiece } from '$lib/types/puzzle';
  import { getPieceImageUrl } from '$lib/services/api';

  interface Props {
    puzzle: Puzzle;
    placedPieces: PlacedPiece[];
    onPiecePlaced: (pieceId: number, x: number, y: number) => void;
    onIncorrectPlacement: (pieceId: number) => void;
  }

  let { puzzle, placedPieces, onPiecePlaced, onIncorrectPlacement }: Props = $props();

  let dragOverCell: { x: number; y: number } | null = $state(null);

  function isPiecePlaced(x: number, y: number): PlacedPiece | undefined {
    return placedPieces.find((p) => p.x === x && p.y === y);
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

  function handleDrop(event: DragEvent, x: number, y: number) {
    event.preventDefault();
    dragOverCell = null;

    const pieceIdStr = event.dataTransfer?.getData('text/plain');
    if (!pieceIdStr) return;

    const pieceId = parseInt(pieceIdStr, 10);
    const piece = puzzle.pieces.find((p) => p.id === pieceId);
    if (!piece) return;

    // Check if cell is already occupied
    if (isPiecePlaced(x, y)) return;

    // Check if piece is placed in correct position
    if (piece.correctX === x && piece.correctY === y) {
      onPiecePlaced(pieceId, x, y);
    } else {
      onIncorrectPlacement(pieceId);
    }
  }

  function getCellStyle(x: number, y: number): string {
    const isOver = dragOverCell?.x === x && dragOverCell?.y === y;
    const hasPlaced = isPiecePlaced(x, y);

    if (hasPlaced) return 'bg-transparent';
    if (isOver) return 'bg-blue-100 border-blue-400';
    return 'bg-gray-100 border-gray-300';
  }
</script>

<div
  class="puzzle-board grid gap-0.5 rounded-lg bg-gray-200 p-1"
  style="grid-template-columns: repeat({puzzle.gridCols}, 1fr); aspect-ratio: {puzzle.imageWidth} / {puzzle.imageHeight};"
  data-testid="puzzle-board"
>
  {#each { length: puzzle.gridRows } as _, y}
    {#each { length: puzzle.gridCols } as _, x}
      {@const placedPiece = getPieceAtPosition(x, y)}
      <div
        class="drop-zone relative border-2 border-dashed transition-colors {getCellStyle(x, y)}"
        ondragover={(e) => handleDragOver(e, x, y)}
        ondragleave={handleDragLeave}
        ondrop={(e) => handleDrop(e, x, y)}
        data-testid="drop-zone"
        data-x={x}
        data-y={y}
        role="button"
        tabindex="0"
        aria-label="Drop zone at position {x}, {y}"
      >
        {#if placedPiece}
          <img
            src={getPieceImageUrl(puzzle.id, placedPiece.id)}
            alt="Placed piece"
            class="absolute inset-0 h-full w-full object-contain"
          />
        {/if}
      </div>
    {/each}
  {/each}
</div>
