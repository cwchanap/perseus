<script lang="ts">
  import { page } from '$app/stores';
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
      {:else if $page.error?.message}
        {$page.error.message}
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
      <button
        onclick={() => history.back()}
        class="rounded-md bg-gray-200 px-6 py-3 font-medium text-gray-700 hover:bg-gray-300"
      >
        Go Back
      </button>
    </div>
  </div>
</main>
