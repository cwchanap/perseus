<script lang="ts">
	import { getReferenceImageUrl } from '$lib/services/api';

	interface Props {
		puzzleId: string;
		active: boolean;
	}

	let { puzzleId, active }: Props = $props();
</script>

{#if active}
	<div
		data-testid="reference-overlay"
		class="pointer-events-none fixed inset-0 z-[1000] flex items-center justify-center bg-black/80"
	>
		<img
			src={getReferenceImageUrl(puzzleId)}
			alt="Puzzle reference"
			class="max-h-[90%] max-w-[90%] rounded-md object-contain shadow-lg"
		/>
	</div>
{/if}
