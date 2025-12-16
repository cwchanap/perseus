<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPuzzles, ApiError } from '$lib/services/api';
  import type { PuzzleSummary } from '$lib/types/puzzle';
  import PuzzleCard from '$lib/components/PuzzleCard.svelte';

  let puzzles: PuzzleSummary[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  onMount(async () => {
    try {
      puzzles = await fetchPuzzles();
    } catch (e) {
      if (e instanceof ApiError) {
        error = e.message;
      } else {
        error = 'Failed to load puzzles. Please try again.';
      }
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>Jigsaw Puzzles | Perseus</title>
</svelte:head>

<main class="min-h-screen bg-gray-50">
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <header class="mb-8">
      <h1 class="text-3xl font-bold text-gray-900">Jigsaw Puzzles</h1>
      <p class="mt-2 text-gray-600">Select a puzzle to start solving</p>
    </header>

    {#if loading}
      <div class="flex items-center justify-center py-12" data-testid="loading-state">
        <div class="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"></div>
        <span class="ml-3 text-gray-600">Loading puzzles...</span>
      </div>
    {:else if error}
      <div class="rounded-lg bg-red-50 p-6 text-center" data-testid="error-state">
        <p class="text-red-600">{error}</p>
        <button
          onclick={() => window.location.reload()}
          class="mt-4 rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700"
        >
          Try Again
        </button>
      </div>
    {:else if puzzles.length === 0}
      <div class="rounded-lg bg-white p-12 text-center shadow-sm" data-testid="empty-state">
        <svg class="mx-auto h-16 w-16 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
        </svg>
        <h2 class="mt-4 text-xl font-semibold text-gray-900">No puzzles yet</h2>
        <p class="mt-2 text-gray-500">Get started by creating your first puzzle in the admin portal.</p>
        <a
          href="/admin"
          class="mt-6 inline-block rounded-md bg-blue-600 px-6 py-3 text-white hover:bg-blue-700"
        >
          Go to Admin Portal
        </a>
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4" data-testid="puzzle-grid">
        {#each puzzles as puzzle (puzzle.id)}
          <PuzzleCard {puzzle} />
        {/each}
      </div>
    {/if}
  </div>
</main>
