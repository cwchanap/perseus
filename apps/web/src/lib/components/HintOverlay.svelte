<script lang="ts">
	interface Props {
		active: boolean;
		targetX: number | undefined;
		targetY: number | undefined;
		cellSize: number;
	}

	let { active, targetX, targetY, cellSize }: Props = $props();

	const highlightStyle = $derived.by(() => {
		if (targetX === undefined || targetY === undefined) {
			return null;
		}

		return `left: ${targetX * cellSize}px; top: ${targetY * cellSize}px; width: ${cellSize}px; height: ${cellSize}px;`;
	});
</script>

{#if active}
	<div
		data-testid="hint-overlay"
		class="pointer-events-none absolute top-0 left-0 z-[100] h-full w-full"
	>
		{#if highlightStyle}
			<div
				data-testid="hint-highlight"
				class="absolute rounded-md [border-width:3px] border-amber-400 bg-amber-400/20 shadow-[0_0_0_2px_rgba(0,0,0,0.1),0_0_20px_rgba(251,191,36,0.5)] motion-safe:animate-[hint-pulse_1.5s_ease-in-out_infinite] motion-reduce:animate-none"
				style={highlightStyle}
			></div>
		{/if}
	</div>
{/if}
