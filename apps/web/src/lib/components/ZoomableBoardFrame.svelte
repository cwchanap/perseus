<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		scale: number;
		panX: number;
		panY: number;
		onWheel: (event: WheelEvent) => void;
		children?: Snippet;
	}

	let { scale, panX, panY, onWheel, children }: Props = $props();
</script>

<div
	data-testid="zoomable-board-frame"
	class="frame"
	style="transform: translate({panX}px, {panY}px) scale({scale});"
	onwheel={onWheel}
>
	{@render children?.()}
</div>

<style>
	.frame {
		transform-origin: center;
		transition: transform 0.1s ease-out;
	}
</style>
