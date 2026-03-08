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

<main class="game-main">
	<div class="content-wrap">
		<header class="game-header">
			<div class="header-line"></div>
			<div class="header-inner">
				<div class="title-block">
					<div class="system-tag">// PERSEUS SYSTEM v1.0</div>
					<h1 class="game-title">PUZZLE<span class="title-glow">ARCADE</span></h1>
				</div>
				<div class="header-right">
					<span class="directive-label">SELECT YOUR MISSION</span>
					{#if puzzles.length > 0}
						<span class="count-display">{filteredPuzzles.length} AVAILABLE</span>
					{/if}
				</div>
			</div>
			<div class="header-line"></div>

			{#if puzzles.length > 0}
				<div class="filter-row">
					<CategoryFilter selected={selectedCategory} onSelect={handleCategorySelect} />
				</div>
			{/if}
		</header>

		{#if loading}
			<div class="state-panel" data-testid="loading-state">
				<div class="loading-ring"></div>
				<span class="state-label">SCANNING MISSIONS...</span>
			</div>
		{:else if error}
			<div class="error-panel" data-testid="error-state">
				<div class="error-code">SYS_ERR</div>
				<p class="error-msg">{error}</p>
				<button onclick={() => window.location.reload()} class="arcade-btn">RETRY SCAN</button>
			</div>
		{:else if puzzles.length === 0}
			<div class="empty-panel" data-testid="empty-state">
				<div class="empty-icon">
					<svg
						class="icon-svg"
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
				<h2 class="empty-title">NO MISSIONS AVAILABLE</h2>
				<p class="empty-sub">Initialize the system via the admin portal.</p>
				<a href={resolve('/admin')} class="arcade-btn">ADMIN PORTAL</a>
			</div>
		{:else if filteredPuzzles.length === 0}
			<div class="empty-panel">
				<h2 class="empty-title">NO MISSIONS IN THIS SECTOR</h2>
				<p class="empty-sub">Select a different category filter to continue.</p>
				<button onclick={() => (selectedCategory = CATEGORY_ALL)} class="arcade-btn">
					CLEAR FILTER
				</button>
			</div>
		{:else}
			<div class="puzzle-grid" data-testid="puzzle-grid">
				{#each filteredPuzzles as puzzle (puzzle.id)}
					<PuzzleCard {puzzle} />
				{/each}
			</div>
		{/if}
	</div>
</main>

<style>
	.game-main {
		min-height: 100vh;
		background-color: var(--bg-0);
		background-image:
			linear-gradient(rgba(0, 240, 255, 0.025) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0, 240, 255, 0.025) 1px, transparent 1px);
		background-size: 48px 48px;
	}

	.content-wrap {
		max-width: 80rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	@media (min-width: 640px) {
		.content-wrap {
			padding: 2.5rem 2rem 4rem;
		}
	}

	/* Header */
	.game-header {
		margin-bottom: 3rem;
	}

	.header-line {
		height: 1px;
		background: linear-gradient(
			90deg,
			transparent 0%,
			var(--accent) 30%,
			var(--accent) 70%,
			transparent 100%
		);
		opacity: 0.4;
	}

	.header-inner {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		padding: 1.25rem 0;
		gap: 1rem;
	}

	.title-block {
		flex-shrink: 0;
	}

	.system-tag {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		opacity: 0.6;
		margin-bottom: 0.25rem;
	}

	.game-title {
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 5vw, 3.25rem);
		font-weight: 900;
		letter-spacing: 0.06em;
		color: var(--text-0);
		line-height: 1;
		text-transform: uppercase;
	}

	.title-glow {
		color: var(--accent);
		text-shadow:
			0 0 20px var(--accent),
			0 0 50px var(--accent-glow-strong);
		margin-left: 0.3em;
	}

	.header-right {
		text-align: right;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		align-items: flex-end;
	}

	.directive-label {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		letter-spacing: 0.25em;
		color: var(--text-2);
		text-transform: uppercase;
	}

	.count-display {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		letter-spacing: 0.15em;
		color: var(--accent);
		opacity: 0.7;
	}

	.filter-row {
		padding-top: 1.25rem;
	}

	/* Loading state */
	.state-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 6rem 0;
		gap: 1.5rem;
	}

	.loading-ring {
		width: 2.75rem;
		height: 2.75rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
		box-shadow: 0 0 20px var(--accent-glow);
	}

	.state-label {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.25em;
		color: var(--accent);
		animation: neon-flicker 3s ease-in-out infinite;
	}

	/* Error state */
	.error-panel {
		background: var(--bg-1);
		border: 1px solid var(--hot);
		padding: 3rem 2rem;
		text-align: center;
		box-shadow:
			0 0 40px var(--hot-glow),
			inset 0 0 40px rgba(255, 0, 102, 0.04);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.error-code {
		font-family: var(--font-display);
		font-size: 1.75rem;
		font-weight: 900;
		color: var(--hot);
		text-shadow: 0 0 25px var(--hot);
		letter-spacing: 0.15em;
	}

	.error-msg {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--text-1);
		letter-spacing: 0.05em;
	}

	/* Empty state */
	.empty-panel {
		background: var(--bg-1);
		border: 1px solid var(--border);
		padding: 4rem 2rem;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.empty-icon {
		opacity: 0.35;
		animation: float 3s ease-in-out infinite;
	}

	.icon-svg {
		width: 4rem;
		height: 4rem;
		color: var(--text-1);
	}

	.empty-title {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-1);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.empty-sub {
		font-family: var(--font-body);
		font-size: 0.9rem;
		color: var(--text-2);
		letter-spacing: 0.05em;
	}

	/* Arcade button */
	.arcade-btn {
		display: inline-block;
		font-family: var(--font-display);
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		text-decoration: none;
		border: 1px solid var(--accent);
		color: var(--accent);
		background: transparent;
		padding: 0.625rem 1.75rem;
		cursor: pointer;
		transition: all 0.2s ease;
		margin-top: 0.5rem;
		position: relative;
		overflow: hidden;
	}

	.arcade-btn::before {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(135deg, var(--accent-glow) 0%, transparent 60%);
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	.arcade-btn:hover {
		background: var(--accent-glow);
		box-shadow: 0 0 25px var(--accent-glow-strong);
		text-shadow: 0 0 10px var(--accent);
	}

	.arcade-btn:hover::before {
		opacity: 1;
	}

	/* Puzzle grid */
	.puzzle-grid {
		display: grid;
		grid-template-columns: repeat(1, 1fr);
		gap: 1.25rem;
		animation: slide-up 0.4s ease-out;
	}

	@media (min-width: 540px) {
		.puzzle-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (min-width: 768px) {
		.puzzle-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}

	@media (min-width: 1024px) {
		.puzzle-grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}
</style>
