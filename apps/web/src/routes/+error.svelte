<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';

  let showGoBack = false;

  function getSafeErrorMessage(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;

    const anyError = error as Record<string, unknown>;
    const status = typeof anyError.status === 'number' ? anyError.status : null;
    const name = typeof anyError.name === 'string' ? anyError.name : null;

    if (name === 'TypeError') {
      return 'Network error. Please check your connection and try again.';
    }

    if (status === 401) return 'Your session has expired. Please log in again.';
    if (status === 403) return 'You do not have permission to view this page.';
    if (status === 413) return 'That file is too large. Please try a smaller one.';
    if (status && status >= 500) return 'The server encountered an error. Please try again later.';
    if (status && status >= 400) return 'Something went wrong. Please try again.';

    return null;
  }

  function canSafelyGoBack(): boolean {
    if (typeof window === 'undefined') return false;

    let referrerUrl: URL | null = null;
    try {
      if (document.referrer) {
        referrerUrl = new URL(document.referrer);
      }
    } catch {
      referrerUrl = null;
    }

    const isSameOrigin = referrerUrl?.origin === window.location.origin;
    const isDifferentPage =
      referrerUrl !== null &&
      (referrerUrl.pathname !== window.location.pathname ||
        referrerUrl.search !== window.location.search);

    return window.history.length > 1 && isSameOrigin && isDifferentPage;
  }

  function handleGoBack() {
    if (canSafelyGoBack()) {
      window.history.back();
      return;
    }

    void goto('/');
  }

  onMount(() => {
    showGoBack = canSafelyGoBack();
  });
</script>

<svelte:head>
  <title>Error | Perseus</title>
</svelte:head>

<main class="flex min-h-screen items-center justify-center bg-gray-50 px-4">
  <div class="max-w-md text-center">
    <div class="mb-6 text-6xl">
      {#if $page.status === 404}
        🔍
      {:else}
        ⚠️
      {/if}
    </div>

    <h1 class="mb-2 text-4xl font-bold text-gray-900">
      {#if $page.status === 404}
        Page Not Found
      {:else}
        Something Went Wrong
      {/if}
    </h1>

    <p class="mb-8 text-gray-600">
      {#if $page.status === 404}
        The page you're looking for doesn't exist or has been moved.
      {:else if $page.error}
        {getSafeErrorMessage($page.error) ?? 'An unexpected error occurred. Please try again.'}
      {:else}
        An unexpected error occurred. Please try again.
      {/if}
    </p>

    <div class="flex justify-center gap-4">
      <a
        href="/"
        class="rounded-md bg-blue-600 px-6 py-3 font-medium text-white hover:bg-blue-700"
      >
        Go to Gallery
      </a>
      {#if showGoBack}
        <button
          onclick={() => handleGoBack()}
          class="rounded-md bg-gray-200 px-6 py-3 font-medium text-gray-700 hover:bg-gray-300"
        >
          Go Back
        </button>
      {/if}
    </div>
  </div>
</main>
