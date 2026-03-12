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

<fieldset class="flex flex-wrap gap-[0.4rem]" data-testid="category-filter">
	<legend class="sr-only">Filter by category</legend>
	{#each allCategories as cat (cat)}
		<label class="relative">
			<input
				type="radio"
				name="puzzle-category"
				value={cat}
				checked={selected === cat}
				onchange={() => onSelect(cat)}
				class="peer sr-only"
			/>
			<span
				class="
					relative inline-flex cursor-pointer items-center border border-(--border) px-3.5
					py-[0.4rem] text-[0.58rem] font-(--font-display) tracking-[0.18em] text-(--text-2)
					uppercase transition-[color,border-color,background,box-shadow,text-shadow]
					duration-150 ease-in-out peer-checked:border-(--accent)
					peer-checked:bg-(--accent-glow) peer-checked:text-(--accent)
					peer-checked:[box-shadow:0_0_18px_var(--accent-glow)]
					peer-checked:[text-shadow:0_0_8px_var(--accent)] peer-focus-visible:border-(--accent)
					peer-focus-visible:bg-(--accent-glow) peer-focus-visible:text-(--accent)
					peer-focus-visible:[outline:2px_solid_var(--accent)]
					peer-focus-visible:[outline-offset:2px] after:pointer-events-none
					after:absolute after:right-0 after:-bottom-px after:left-0 after:h-[2px]
					after:bg-(--accent) after:opacity-0 after:[box-shadow:0_0_8px_var(--accent)]
					after:transition-opacity after:duration-150 after:ease-in-out after:content-['']
					peer-checked:after:opacity-100 hover:border-(--accent-dim)
					hover:bg-(--accent-glow) hover:text-(--accent)
				"
			>
				{cat}
			</span>
		</label>
	{/each}
</fieldset>
