<script lang="ts">
	import { PUZZLE_CATEGORIES, CATEGORY_ALL } from '$lib/constants/categories';
	import type { PuzzleCategory } from '$lib/constants/categories';

	interface Props {
		selected: PuzzleCategory | typeof CATEGORY_ALL;
		onSelect: (category: PuzzleCategory | typeof CATEGORY_ALL) => void;
	}

	let { selected, onSelect }: Props = $props();

	const allCategories: (PuzzleCategory | typeof CATEGORY_ALL)[] = [
		CATEGORY_ALL,
		...PUZZLE_CATEGORIES
	];
</script>

<div
	class="filter-row"
	data-testid="category-filter"
	role="radiogroup"
	aria-label="Filter by category"
>
	{#each allCategories as cat (cat)}
		<button
			type="button"
			onclick={() => onSelect(cat)}
			class="filter-btn"
			class:active={selected === cat}
			role="radio"
			aria-checked={selected === cat}
		>
			{cat}
		</button>
	{/each}
</div>

<style>
	.filter-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.filter-btn {
		font-family: var(--font-display);
		font-size: 0.58rem;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		padding: 0.4rem 0.875rem;
		border: 1px solid var(--border);
		color: var(--text-2);
		background: transparent;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease,
			background 0.15s ease,
			box-shadow 0.15s ease;
		position: relative;
	}

	.filter-btn:hover {
		border-color: var(--accent-dim);
		color: var(--accent);
		background: var(--accent-glow);
	}

	.filter-btn.active {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-glow);
		box-shadow: 0 0 18px var(--accent-glow);
		text-shadow: 0 0 8px var(--accent);
	}

	.filter-btn.active::after {
		content: '';
		position: absolute;
		bottom: -1px;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
	}
</style>
