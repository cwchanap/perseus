<script lang="ts">
  import type { PuzzlePiece } from '$lib/types/puzzle';
  import { getPieceImageUrl } from '$lib/services/api';

  interface Props {
    piece: PuzzlePiece;
    isPlaced: boolean;
    onDragStart?: (piece: PuzzlePiece) => void;
  }

  let { piece, isPlaced, onDragStart }: Props = $props();

  function handleDragStart(event: DragEvent) {
    if (isPlaced || !event.dataTransfer) return;

    event.dataTransfer.setData('text/plain', piece.id.toString());
    event.dataTransfer.effectAllowed = 'move';
    onDragStart?.(piece);
  }

  function handleTouchStart(event: TouchEvent) {
    if (isPlaced) return;
    onDragStart?.(piece);
  }
</script>

<div
  class="puzzle-piece relative cursor-grab select-none transition-transform hover:scale-105"
  class:opacity-50={isPlaced}
  class:cursor-not-allowed={isPlaced}
  draggable={!isPlaced}
  ondragstart={handleDragStart}
  ontouchstart={handleTouchStart}
  role="img"
  aria-label="Puzzle piece {piece.id}"
  data-testid="puzzle-piece"
  data-piece-id={piece.id}
>
  <img
    src={getPieceImageUrl(piece.puzzleId, piece.id)}
    alt="Piece {piece.id}"
    class="pointer-events-none h-full w-full object-contain"
    draggable="false"
  />
</div>

<style>
  .puzzle-piece:active {
    cursor: grabbing;
  }
</style>
