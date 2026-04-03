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
	class="origin-center transition-transform duration-100 ease-out"
	style="transform: translate({panX}px, {panY}px) scale({scale});"
	onwheel={onWheel}
>
	{@render children?.()}
</div>
