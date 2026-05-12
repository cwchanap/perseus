<script lang="ts">
	import './layout.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	const isOnPuzzleRoute = $derived($page.url.pathname.startsWith('/puzzle/'));
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if !isOnPuzzleRoute}
	<a
		href={resolve('/quick')}
		class="fixed top-2 right-3 z-2000 text-[0.6rem] font-(--font-mono)
			tracking-[0.2em] text-(--accent) opacity-70 hover:opacity-100 max-sm:text-[0.55rem]"
		data-testid="quick-puzzle-link"
	>
		→ QUICK PUZZLE
	</a>
{/if}

{@render children()}
