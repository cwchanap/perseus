<script lang="ts">
	import './layout.css';
	import { resolve } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<a
	href={resolve('/quick')}
	class="fixed top-2 right-3 z-[2000] text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-70 hover:opacity-100 max-sm:text-[0.55rem]"
	data-testid="quick-puzzle-link"
>
	→ QUICK PUZZLE
</a>

{@render children()}
