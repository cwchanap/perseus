<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { logout, createPuzzle, deletePuzzle, fetchPuzzles, ApiError } from '$lib/services/api';
  import type { PuzzleSummary } from '$lib/types/puzzle';

  const ALLOWED_PIECE_COUNTS = [9, 16, 25, 36, 49, 64, 100];

  let loggingOut = $state(false);
  let logoutError: string | null = $state(null);
  let puzzles: PuzzleSummary[] = $state([]);
  let loadingPuzzles = $state(true);
  let puzzlesError: string | null = $state(null);

  // Form state
  let name = $state('');
  let pieceCount = $state(16);
  let imageFile: File | null = $state(null);
  let imagePreview: string | null = $state(null);
  let imageInput: HTMLInputElement | null = $state(null);
  let creating = $state(false);
  let formError: string | null = $state(null);
  let successMessage: string | null = $state(null);
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  // Delete state
  let deletingId: string | null = $state(null);

  onMount(async () => {
    await loadPuzzles();
  });

  onDestroy(() => {
    if (successTimeout !== null) {
      clearTimeout(successTimeout);
      successTimeout = null;
    }
  });

  async function loadPuzzles() {
    loadingPuzzles = true;
    puzzlesError = null;
    try {
      puzzles = await fetchPuzzles();
    } catch (e) {
      console.error('Failed to load puzzles', e);
      puzzlesError = e instanceof ApiError ? e.message : 'Failed to load puzzles';
      puzzles = [];
    } finally {
      loadingPuzzles = false;
    }
  }

  async function handleLogout() {
    loggingOut = true;
		logoutError = null;

		try {
			await logout();
			goto('/admin/login');
		} catch (e) {
			console.error('Failed to logout', e);
			logoutError = 'Failed to logout';
		} finally {
			loggingOut = false;
		}
  }

  function clearSelectedImage() {
    imageFile = null;
    imagePreview = null;
    if (imageInput) {
      imageInput.value = '';
    }
  }

  function handleImageSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (file) {
      imageFile = file;
      const reader = new FileReader();
      reader.onload = (e) => {
        imagePreview = e.target?.result as string;
      };
      reader.onerror = () => {
        console.error('Failed to read image for preview', reader.error);
        clearSelectedImage();
        formError = 'Failed to load image preview';
      };
      reader.onabort = () => {
        clearSelectedImage();
        formError = 'Image preview was aborted';
      };
      reader.readAsDataURL(file);
    }
  }

  function clearForm() {
    name = '';
    pieceCount = 16;
    clearSelectedImage();
    formError = null;
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    formError = null;
    successMessage = null;

    if (!name.trim()) {
      formError = 'Please enter a puzzle name';
      return;
    }

    if (!imageFile) {
      formError = 'Please select an image';
      return;
    }

    creating = true;

    try {
      await createPuzzle(name.trim(), pieceCount, imageFile);
      successMessage = 'Puzzle created successfully!';
      clearForm();
      await loadPuzzles();

      if (successTimeout !== null) clearTimeout(successTimeout);
      successTimeout = setTimeout(() => {
        successMessage = null;
        successTimeout = null;
      }, 3000);
    } catch (e) {
      if (e instanceof ApiError) {
        formError = e.message;
      } else {
        formError = 'Failed to create puzzle';
      }
    } finally {
      creating = false;
    }
  }

  async function handleDelete(puzzleId: string) {
    if (!confirm('Are you sure you want to delete this puzzle?')) return;

    deletingId = puzzleId;

    try {
      await deletePuzzle(puzzleId);
      await loadPuzzles();
    } catch (e) {
      alert('Failed to delete puzzle');
    } finally {
      deletingId = null;
    }
  }
</script>

<svelte:head>
  <title>Admin Portal | Perseus</title>
</svelte:head>

