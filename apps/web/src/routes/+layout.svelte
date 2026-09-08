<script lang="ts">
	import '@fontsource/orbitron/600.css';
	import '@fontsource/orbitron/700.css';
	import '@fontsource/orbitron/900.css';
	import '@fontsource/rajdhani/400.css';
	import '@fontsource/rajdhani/500.css';
	import '@fontsource/rajdhani/600.css';
	import '@fontsource/rajdhani/700.css';
	import '@fontsource/share-tech-mono/400.css';
	import './layout.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import favicon from '$lib/assets/favicon.svg';
	import ArcadeShell from '$lib/components/ArcadeShell.svelte';
	import { getPlayerProgression } from '$lib/services/api';
	import { playerAuth } from '$lib/stores/playerAuth';

	let { children } = $props();

	const isOnPuzzleRoute = $derived($page.url.pathname.startsWith('/puzzle/'));
	const shellVisible = $derived(!isOnPuzzleRoute && $page.url.pathname !== '/admin');
	const playerDisplayName = $derived($playerAuth.user?.name ?? $playerAuth.user?.email ?? '');
	let shellScore = $state<number | null>(null);
	let shellRank = $state<number | null>(null);

	onMount(() => {
		void playerAuth.refresh();
	});

	$effect(() => {
		const pathname = $page.url.pathname;
		const authenticated = $playerAuth.status === 'authenticated';
		const canShowShell = !pathname.startsWith('/puzzle/') && pathname !== '/admin';

		if (!authenticated || !canShowShell) {
			shellScore = null;
			shellRank = null;
			return;
		}

		const controller = new AbortController();
		void getPlayerProgression(controller.signal)
			.then((summary) => {
				if (controller.signal.aborted) return;
				shellScore = summary.score;
				shellRank = summary.rank;
			})
			.catch((error) => {
				if (controller.signal.aborted) return;
				console.error('Failed to load shell progression', error);
				shellScore = null;
				shellRank = null;
			});

		return () => controller.abort();
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

{#if shellVisible}
	<ArcadeShell
		currentPath={$page.url.pathname}
		authStatus={$playerAuth.status}
		{playerDisplayName}
		score={shellScore}
		rank={shellRank}
		onLogout={handlePlayerLogout}
		{children}
	/>
{:else}
	{@render children()}
{/if}
