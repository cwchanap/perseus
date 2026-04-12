<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		scale: number;
		panX: number;
		panY: number;
		isPanning?: boolean;
		onWheel: (event: WheelEvent) => void;
		children?: Snippet;
	}

	let { scale, panX, panY, isPanning = false, onWheel, children }: Props = $props();
</script>

<div
	data-testid="zoomable-board-frame"
	class="origin-center {isPanning ? '' : 'transition-transform duration-100 ease-out'}"
	style="transform: translate({panX}px, {panY}px) scale({scale});"
	onwheel={onWheel}
>
	{@render children?.()}
</div>
