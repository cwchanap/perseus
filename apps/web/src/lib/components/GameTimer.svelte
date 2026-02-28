<script lang="ts">
	import { formatTime } from '$lib/stores/timer';
	import type { TimerState } from '$lib/stores/timer';

	interface Props {
		timerState: TimerState;
		bestTime?: number | null;
	}

	let { timerState, bestTime = null }: Props = $props();
</script>

<div class="flex items-center gap-3 text-sm">
	<div
		class="flex items-center gap-1.5 font-mono tabular-nums"
		class:text-gray-900={timerState.running}
		class:text-gray-400={!timerState.running}
		data-testid="game-timer"
		aria-label="Timer: {formatTime(timerState.elapsed)}"
		role="timer"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
			/>
		</svg>
		<span>{formatTime(timerState.elapsed)}</span>
	</div>
	{#if bestTime !== null}
		<span class="text-amber-600" data-testid="best-time">
			🏆 {formatTime(bestTime)}
		</span>
	{/if}
</div>
