<script lang="ts">
	import { onMount } from 'svelte';
	import type { PuzzleSummary } from '$lib/types/puzzle';
	import { getThumbnailUrl } from '$lib/services/api';
	import { getBestTime } from '$lib/services/stats';
	import { formatTime } from '$lib/stores/timer';
	import CategoryBadge from './CategoryBadge.svelte';
	import { resolve } from '$app/paths';

	interface Props {
		puzzle: PuzzleSummary;
	}

	let { puzzle }: Props = $props();

	let bestTime: number | null = $state(null);

	onMount(() => {
		bestTime = getBestTime(puzzle.id);
	});
</script>

<a href={resolve(`/puzzle/${puzzle.id}`)} class="puzzle-card" data-testid="puzzle-card">
	<div class="card-image-wrap">
		<img src={getThumbnailUrl(puzzle.id)} alt={puzzle.name} class="card-image" loading="lazy" />
		<div class="card-overlay">
			<span class="play-label">▶ PLAY</span>
		</div>
		<!-- Corner accent brackets -->
		<div class="corner tl"></div>
		<div class="corner tr"></div>
		<div class="corner bl"></div>
		<div class="corner br"></div>

		{#if puzzle.category}
			<div class="badge-pos">
				<CategoryBadge category={puzzle.category} />
			</div>
		{/if}
	</div>

	<div class="card-body">
		<h3 class="card-name">{puzzle.name}</h3>
		<div class="card-meta">
			<span class="pieces-count">
				<span class="meta-pip"></span>
				{puzzle.pieceCount} PCS
			</span>
			{#if bestTime !== null}
				<span class="best-time" data-testid="card-best-time">
					◆ {formatTime(bestTime)}
				</span>
			{/if}
		</div>
	</div>
</a>

<style>
	.puzzle-card {
		display: block;
		text-decoration: none;
		background: var(--bg-1);
		border: 1px solid var(--border);
		position: relative;
		overflow: hidden;
		transition:
			transform 0.2s ease,
			border-color 0.25s ease,
			box-shadow 0.25s ease;
	}

	.puzzle-card:hover {
		border-color: var(--accent);
		box-shadow:
			0 0 30px var(--accent-glow),
			0 8px 24px rgba(0, 0, 0, 0.6);
		transform: translateY(-4px);
	}

	/* Image */
	.card-image-wrap {
		position: relative;
		aspect-ratio: 1;
		overflow: hidden;
		background: var(--bg-2);
	}

	.card-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transition:
			transform 0.35s ease,
			filter 0.3s ease;
		display: block;
	}

	.puzzle-card:hover .card-image {
		transform: scale(1.06);
		filter: brightness(0.6) saturate(0.8);
	}

	.card-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	.puzzle-card:hover .card-overlay {
		opacity: 1;
	}

	.play-label {
		font-family: var(--font-display);
		font-size: 0.85rem;
		font-weight: 700;
		letter-spacing: 0.3em;
		color: var(--accent);
		text-shadow: 0 0 20px var(--accent);
		border: 1px solid var(--accent);
		padding: 0.5rem 1.5rem;
		background: rgba(0, 240, 255, 0.08);
		backdrop-filter: blur(6px);
		box-shadow: 0 0 30px var(--accent-glow);
	}

	/* Corner brackets */
	.corner {
		position: absolute;
		width: 14px;
		height: 14px;
		border-color: var(--accent);
		opacity: 0;
		transition: opacity 0.25s ease;
	}

	.puzzle-card:hover .corner {
		opacity: 1;
	}

	.tl {
		top: 7px;
		left: 7px;
		border-top: 2px solid;
		border-left: 2px solid;
	}
	.tr {
		top: 7px;
		right: 7px;
		border-top: 2px solid;
		border-right: 2px solid;
	}
	.bl {
		bottom: 7px;
		left: 7px;
		border-bottom: 2px solid;
		border-left: 2px solid;
	}
	.br {
		bottom: 7px;
		right: 7px;
		border-bottom: 2px solid;
		border-right: 2px solid;
	}

	.badge-pos {
		position: absolute;
		top: 0.5rem;
		left: 0.5rem;
	}

	/* Card body */
	.card-body {
		padding: 0.875rem 1rem 1rem;
		border-top: 1px solid var(--border);
		background: var(--bg-1);
	}

	.card-name {
		font-family: var(--font-display);
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.1em;
		color: var(--text-0);
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
		text-transform: uppercase;
	}

	.card-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 0.5rem;
	}

	.pieces-count {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--text-2);
		letter-spacing: 0.12em;
	}

	.meta-pip {
		width: 5px;
		height: 5px;
		background: var(--accent);
		border-radius: 50%;
		box-shadow: 0 0 6px var(--accent);
		flex-shrink: 0;
	}

	.best-time {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--gold);
		letter-spacing: 0.1em;
		text-shadow: 0 0 10px var(--gold-glow);
	}
</style>
