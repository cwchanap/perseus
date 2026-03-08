<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { checkSession } from '$lib/services/api';
	import { resolve } from '$app/paths';

	let { children } = $props();

	let checking = $state(true);
	let authenticated = $state(false);
	let redirecting = $state(false);
	let currentPath = $state('');
	let sessionCheckToken = 0;
	let sessionCheckInFlight = false;
	let sessionCheckQueued = false;

	const isLoginPage = $derived($page.url.pathname === '/admin/login');

	function redirectToLogin() {
		if (redirecting) return;
		redirecting = true;
		goto(resolve('/admin/login'));
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
		currentPath = $page.url.pathname;

		// Skip auth check on login page
		if (isLoginPage) {
			checking = false;
			return;
		}

		await runSessionCheck();
	});

	// Re-check when route path changes (but not on login page)
	$effect(() => {
		const pathname = $page.url.pathname;
		if (isLoginPage || redirecting) return;
		if (pathname === currentPath) {
			return;
		}

		currentPath = pathname;

		if (sessionCheckInFlight) {
			sessionCheckQueued = true;
			return;
		}

		void runSessionCheck();
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
	<div class="auth-state">
		<div class="auth-spinner"></div>
		<span class="auth-label">VERIFYING ACCESS...</span>
	</div>
{:else if authenticated}
	{@render children()}
{:else}
	<div class="auth-state">
		<div class="auth-spinner"></div>
		<span class="auth-label">REDIRECTING...</span>
	</div>
{/if}

<style>
	.auth-state {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background-color: var(--bg-0);
		gap: 1.25rem;
	}

	.auth-spinner {
		width: 2.5rem;
		height: 2.5rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
		box-shadow: 0 0 20px var(--accent-glow);
	}

	.auth-label {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		letter-spacing: 0.25em;
		color: var(--accent);
		animation: neon-flicker 3s ease-in-out infinite;
	}
</style>
