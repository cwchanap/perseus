<script lang="ts">
	interface Props {
		percent: number;
		size?: number;
		accent?: 'cyan' | 'magenta' | 'gold';
		showValue?: boolean;
		label: string;
	}

	const accentColors = {
		cyan: 'var(--accent)',
		magenta: 'var(--hot)',
		gold: 'var(--gold)'
	} as const;

	let { percent, size = 58, accent = 'cyan', showValue = true, label }: Props = $props();

	const clampedPercent = $derived(
		Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
	);
	const ringStyle = $derived(
		`--ring-size: ${size}px; --ring-progress: ${clampedPercent}%; --ring-accent: ${accentColors[accent]}`
	);
</script>

<div
	class="progress-ring"
	role="progressbar"
	aria-label={label}
	aria-valuemin="0"
	aria-valuemax="100"
	aria-valuenow={clampedPercent}
	data-testid="progress-ring"
	style={ringStyle}
>
	<div class="progress-ring-inner">
		{#if showValue}
			<span data-testid="progress-ring-value" aria-hidden="true">{Math.round(clampedPercent)}</span>
		{/if}
	</div>
</div>

<style>
	.progress-ring {
		display: inline-flex;
		width: var(--ring-size);
		height: var(--ring-size);
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: conic-gradient(
			var(--ring-accent) 0 var(--ring-progress),
			rgba(255, 255, 255, 0.1) var(--ring-progress) 100%
		);
		box-shadow: 0 0 22px color-mix(in srgb, var(--ring-accent) 45%, transparent);
		color: var(--ring-accent);
		font-family: var(--font-display);
		font-size: 0.8rem;
		font-weight: 900;
	}

	.progress-ring-inner {
		display: flex;
		width: calc(var(--ring-size) - 14px);
		height: calc(var(--ring-size) - 14px);
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--bg-0);
	}
</style>
