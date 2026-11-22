<script lang="ts">
	import { navigating } from '$app/state';
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

	// A category click applies through an async URL navigation, so the
	// one-way `checked` binding can diverge: the browser checks the radio
	// natively on click, and if the goto is superseded the committed
	// selection never changes and Svelte never reverts the DOM state.
	// `chosen` is the immediate intent; once no navigation is in flight —
	// committed OR aborted — it resyncs to whatever `selected` says, so a
	// stale intent reverts to the committed category.
	// svelte-ignore state_referenced_locally
	// The prop is the intended initial intent; later resync is driven by the
	// navigation-settle effect below.
	let chosen = $state(selected);
	$effect(() => {
		if (navigating.to === null) chosen = selected;
	});
</script>

<fieldset class="category-filter" data-testid="category-filter">
	<legend class="sr-only">Filter by category</legend>
	{#each allCategories as cat (cat)}
		<label class="category-option">
			<input
				type="radio"
				name="puzzle-category"
				value={cat}
				checked={chosen === cat}
				onchange={() => {
					chosen = cat;
					onSelect(cat);
				}}
				class="category-input"
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
					<!-- Filter-local label: revealed only at the wide-header
					     breakpoint below. The badge keeps its own sr-only text, so
					     this stays aria-hidden and never changes the radio's
					     accessible name. -->
					<span class="category-chip-label" aria-hidden="true">{cat}</span>
				</span>
			{/if}
		</label>
	{/each}
</fieldset>

<style>
	.category-filter {
		display: flex;
		max-width: 100%;
		/* Fieldsets get a UA min-inline-size: min-content floor that overrides
		   max-width and pushes the chip row past the viewport on narrow
		   screens; min-width: 0 lets max-width: 100% constrain the box so the
		   row scrolls inside it as designed. */
		min-width: 0;
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

	/* The radio is the real hit target: it invisibly covers the whole chip,
	   so pointer input (mouse, touch, synthetic clicks) reaches the input
	   itself and the checked/focus styling below keeps working via the
	   sibling selector. Keyboard focus and the accessible name (from the
	   label text) are unchanged. */
	.category-input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
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

	.category-chip-label {
		display: none;
		font-family: var(--font-mono, monospace);
		font-size: 0.62rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	/* Wide header: past the 64.01–75rem collapsed-search band the grid hands
	   the categories column ~50rem at the 80rem cap, enough for labeled
	   chips beside the always-open search. Below this breakpoint chips
	   stay icon-only. */
	@media (min-width: 75.0625rem) {
		.category-icon-chip {
			width: auto;
			gap: 0.35rem;
			padding-inline: 0.55rem;
		}

		.category-chip-label {
			display: inline;
		}
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
