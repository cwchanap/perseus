<script lang="ts">
	import { resolve } from '$app/paths';
	import AdminPuzzlesPanel from './AdminPuzzlesPanel.svelte';
	import PlayerAccessPanel from './PlayerAccessPanel.svelte';

	type AdminTab = 'puzzles' | 'players';

	let activeTab: AdminTab = $state('puzzles');

	function handleTabKeydown(event: KeyboardEvent, currentTab: AdminTab) {
		let nextTab: AdminTab;
		switch (event.key) {
			case 'ArrowRight':
				nextTab = currentTab === 'puzzles' ? 'players' : 'puzzles';
				break;
			case 'ArrowLeft':
				nextTab = currentTab === 'puzzles' ? 'players' : 'puzzles';
				break;
			case 'Home':
				nextTab = 'puzzles';
				break;
			case 'End':
				nextTab = 'players';
				break;
			default:
				return;
		}

		event.preventDefault();
		activeTab = nextTab;
		document.getElementById(`admin-tab-${nextTab}`)?.focus();
	}
</script>

<svelte:head>
	<title>Admin Portal | Perseus</title>
</svelte:head>

<main
	class="min-h-screen bg-(--bg-0)
[background-image:linear-gradient(rgba(0,240,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.02)_1px,transparent_1px)]
[background-size:40px_40px]"
>
	<div class="mx-auto max-w-[80rem] px-6 pt-8 pb-16 sm:px-8">
		<header class="flex flex-wrap items-end justify-between gap-4 py-4">
			<div>
				<div
					class="mb-1 text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
				>
					// PERSEUS ADMIN
				</div>
				<h1
					class="text-[clamp(1.25rem,4vw,2rem)] font-(--font-display) font-black tracking-[0.1em] text-(--text-0)"
				>
					CONTROL PANEL
				</h1>
			</div>
			<div class="flex items-center gap-3">
				<a
					href={resolve('/upload')}
					class="text-[0.58rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--accent)
transition-colors duration-150 hover:text-(--text-0)"
				>
					UPLOAD
				</a>
				<a
					href={resolve('/')}
					class="text-[0.58rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)"
				>
					VIEW ARCADE
				</a>
			</div>
		</header>

		<div
			class="mb-8 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] opacity-30"
		></div>

		<div class="mb-6 flex border-b border-(--border)" role="tablist" aria-label="Admin sections">
			<button
				id="admin-tab-puzzles"
				type="button"
				role="tab"
				aria-selected={activeTab === 'puzzles'}
				aria-controls="admin-panel-puzzles"
				tabindex={activeTab === 'puzzles' ? 0 : -1}
				onclick={() => (activeTab = 'puzzles')}
				onkeydown={(event) => handleTabKeydown(event, 'puzzles')}
				class="border-b-2 border-transparent px-4 py-3 text-[0.6rem]
font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)
{activeTab === 'puzzles' ? 'border-(--accent) text-(--accent)' : ''}"
			>
				PUZZLES
			</button>
			<button
				id="admin-tab-players"
				type="button"
				role="tab"
				aria-selected={activeTab === 'players'}
				aria-controls="admin-panel-players"
				tabindex={activeTab === 'players' ? 0 : -1}
				onclick={() => (activeTab = 'players')}
				onkeydown={(event) => handleTabKeydown(event, 'players')}
				class="border-b-2 border-transparent px-4 py-3 text-[0.6rem]
font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)
{activeTab === 'players' ? 'border-(--accent) text-(--accent)' : ''}"
			>
				PLAYER ACCESS
			</button>
		</div>

		{#if activeTab === 'puzzles'}
			<div id="admin-panel-puzzles" role="tabpanel" aria-labelledby="admin-tab-puzzles">
				<AdminPuzzlesPanel />
			</div>
		{:else}
			<div id="admin-panel-players" role="tabpanel" aria-labelledby="admin-tab-players">
				<PlayerAccessPanel />
			</div>
		{/if}
	</div>
</main>
