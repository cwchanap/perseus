<script lang="ts">
	interface Props {
		active: boolean;
		targetX: number | undefined;
		targetY: number | undefined;
		cellSize: number;
	}

	let { active, targetX, targetY, cellSize }: Props = $props();

	const hasTarget = $derived(targetX !== undefined && targetY !== undefined);
</script>

{#if active}
	<div data-testid="hint-overlay" class="overlay">
		{#if hasTarget}
			<div
				data-testid="hint-highlight"
				class="highlight"
				style="
					left: {targetX * cellSize}px;
					top: {targetY * cellSize}px;
					width: {cellSize}px;
					height: {cellSize}px;
				"
			></div>
		{/if}
	</div>
{/if}

<style>
	.overlay {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 100;
	}

	.highlight {
		position: absolute;
		border: 3px solid #fbbf24;
		background: rgba(251, 191, 36, 0.2);
		border-radius: 0.25rem;
		box-shadow:
			0 0 0 2px rgba(0, 0, 0, 0.1),
			0 0 20px rgba(251, 191, 36, 0.5);
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.7;
			transform: scale(1.05);
		}
	}
</style>
