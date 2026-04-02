<script lang="ts">
	export let scale: number;
	export let panX: number;
	export let panY: number;
	export let onWheel: (event: WheelEvent) => void;
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
