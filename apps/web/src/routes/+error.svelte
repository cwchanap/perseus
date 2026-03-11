<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

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

		void goto(resolve('/'));
	}

	onMount(() => {
		showGoBack = canSafelyGoBack();
	});
</script>

<svelte:head>
	<title>Error | Perseus</title>
</svelte:head>

<main class="error-main">
	<div class="error-box">
		<div class="error-code">
			{$page.status}
		</div>
		<div class="error-line"></div>
		<h1 class="error-title">
			{#if $page.status === 404}
				SECTOR NOT FOUND
			{:else}
				SYSTEM ERROR
			{/if}
		</h1>
		<p class="error-sub">
			{#if $page.status === 404}
				The mission you're looking for doesn't exist or has been removed.
			{:else if $page.error}
				{getSafeErrorMessage($page.error) ?? 'An unexpected error occurred. Please try again.'}
			{:else}
				An unexpected error occurred. Please try again.
			{/if}
		</p>
		<div class="error-actions">
			<a href={resolve('/')} class="arcade-btn">RETURN TO ARCADE</a>
			{#if showGoBack}
				<button onclick={() => handleGoBack()} class="arcade-btn-ghost">GO BACK</button>
			{/if}
		</div>
	</div>
</main>

<style>
	.error-main {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--bg-0);
		background-image:
			linear-gradient(rgba(0, 240, 255, 0.025) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0, 240, 255, 0.025) 1px, transparent 1px);
		background-size: 48px 48px;
		padding: 1.5rem;
	}

	.error-box {
		max-width: 26rem;
		width: 100%;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.error-code {
		font-family: var(--font-display);
		font-size: clamp(4rem, 15vw, 7rem);
		font-weight: 900;
		letter-spacing: 0.1em;
		color: var(--hot);
		text-shadow:
			0 0 30px var(--hot),
			0 0 60px var(--hot-glow);
		line-height: 1;
	}

	.error-line {
		width: 100%;
		height: 1px;
		background: linear-gradient(90deg, transparent, var(--hot), transparent);
		opacity: 0.4;
	}

	.error-title {
		font-family: var(--font-display);
		font-size: 1.1rem;
		font-weight: 700;
		letter-spacing: 0.15em;
		color: var(--text-0);
	}

	.error-sub {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-2);
		letter-spacing: 0.05em;
		line-height: 1.6;
	}

	.error-actions {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
		justify-content: center;
		margin-top: 0.5rem;
	}
</style>
