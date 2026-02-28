<script lang="ts">
	import type { PuzzleCategory } from '$lib/constants/categories';
	import { CATEGORY_COLORS } from '$lib/constants/categories';

	interface Props {
		category: PuzzleCategory | undefined;
	}

	let { category }: Props = $props();
</script>

{#if category}
	<span
		class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {CATEGORY_COLORS[
			category
		]}"
		data-testid="category-badge"
	>
		{category}
	</span>
{/if}
