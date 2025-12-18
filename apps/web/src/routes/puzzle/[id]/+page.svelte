<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { fetchPuzzle, ApiError } from '$lib/services/api';
  import { getProgress, saveProgress, clearProgress } from '$lib/services/progress';
  import type { Puzzle, PlacedPiece } from '$lib/types/puzzle';
  import PuzzleBoard from '$lib/components/PuzzleBoard.svelte';
  import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';

  let puzzle: Puzzle | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let placedPieces: PlacedPiece[] = $state([]);
  let showCelebration = $state(false);
  let rejectedPiece: number | null = $state(null);

  const puzzleId = $derived($page.params.id);

  $effect(() => {
    if (puzzleId) {
      loadPuzzle(puzzleId);
    }
  });

  async function loadPuzzle(id: string) {
    loading = true;
    error = null;

    try {
      puzzle = await fetchPuzzle(id);

      // Restore progress from localStorage
      const savedProgress = getProgress(id);
      if (savedProgress) {
        placedPieces = savedProgress.placedPieces;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Clear any saved progress for non-existent puzzle
        clearProgress(id);
        error = 'Puzzle no longer available';
      } else {
        error = 'Failed to load puzzle';
      }
    } finally {
      loading = false;
    }
  }

  function handlePiecePlaced(pieceId: number, x: number, y: number) {
    const newPlacement: PlacedPiece = { pieceId, x, y };
    placedPieces = [...placedPieces.filter((p) => p.pieceId !== pieceId), newPlacement];

    // Save progress
    if (puzzle) {
      saveProgress(puzzle.id, placedPieces);
    }

    // Check for completion
    if (puzzle && placedPieces.length === puzzle.pieceCount) {
      showCelebration = true;
    }
  }

  function handleIncorrectPlacement(pieceId: number) {
    rejectedPiece = pieceId;
    setTimeout(() => {
      rejectedPiece = null;
    }, 500);
  }

  function isPiecePlaced(pieceId: number): boolean {
    return placedPieces.some((p) => p.pieceId === pieceId);
  }

  function handlePlayAgain() {
    if (puzzle) {
      placedPieces = [];
      clearProgress(puzzle.id);
      showCelebration = false;
    }
  }

  function handleGoHome() {
    goto('/');
  }
</script>

<svelte:head>
  <title>{puzzle?.name || 'Puzzle'} | Perseus</title>
</svelte:head>

<main class="min-h-screen bg-gray-50">
  <div class="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
    <!-- Header -->
    <header class="mb-4 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <a
          href="/"
          class="flex items-center gap-2 text-gray-600 hover:text-gray-900"
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Gallery
        </a>
      </div>
      {#if puzzle}
        <div class="text-right">
          <h1 class="text-xl font-bold text-gray-900">{puzzle.name}</h1>
          <p class="text-sm text-gray-500">
            {placedPieces.length} / {puzzle.pieceCount} pieces placed
          </p>
        </div>
      {/if}
    </header>

    {#if loading}
      <div class="flex items-center justify-center py-12">
        <div class="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
        <span class="ml-3 text-gray-600">Loading puzzle...</span>
      </div>
    {:else if error}
      <div class="rounded-lg bg-red-50 p-12 text-center">
        <svg class="mx-auto h-16 w-16 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <h2 class="mt-4 text-xl font-semibold text-gray-900">{error}</h2>
        <p class="mt-2 text-gray-500">This puzzle may have been deleted.</p>
        <a
          href="/"
          class="mt-6 inline-block rounded-md bg-blue-600 px-6 py-3 text-white hover:bg-blue-700"
        >
          Back to Gallery
        </a>
      </div>
    {:else if puzzle}
      <div class="grid gap-6 lg:grid-cols-3">
        <!-- Puzzle Board -->
        <div class="lg:col-span-2">
          <div class="rounded-lg bg-white p-4 shadow-md">
            <PuzzleBoard
              {puzzle}
              {placedPieces}
              onPiecePlaced={handlePiecePlaced}
              onIncorrectPlacement={handleIncorrectPlacement}
            />
          </div>
        </div>

        <!-- Pieces Tray -->
        <div class="lg:col-span-1">
          <div class="rounded-lg bg-white p-4 shadow-md">
            <h2 class="mb-4 text-lg font-semibold text-gray-900">Puzzle Pieces</h2>
            <div class="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
              {#each puzzle.pieces as piece (piece.id)}
                {#if !isPiecePlaced(piece.id)}
                  <div
                    class="aspect-square rounded border-2 p-1 transition-all"
                    class:border-red-500={rejectedPiece === piece.id}
                    class:animate-shake={rejectedPiece === piece.id}
                    class:border-gray-200={rejectedPiece !== piece.id}
                  >
                    <PuzzlePiece
                      {piece}
                      isPlaced={false}
                    />
                  </div>
                {/if}
              {/each}
            </div>
            {#if placedPieces.length === puzzle.pieceCount}
              <p class="mt-4 text-center text-green-600 font-semibold">All pieces placed!</p>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Celebration Modal -->
  {#if showCelebration}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="celebration-modal">
      <div class="mx-4 max-w-md rounded-lg bg-white p-8 text-center shadow-xl">
        <div class="mb-4 text-6xl">🎉</div>
        <h2 class="text-2xl font-bold text-gray-900">Congratulations!</h2>
        <p class="mt-2 text-gray-600">You completed the puzzle!</p>
        <div class="mt-6 flex gap-4 justify-center">
          <button
            onclick={handlePlayAgain}
            class="rounded-md bg-blue-600 px-6 py-3 text-white hover:bg-blue-700"
          >
            Play Again
          </button>
          <button
            onclick={handleGoHome}
            class="rounded-md bg-gray-200 px-6 py-3 text-gray-700 hover:bg-gray-300"
          >
            Back to Gallery
          </button>
        </div>
      </div>
    </div>
  {/if}
</main>

<style>
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-5px); }
    75% { transform: translateX(5px); }
  }

  .animate-shake {
    animation: shake 0.3s ease-in-out;
  }
</style>
