<script lang="ts">
	interface Props {
		imageUrl?: string | null;
		active: boolean;
	}

	let { imageUrl = null, active }: Props = $props();
	let imageError = $state(false);

	$effect(() => {
		if (active) imageError = false;
	});
</script>

{#if active}
	<div
		data-testid="reference-overlay"
		class="pointer-events-none fixed inset-0 z-[1000] flex items-center justify-center bg-black/80"
	>
		{#if imageError || imageUrl === null}
			<p class="text-sm text-white/70">Reference image unavailable</p>
		{:else}
			<img
				src={imageUrl}
				alt="Puzzle reference"
				class="max-h-[90%] max-w-[90%] rounded-md object-contain shadow-lg"
				onerror={() => (imageError = true)}
			/>
		{/if}
	</div>
{/if}
