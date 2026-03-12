<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchPuzzles, ApiError } from '$lib/services/api';
	import type { PuzzleSummary } from '$lib/types/puzzle';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import CategoryFilter from '$lib/components/CategoryFilter.svelte';
	import { CATEGORY_ALL } from '$lib/constants/categories';
	import type { PuzzleCategory } from '$lib/constants/categories';
	import { resolve } from '$app/paths';

	let puzzles: PuzzleSummary[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);
	let selectedCategory: PuzzleCategory | typeof CATEGORY_ALL = $state(CATEGORY_ALL);

	const filteredPuzzles = $derived(
		selectedCategory === CATEGORY_ALL
			? puzzles
			: puzzles.filter((p) => p.category === selectedCategory)
	);

	function handleCategorySelect(category: PuzzleCategory | typeof CATEGORY_ALL) {
		selectedCategory = category;
	}

	onMount(async () => {
		try {
			puzzles = await fetchPuzzles();
		} catch (e) {
			if (e instanceof ApiError) {
				error = e.message;
			} else {
				error = 'Failed to load puzzles. Please try again.';
			}
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head>
	<title>Puzzle Arcade | Perseus</title>
</svelte:head>

<main
	class="min-h-screen bg-(--bg-0)
[background-image:linear-gradient(rgba(0,240,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.025)_1px,transparent_1px)]
[background-size:48px_48px]"
>
	<div class="mx-auto max-w-[80rem] px-6 pt-8 pb-16 sm:px-8 sm:pt-10">
		<header class="mb-12">
			<div
				class="h-px bg-[linear-gradient(90deg,transparent_0%,var(--accent)_30%,var(--accent)_70%,transparent_100%)] opacity-40"
			></div>
			<div class="flex items-end justify-between gap-4 py-5 max-sm:flex-col max-sm:items-start">
				<div class="shrink-0">
					<div
						class="mb-1 text-[0.65rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
					>
						// PERSEUS SYSTEM v1.0
					</div>
					<h1
						class="text-[clamp(1.75rem,5vw,3.25rem)] leading-none font-(--font-display)
font-black tracking-[0.06em] text-(--text-0) uppercase"
					>
						PUZZLE
						<span
							class="ml-[0.3em] text-(--accent)
[text-shadow:0_0_20px_var(--accent),0_0_50px_var(--accent-glow-strong)]"
						>
							ARCADE
						</span>
					</h1>
				</div>
				<div
					class="flex flex-col items-end gap-[0.3rem] text-right max-sm:items-start max-sm:text-left"
				>
					<span
						class="text-[0.7rem] font-(--font-mono) tracking-[0.25em] text-(--text-2) uppercase"
					>
						SELECT YOUR MISSION
					</span>
					{#if puzzles.length > 0}
						<span
							class="text-[0.7rem] font-(--font-mono) tracking-[0.15em] text-(--accent) opacity-70"
						>
							{filteredPuzzles.length} AVAILABLE
						</span>
					{/if}
				</div>
			</div>
			<div
				class="h-px bg-[linear-gradient(90deg,transparent_0%,var(--accent)_30%,var(--accent)_70%,transparent_100%)] opacity-40"
			></div>

			{#if puzzles.length > 0}
				<div class="pt-5">
					<CategoryFilter selected={selectedCategory} onSelect={handleCategorySelect} />
				</div>
			{/if}
		</header>

		{#if loading}
			<div
				class="flex flex-col items-center justify-center gap-6 py-24"
				data-testid="loading-state"
				role="status"
				aria-live="polite"
			>
				<div
					class="h-11 w-11 rounded-full border-2 border-(--border) border-t-(--accent)
[box-shadow:0_0_20px_var(--accent-glow)]
motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none
motion-reduce:[box-shadow:none]"
				></div>
				<span
					class="text-[0.75rem] font-(--font-mono) tracking-[0.25em] text-(--accent)
motion-safe:animate-[neon-flicker_3s_ease-in-out_infinite]
motion-reduce:animate-none"
				>
					SCANNING MISSIONS...
				</span>
			</div>
		{:else if error}
			<div
				class="mx-auto flex max-w-[32rem] flex-col items-center gap-4 border border-(--hot)
bg-(--bg-1) px-8 py-12 text-center
[box-shadow:0_0_40px_var(--hot-glow),inset_0_0_40px_rgba(255,0,102,0.04)]"
				data-testid="error-state"
			>
				<div
					class="text-[1.75rem] font-(--font-display) font-black tracking-[0.15em] text-(--hot)
[text-shadow:0_0_25px_var(--hot)]"
				>
					SYS_ERR
				</div>
				<p class="text-[0.8rem] font-(--font-mono) tracking-[0.05em] text-(--text-1)">{error}</p>
				<button
					onclick={() => window.location.reload()}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
				>
					RETRY SCAN
				</button>
			</div>
		{:else if puzzles.length === 0}
			<div
				class="flex flex-col items-center gap-4 border border-(--border) bg-(--bg-1) px-8 py-16 text-center"
				data-testid="empty-state"
			>
				<div
					class="opacity-35 motion-safe:animate-[float_3s_ease-in-out_infinite]
motion-reduce:animate-none"
				>
					<svg
						class="h-16 w-16 text-(--text-1)"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						aria-hidden="true"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="1.5"
							d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
						/>
					</svg>
				</div>
				<h2
					class="text-[1rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-1)
uppercase"
				>
					NO MISSIONS AVAILABLE
				</h2>
				<p class="text-[0.9rem] tracking-[0.05em] text-(--text-2)">
					Initialize the system via the admin portal.
				</p>
				<a
					href={resolve('/admin')}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
				>
					ADMIN PORTAL
				</a>
			</div>
		{:else if filteredPuzzles.length === 0}
			<div
				class="flex flex-col items-center gap-4 border border-(--border) bg-(--bg-1) px-8 py-16 text-center"
			>
				<h2
					class="text-[1rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-1)
uppercase"
				>
					NO MISSIONS IN THIS SECTOR
				</h2>
				<p class="text-[0.9rem] tracking-[0.05em] text-(--text-2)">
					Select a different category filter to continue.
				</p>
				<button
					onclick={() => (selectedCategory = CATEGORY_ALL)}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
				>
					CLEAR FILTER
				</button>
			</div>
		{:else}
			<div
				class="grid grid-cols-1 gap-5 motion-safe:animate-[slide-up_0.4s_ease-out]
motion-reduce:animate-none sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
				data-testid="puzzle-grid"
			>
				{#each filteredPuzzles as puzzle (puzzle.id)}
					<PuzzleCard {puzzle} />
				{/each}
			</div>
		{/if}
	</div>
</main>
