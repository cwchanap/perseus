<script lang="ts">
	import { PUZZLE_CATEGORIES, CATEGORY_ALL } from '$lib/constants/categories';

	interface Props {
		selected: string;
		onSelect: (category: string) => void;
	}

	let { selected, onSelect }: Props = $props();

	const allCategories: string[] = [CATEGORY_ALL, ...PUZZLE_CATEGORIES];
</script>

<div
	class="flex flex-wrap gap-2"
	data-testid="category-filter"
	role="radiogroup"
	aria-label="Filter by category"
>
	{#each allCategories as cat (cat)}
		<button
			type="button"
			onclick={() => onSelect(cat)}
			class="rounded-full px-3 py-1 text-sm font-medium transition-colors
				{selected === cat ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}"
			role="radio"
			aria-checked={selected === cat}
		>
			{cat}
		</button>
	{/each}
</div>
