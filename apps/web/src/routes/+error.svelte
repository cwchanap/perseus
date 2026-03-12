<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
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

<main
	class="flex min-h-screen items-center justify-center bg-(--bg-0) [background-image:linear-gradient(rgba(0,240,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.025)_1px,transparent_1px)]
[background-size:48px_48px]
px-6"
>
	<div class="flex w-full max-w-[26rem] flex-col items-center gap-4 text-center">
		<div
			class="text-[clamp(4rem,15vw,7rem)] leading-none font-(--font-display) font-black
tracking-[0.1em] text-(--hot)
[text-shadow:0_0_30px_var(--hot),0_0_60px_var(--hot-glow)]"
		>
			{$page.status}
		</div>
		<div
			class="h-px w-full bg-[linear-gradient(90deg,transparent,var(--hot),transparent)] opacity-40"
		></div>
		<h1 class="text-[1.1rem] font-(--font-display) font-bold tracking-[0.15em] text-(--text-0)">
			{#if $page.status === 404}
				SECTOR NOT FOUND
			{:else}
				SYSTEM ERROR
			{/if}
		</h1>
		<p class="text-[0.75rem] leading-[1.6] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
			{#if $page.status === 404}
				The mission you're looking for doesn't exist or has been removed.
			{:else if $page.error}
				{getSafeErrorMessage($page.error) ?? 'An unexpected error occurred. Please try again.'}
			{:else}
				An unexpected error occurred. Please try again.
			{/if}
		</p>
		<div class="mt-2 flex flex-wrap justify-center gap-3">
			<a
				href={resolve('/')}
				class="border border-(--accent) px-7 py-2.5 text-[0.62rem] font-(--font-display)
font-bold tracking-[0.2em] text-(--accent) uppercase transition-all duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)]"
			>
				RETURN TO ARCADE
			</a>
			{#if showGoBack}
				<button
					onclick={() => handleGoBack()}
					class="border border-(--border) px-7 py-2.5 text-[0.62rem]
font-(--font-display) font-bold tracking-[0.2em] text-(--text-1) uppercase
transition-all duration-200 hover:border-(--border-bright)
hover:text-(--text-0)"
				>
					GO BACK
				</button>
			{/if}
		</div>
	</div>
</main>
