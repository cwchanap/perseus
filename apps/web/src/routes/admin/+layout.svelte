<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { checkSession } from '$lib/services/api';

  let { children } = $props();

  let checking = $state(true);
  let authenticated = $state(false);
  let redirecting = $state(false);
  let sessionCheckToken = 0;
  let sessionCheckInFlight = false;
  let sessionCheckQueued = false;

  const isLoginPage = $derived($page.url.pathname === '/admin/login');

  function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    goto('/admin/login');
  }

  async function runSessionCheck() {
    if (sessionCheckInFlight) {
      sessionCheckQueued = true;
      return;
    }

    sessionCheckInFlight = true;
    const token = ++sessionCheckToken;
    checking = true;

    try {
      const isAuth = await checkSession();
      if (token !== sessionCheckToken) return;
      authenticated = isAuth;
      if (!isAuth) {
        redirectToLogin();
      }
    } catch (error) {
      console.error('Failed to check session', error);
      if (token !== sessionCheckToken) return;
      authenticated = false;
      redirectToLogin();
    } finally {
      sessionCheckInFlight = false;
      if (token === sessionCheckToken) {
        checking = false;
      }

      if (sessionCheckQueued) {
        sessionCheckQueued = false;
        if (!redirecting && !isLoginPage) {
          void runSessionCheck();
        }
      }
    }
  }

  onMount(async () => {
    // Skip auth check on login page
    if (isLoginPage) {
      checking = false;
      return;
    }

    await runSessionCheck();
  });

  // Re-check when route changes (but not on login page)
  $effect(() => {
    if (isLoginPage || redirecting) return;
    sessionCheckQueued = true;
    if (!sessionCheckInFlight) {
      sessionCheckQueued = false;
      void runSessionCheck();
    }
  });

  $effect(() => {
    if (!isLoginPage && !checking && !authenticated) {
      redirectToLogin();
    }
  });
</script>

{#if isLoginPage}
  {@render children()}
{:else if checking}
  <div class="flex min-h-screen items-center justify-center bg-gray-50">
    <div class="flex items-center gap-3">
      <div class="h-6 w-6 animate-spin rounded-full border-3 border-blue-500 border-t-transparent"></div>
      <span class="text-gray-600">Checking authentication...</span>
    </div>
  </div>
{:else if authenticated}
  {@render children()}
{:else}
  <div class="flex min-h-screen items-center justify-center bg-gray-50">
    <div class="flex items-center gap-3">
      <div class="h-6 w-6 animate-spin rounded-full border-3 border-blue-500 border-t-transparent"></div>
      <span class="text-gray-600">Not authenticated. Redirecting...</span>
    </div>
  </div>
{/if}
