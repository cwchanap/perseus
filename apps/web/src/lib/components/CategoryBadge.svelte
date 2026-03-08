<script lang="ts">
	import type { PuzzleCategory } from '$lib/constants/categories';

	interface Props {
		category: PuzzleCategory | undefined;
	}

	let { category }: Props = $props();
</script>

{#if category}
	<span class="cat-badge" data-testid="category-badge">
		{category}
	</span>
{/if}

<style>
	.cat-badge {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 0.58rem;
		letter-spacing: 0.18em;
		padding: 0.2rem 0.5rem;
		background: rgba(4, 4, 13, 0.8);
		border: 1px solid var(--accent-dim);
		color: var(--accent);
		backdrop-filter: blur(4px);
		text-transform: uppercase;
	}
</style>
