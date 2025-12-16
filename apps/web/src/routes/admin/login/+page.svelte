<script lang="ts">
  import { goto } from '$app/navigation';
  import { login, ApiError } from '$lib/services/api';

  let passkey = $state('');
  let error: string | null = $state(null);
  let loading = $state(false);

  async function handleSubmit(event: Event) {
    event.preventDefault();
    error = null;
    loading = true;

    try {
      const result = await login(passkey);
      if (result.success) {
        goto('/admin');
      } else {
        error = result.error || 'Login failed';
      }
    } catch (e) {
      if (e instanceof ApiError) {
        error = e.message;
      } else {
        error = 'Failed to connect to server';
      }
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Admin Login | Perseus</title>
</svelte:head>

<main class="flex min-h-screen items-center justify-center bg-gray-50 px-4">
  <div class="w-full max-w-md">
    <div class="rounded-lg bg-white p-8 shadow-md">
      <div class="mb-6 text-center">
        <h1 class="text-2xl font-bold text-gray-900">Admin Login</h1>
        <p class="mt-2 text-gray-600">Enter your passkey to access the admin portal</p>
      </div>

      <form onsubmit={handleSubmit}>
        {#if error}
          <div class="mb-4 rounded-md bg-red-50 p-4 text-red-600">
            {error}
          </div>
        {/if}

        <div class="mb-6">
          <label for="passkey" class="mb-2 block text-sm font-medium text-gray-700">
            Passkey
          </label>
          <input
            id="passkey"
            type="password"
            bind:value={passkey}
            required
            class="w-full rounded-md border border-gray-300 px-4 py-3 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="Enter your passkey"
            disabled={loading}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !passkey}
          class="w-full rounded-md bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {#if loading}
            <span class="flex items-center justify-center gap-2">
              <span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></span>
              Logging in...
            </span>
          {:else}
            Login
          {/if}
        </button>
      </form>

      <div class="mt-6 text-center">
        <a href="/" class="text-sm text-gray-600 hover:text-gray-900">
          ← Back to Gallery
        </a>
      </div>
    </div>
  </div>
</main>