<main class="min-h-screen bg-gray-50">
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <!-- Header -->
    <header class="mb-8 flex items-center justify-between">
      <div>
        <h1 class="text-3xl font-bold text-gray-900">Admin Portal</h1>
        <p class="mt-2 text-gray-600">Manage your jigsaw puzzles</p>
      </div>
      <div class="flex items-center gap-4">
        <a href="/" class="text-gray-600 hover:text-gray-900">
          View Gallery
        </a>
        <button
          onclick={handleLogout}
          disabled={loggingOut}
          class="rounded-md bg-gray-200 px-4 py-2 text-gray-700 hover:bg-gray-300 disabled:opacity-50"
        >
          {loggingOut ? 'Logging out...' : 'Logout'}
        </button>
      </div>
    </header>

		{#if logoutError}
			<div class="mb-6 rounded-md bg-red-50 p-4 text-red-600">
				{logoutError}
			</div>
		{/if}

    <div class="grid gap-8 lg:grid-cols-2">
      <!-- Create Puzzle Form -->
      <div class="rounded-lg bg-white p-6 shadow-sm">
        <h2 class="mb-6 text-xl font-semibold text-gray-900">Create New Puzzle</h2>

        {#if successMessage}
          <div class="mb-4 rounded-md bg-green-50 p-4 text-green-600">
            {successMessage}
          </div>
        {/if}

        {#if formError}
          <div class="mb-4 rounded-md bg-red-50 p-4 text-red-600">
            {formError}
          </div>
        {/if}

        <form onsubmit={handleSubmit} class="space-y-6">
          <!-- Puzzle Name -->
          <div>
            <label for="name" class="mb-2 block text-sm font-medium text-gray-700">
              Puzzle Name
            </label>
            <input
              id="name"
              type="text"
              bind:value={name}
              class="w-full rounded-md border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              placeholder="Enter puzzle name"
              disabled={creating}
            />
          </div>

          <!-- Piece Count -->
          <div>
            <label for="pieceCount" class="mb-2 block text-sm font-medium text-gray-700">
              Number of Pieces
            </label>
            <select
              id="pieceCount"
              bind:value={pieceCount}
              class="w-full rounded-md border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              disabled={creating}
            >
              {#each ALLOWED_PIECE_COUNTS as count}
                <option value={count}>{count} pieces ({Math.sqrt(count)}×{Math.sqrt(count)} grid)</option>
              {/each}
            </select>
          </div>

          <!-- Image Upload -->
          <div>
            <span id="image-label" class="mb-2 block text-sm font-medium text-gray-700">
              Image
            </span>
            <div class="rounded-md border-2 border-dashed border-gray-300 p-4">
              {#if imagePreview}
                <div class="relative">
                  <img
                    src={imagePreview}
                    alt="Preview"
                    class="mx-auto max-h-48 rounded-md object-contain"
                  />
                  <button
                    type="button"
                    onclick={clearSelectedImage}
                    class="absolute right-0 top-0 rounded-full bg-red-500 p-1 text-white hover:bg-red-600"
                    aria-label="Remove image"
                  >
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              {:else}
                <label class="flex cursor-pointer flex-col items-center">
                  <svg class="h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span class="mt-2 text-sm text-gray-500">Click to upload image</span>
                  <span class="text-xs text-gray-400">JPEG, PNG, WebP (max 10MB)</span>
                  <input
                    bind:this={imageInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    class="hidden"
                    onchange={handleImageSelect}
                    disabled={creating}
                  />
                </label>
              {/if}
            </div>
          </div>

          <button
            type="submit"
            disabled={creating || !name || !imageFile}
            class="w-full rounded-md bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {#if creating}
              <span class="flex items-center justify-center gap-2">
                <span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></span>
                Creating puzzle...
              </span>
            {:else}
              Create Puzzle
            {/if}
          </button>
        </form>
      </div>

      <!-- Existing Puzzles -->
      <div class="rounded-lg bg-white p-6 shadow-sm">
        <h2 class="mb-6 text-xl font-semibold text-gray-900">Existing Puzzles</h2>

        {#if loadingPuzzles}
          <div class="flex items-center justify-center py-8">
            <div class="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"></div>
          </div>
        {:else if puzzlesError}
          <div class="py-8 text-center text-red-600">
            <p>{puzzlesError}</p>
          </div>
        {:else if puzzles.length === 0}
          <div class="py-8 text-center text-gray-500">
            <p>No puzzles yet. Create your first puzzle!</p>
          </div>
        {:else}
          <div class="space-y-3">
            {#each puzzles as puzzle (puzzle.id)}
              <div class="flex items-center justify-between rounded-md border border-gray-200 p-3">
                <div class="flex items-center gap-3">
                  <img
                    src={puzzle.thumbnailUrl}
                    alt={puzzle.name}
                    class="h-12 w-12 rounded object-cover"
                  />
                  <div>
                    <p class="font-medium text-gray-900">{puzzle.name}</p>
                    <p class="text-sm text-gray-500">{puzzle.pieceCount} pieces</p>
                  </div>
                </div>
                <button
                  onclick={() => handleDelete(puzzle.id)}
                  disabled={deletingId === puzzle.id}
                  class="rounded-md bg-red-100 px-3 py-1 text-sm text-red-600 hover:bg-red-200 disabled:opacity-50"
                >
                  {deletingId === puzzle.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
</main>
