<script lang="ts">
	import type { PuzzleCategory } from '$lib/constants/categories';

	interface Props {
		category: PuzzleCategory | undefined;
	}

	let { category }: Props = $props();
</script>

{#if category}
	<span
		class="inline-flex items-center border border-[var(--accent-dim)]
			bg-[rgba(4,4,13,0.8)] px-2 py-[0.2rem] text-[0.58rem]
			font-[var(--font-mono)] tracking-[0.18em] text-[var(--accent)]
			uppercase backdrop-blur-[4px]"
		data-testid="category-badge"
	>
		{category}
	</span>
{/if}
