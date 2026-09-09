<script lang="ts">
	import { formatTime } from '$lib/stores/timer';
	import type { TimerState } from '$lib/stores/timer';

	interface Props {
		timerState: TimerState;
		bestTime?: number | null;
	}

	let { timerState, bestTime = null }: Props = $props();
</script>

<div class="timer-hud">
	<div
		class="timer-block"
		class:timer-on={timerState.running}
		class:timer-off={!timerState.running}
		data-testid="game-timer"
		aria-label="Timer: {formatTime(timerState.elapsed)}"
		role="timer"
	>
		<svg
			class="timer-icon"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			aria-hidden="true"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
			/>
		</svg>
		<span class="timer-value">{formatTime(timerState.elapsed)}</span>
	</div>
	{#if bestTime !== null}
		<div class="best-block" data-testid="best-time">
			<span class="best-icon">◆</span>
			<span class="best-value">{formatTime(bestTime)}</span>
		</div>
	{/if}
</div>

<style>
	.timer-hud {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.timer-block {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 2.25rem;
		padding: 0.35rem 0.7rem;
		border: 1px solid rgb(58 255 255 / 55%);
		border-radius: 0.75rem;
		background: rgb(8 30 57 / 85%);
		box-shadow:
			inset 0 0 14px rgb(58 255 255 / 8%),
			0 0 16px rgb(58 255 255 / 12%);
	}

	.timer-icon {
		width: 0.9rem;
		height: 0.9rem;
		flex-shrink: 0;
	}

	.timer-value {
		font-family: var(--font-mono), 'Share Tech Mono', monospace;
		font-size: 1rem;
		letter-spacing: 0.08em;
		font-variant-numeric: tabular-nums;
	}

	.timer-on .timer-icon,
	.timer-on .timer-value {
		color: var(--accent);
		text-shadow: 0 0 12px var(--accent);
	}

	.timer-on .timer-icon {
		filter: drop-shadow(0 0 4px var(--accent));
	}

	.timer-off .timer-icon,
	.timer-off .timer-value {
		color: var(--text-2);
	}

	.best-block {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 2.25rem;
		padding: 0.35rem 0.65rem;
		border: 1px solid rgb(255 204 0 / 55%);
		border-radius: 0.75rem;
		background: rgb(75 52 7 / 60%);
		box-shadow:
			inset 0 0 14px rgb(255 204 0 / 8%),
			0 0 16px rgb(255 204 0 / 10%);
	}

	.best-icon {
		font-size: 0.55rem;
		color: var(--gold);
		text-shadow: 0 0 6px var(--gold);
	}

	.best-value {
		font-family: var(--font-mono), 'Share Tech Mono', monospace;
		font-size: 0.8rem;
		color: var(--gold);
		text-shadow: 0 0 10px var(--gold-glow);
		letter-spacing: 0.06em;
	}
</style>
