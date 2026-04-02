<script lang="ts">
	interface Props {
		scale: number;
		panX: number;
		panY: number;
		onWheel: (event: WheelEvent) => void;
	}

	let { scale, panX, panY, onWheel }: Props = $props();
</script>

<div
	data-testid="zoomable-board-frame"
	class="frame"
	style="transform: translate({panX}px, {panY}px) scale({scale});"
	onwheel={onWheel}
>
	<slot />
</div>

<style>
	.frame {
		transform-origin: center;
		transition: transform 0.1s ease-out;
	}
</style>
