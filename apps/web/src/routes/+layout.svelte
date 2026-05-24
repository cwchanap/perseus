<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import favicon from '$lib/assets/favicon.svg';
	import { playerAuth } from '$lib/stores/playerAuth';

	let { children } = $props();

	const isOnPuzzleRoute = $derived($page.url.pathname.startsWith('/puzzle/'));
	const playerDisplayName = $derived($playerAuth.user?.name ?? $playerAuth.user?.email ?? '');

	onMount(() => {
		void playerAuth.refresh();
	});

	function handlePlayerLogout() {
		void playerAuth.logout().catch((error) => {
			console.error('Failed to sign out player', error);
		});
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if !isOnPuzzleRoute}
	<nav
		aria-label="Player navigation"
		class="fixed top-2 right-3 z-2000 flex max-w-[calc(100vw-1.5rem)] items-center gap-3
			overflow-hidden text-[0.58rem] font-(--font-mono) tracking-[0.16em]
			max-sm:gap-2 max-sm:text-[0.52rem]"
	>
		<a
			href={resolve('/quick')}
			class="shrink-0 text-(--accent) opacity-70 transition-opacity duration-150 hover:opacity-100"
			data-testid="quick-puzzle-link"
		>
			→ QUICK PUZZLE
		</a>

		{#if $playerAuth.status === 'loading'}
			<!-- auth status pending -->
		{:else if $playerAuth.status === 'authenticated' && $playerAuth.user}
			<span class="min-w-0 truncate text-(--text-2)" title={playerDisplayName}>
				{playerDisplayName}
			</span>
			<button
				type="button"
				class="shrink-0 text-(--hot) opacity-70 transition-opacity duration-150 hover:opacity-100"
				onclick={handlePlayerLogout}
			>
				SIGN OUT
			</button>
		{:else}
			<a
				href={resolve('/login')}
				class="shrink-0 text-(--text-2) opacity-70 transition-colors duration-150
					hover:text-(--accent) hover:opacity-100"
			>
				SIGN IN
			</a>
		{/if}
	</nav>
{/if}

{@render children()}
