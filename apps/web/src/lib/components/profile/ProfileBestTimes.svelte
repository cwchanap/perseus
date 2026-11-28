<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PlayerStatRow } from '$lib/types/puzzle';
	import { getFamilyThumbnailUrl } from '$lib/services/api';
	import { formatTime } from '$lib/stores/timer';
	import { ICONS } from '$lib/constants/icons';
	import DifficultyGems from '$lib/components/DifficultyGems.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';

	interface Props {
		stats: PlayerStatRow[];
		hasMore: boolean;
		loadingMore: boolean;
		onLoadMore: () => void;
	}

	let { stats, hasMore, loadingMore, onLoadMore }: Props = $props();

	function hideBrokenThumb(event: Event) {
		(event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
	}
</script>

<section class="grid gap-3.5">
	<div class="flex items-center gap-3">
		<h2 class="arcade-section-title">Best times</h2>
		{#if stats.length > 0}
			<span class="arcade-chip">{stats.length} SHOWN</span>
		{/if}
	</div>

	{#if stats.length === 0}
		<EmptyState
			icon={ICONS.clock}
			title="No solves yet"
			message="Finish a puzzle and your best times will show up here."
			testId="best-times-empty"
		>
			<a class="arcade-btn" href={resolve('/')}>Play a puzzle</a>
		</EmptyState>
	{:else}
		<div class="arcade-panel overflow-hidden" data-testid="best-times-list">
			<div class="results-row results-head" aria-hidden="true">
				<span>PUZZLE</span><span>DIFFICULTY</span><span>PLAYS</span><span>STANDARD</span><span
					>ROTATION</span
				>
			</div>
			{#each stats as s (`${s.familyId}-${s.difficulty}`)}
				<div class="results-row">
					<div class="cell-puzzle flex min-w-0 items-center gap-3">
						<span class="thumb">
							<img
								src={getFamilyThumbnailUrl(s.familyId)}
								alt=""
								loading="lazy"
								onerror={hideBrokenThumb}
							/>
						</span>
						<div class="min-w-0">
							{#if s.familyName}
								<div class="text-[1.1rem] font-bold [overflow-wrap:anywhere]">{s.familyName}</div>
							{:else}
								<div
									class="font-(family-name:--font-mono) text-[0.85rem] [overflow-wrap:anywhere] text-(--text-2)"
								>
									{s.familyId}
								</div>
							{/if}
							<div class="difficulty difficulty-inline">
								<span class="flex" aria-hidden="true"
									><DifficultyGems difficulty={s.difficulty} /></span
								>
								<span class="capitalize">{s.difficulty}</span>
							</div>
						</div>
					</div>
					<div class="difficulty difficulty-column">
						<span class="flex" aria-hidden="true"><DifficultyGems difficulty={s.difficulty} /></span
						>
						<span class="capitalize">{s.difficulty}</span>
					</div>
					<span class="plays">×{s.totalCompletions}</span>
					<div class="times">
						{#if s.standardBestTimeSeconds === null && s.rotationBestTimeSeconds === null}
							<span class="no-time">No timed bests</span>
						{:else}
							{#if s.standardBestTimeSeconds !== null}
								<span class="time-pill time-pill-standard">
									<span class="time-tag" aria-hidden="true">STD</span><span class="sr-only"
										>Standard best
									</span>{formatTime(s.standardBestTimeSeconds)}
								</span>
							{:else}
								<span class="no-time no-time-dash"
									><span aria-hidden="true">—</span><span class="sr-only">No standard best</span
									></span
								>
							{/if}
							{#if s.rotationBestTimeSeconds !== null}
								<span class="time-pill time-pill-rotation">
									<span class="time-tag" aria-hidden="true">ROT</span><span class="sr-only"
										>Rotation best
									</span>{formatTime(s.rotationBestTimeSeconds)}
								</span>
							{:else}
								<span class="no-time no-time-dash"
									><span aria-hidden="true">—</span><span class="sr-only">No rotation best</span
									></span
								>
							{/if}
						{/if}
					</div>
				</div>
			{/each}
		</div>
		{#if hasMore}
			<div class="flex justify-center">
				<button
					type="button"
					data-testid="load-more-stats"
					class="arcade-btn-ghost"
					onclick={onLoadMore}
					disabled={loadingMore}
				>
					{loadingMore ? 'Loading…' : 'Load more'}
				</button>
			</div>
		{/if}
	{/if}
</section>

<style>
	.results-row {
		display: grid;
		grid-template-areas:
			'puzzle plays'
			'times times';
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px 12px;
		padding: 14px 16px;
		border-top: 1px solid var(--border);
	}

	.results-head {
		display: none;
	}

	.results-head + .results-row {
		border-top: 0;
	}

	.cell-puzzle {
		grid-area: puzzle;
	}

	.thumb {
		display: block;
		width: 46px;
		height: 46px;
		flex: none;
		overflow: hidden;
		border-radius: 13px;
		background: var(--bg-2);
		box-shadow: 0 0 0 1px var(--border-bright);
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.difficulty {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-1);
		font-size: 0.98rem;
		font-weight: 600;
	}

	.difficulty-inline {
		margin-top: 3px;
	}

	.difficulty-column {
		display: none;
	}

	.plays {
		grid-area: plays;
		align-self: start;
		color: var(--text-1);
		font-family: var(--font-mono);
		font-size: 0.9rem;
	}

	.times {
		display: flex;
		grid-area: times;
		flex-wrap: wrap;
		gap: 8px;
	}

	.time-pill {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: 6px;
		padding: 5px 10px;
		border-radius: 12px;
		font-family: var(--font-mono);
		font-size: 0.92rem;
	}

	.time-tag {
		font-size: 0.62rem;
		letter-spacing: 0.12em;
		opacity: 0.8;
	}

	.time-pill-standard {
		border: 1px solid rgba(255, 204, 0, 0.4);
		background: rgba(255, 204, 0, 0.1);
		color: var(--gold);
	}

	.time-pill-rotation {
		border: 1px solid rgba(58, 255, 255, 0.36);
		background: rgba(0, 240, 255, 0.08);
		color: var(--accent);
	}

	.no-time {
		color: var(--text-2);
		font-family: var(--font-mono);
		font-size: 0.9rem;
	}

	.no-time-dash {
		display: none;
	}

	@media (min-width: 1024px) {
		.results-row {
			grid-template-areas: none;
			grid-template-columns: minmax(0, 1fr) 150px 70px 118px 118px;
			gap: 14px;
			padding: 12px 20px;
		}

		.results-row:hover:not(.results-head) {
			background: rgba(28, 20, 64, 0.7);
		}

		.results-head {
			display: grid;
			padding-top: 12px;
			padding-bottom: 10px;
			border-top: 0;
			background: rgba(10, 6, 32, 0.45);
			color: var(--text-2);
			font-family: var(--font-mono);
			font-size: 0.66rem;
			letter-spacing: 0.2em;
		}

		.difficulty-inline,
		.time-tag {
			display: none;
		}

		.difficulty-column {
			display: flex;
		}

		.cell-puzzle,
		.plays {
			grid-area: auto;
			align-self: center;
		}

		.times {
			display: contents;
		}

		.no-time-dash {
			display: inline;
		}
	}
</style>
