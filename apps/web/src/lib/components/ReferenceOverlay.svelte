<script lang="ts">
	import { getReferenceImageUrl } from '$lib/services/api';

	export let puzzleId: string;
	export let active: boolean;
</script>

{#if active}
	<div data-testid="reference-overlay" class="overlay">
		<img src={getReferenceImageUrl(puzzleId)} alt="" class="reference-image" />
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.8);
		z-index: 1000;
	}

	.reference-image {
		max-width: 90%;
		max-height: 90%;
		object-fit: contain;
		border-radius: 0.5rem;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	}
</style>
