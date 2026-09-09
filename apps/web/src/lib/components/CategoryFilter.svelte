<script lang="ts">
	import { PUZZLE_CATEGORIES, CATEGORY_ALL } from '$lib/constants/categories';
	import type { PuzzleCategory } from '$lib/constants/categories';
	import CategoryBadge from './CategoryBadge.svelte';

	interface Props {
		selected: PuzzleCategory | typeof CATEGORY_ALL;
		onSelect: (category: PuzzleCategory | typeof CATEGORY_ALL) => void;
		total?: number;
	}

	let { selected, onSelect, total }: Props = $props();

	const allCategories: (PuzzleCategory | typeof CATEGORY_ALL)[] = [
		CATEGORY_ALL,
		...PUZZLE_CATEGORIES
	];
</script>

<fieldset class="category-filter" data-testid="category-filter">
	<legend class="sr-only">Filter by category</legend>
	{#each allCategories as cat (cat)}
		<label class="category-option">
			<input
				type="radio"
				name="puzzle-category"
				value={cat}
				checked={selected === cat}
				onchange={() => onSelect(cat)}
				class="sr-only"
			/>
			{#if cat === CATEGORY_ALL}
				<span class="category-chip category-chip-all">
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
					</svg>
					<span aria-hidden="true">{total ?? 'ALL'}</span>
					<span class="sr-only">{cat}</span>
				</span>
			{:else}
				<span class="category-chip category-icon-chip">
					<CategoryBadge category={cat} compact />
				</span>
			{/if}
		</label>
	{/each}
</fieldset>

<style>
	.category-filter {
		display: flex;
		max-width: 100%;
		flex-wrap: nowrap;
		gap: 0.5625rem;
		margin: 0;
		padding: 0;
		border: 0;
		overflow-x: auto;
		-ms-overflow-style: none;
		scrollbar-width: none;
	}

	.category-filter::-webkit-scrollbar {
		display: none;
	}

	.category-option {
		position: relative;
		display: flex;
		flex: 0 0 auto;
	}

	.category-chip {
		display: inline-flex;
		height: 2.5rem;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		border: 1px solid var(--border-bright);
		border-radius: 1.25rem;
		background: var(--bg-2);
		color: var(--text-2);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			box-shadow 0.15s ease,
			color 0.15s ease;
	}

	.category-chip-all {
		width: 4.125rem;
		gap: 0.45rem;
		font-family: var(--font-body);
		font-size: 0.95rem;
		font-weight: 700;
	}

	.category-chip-all svg {
		width: 0.95rem;
		height: 0.95rem;
	}

	.category-icon-chip {
		width: 2.75rem;
	}

	.category-icon-chip :global([data-testid='category-badge']) {
		color: var(--category-accent);
	}

	.category-chip :global(svg) {
		width: 1.125rem;
		height: 1.125rem;
	}

	.category-option input:checked + .category-chip {
		border-color: var(--accent);
		background: linear-gradient(160deg, #5affff, #00c2dc);
		box-shadow:
			0 3px 0 #00707f,
			0 8px 18px rgba(0, 240, 255, 0.28);
		color: #03202a;
	}

	.category-option input:focus-visible + .category-chip {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.category-option:hover .category-chip {
		border-color: var(--accent-dim);
		color: var(--text-0);
	}

	@media (max-width: 39.999rem) {
		.category-chip {
			height: 2.375rem;
		}

		.category-chip-all {
			width: 4.125rem;
		}

		.category-icon-chip {
			width: 2.625rem;
		}
	}
</style>
