<script lang="ts">
	import type { PuzzleCategory } from '$lib/constants/categories';

	interface Props {
		category: PuzzleCategory | undefined;
	}

	let { category }: Props = $props();
</script>

{#if category}
	<span class="category-badge" data-testid="category-badge">
		{category}
	</span>
{/if}

<style>
	.category-badge {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--accent-dim);
		background: rgba(4, 4, 13, 0.8);
		padding: 0.2rem 0.5rem;
		font-size: 0.58rem;
		font-family: var(--font-mono);
		letter-spacing: 0.18em;
		color: var(--accent);
		text-transform: uppercase;
		backdrop-filter: blur(4px);
	}
</style>
