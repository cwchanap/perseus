<script lang="ts">
	import type { PuzzleDifficulty, PuzzleFamilySummary, PuzzleVariantSummary } from '@perseus/types';
	import { PUZZLE_DIFFICULTIES } from '@perseus/types';
	import { getBestTime } from '$lib/services/stats';
	import { formatTime } from '$lib/stores/timer';
	import { resolve } from '$app/paths';
	import DifficultyGems from './DifficultyGems.svelte';

	interface VariantProgress {
		placedCount: number;
		pieceCount: number;
	}

	interface Props {
		family: PuzzleFamilySummary;
		progressByVariantId?: ReadonlyMap<string, VariantProgress>;
		/** When false, ready rows are informational only (no play links). */
		playableLinks?: boolean;
	}

	interface DifficultyPresentation {
		label: string;
	}

	const difficultyPresentation: Record<PuzzleDifficulty, DifficultyPresentation> = {
		easy: { label: 'Easy' },
		normal: { label: 'Normal' },
		hard: { label: 'Hard' }
	};

	let { family, progressByVariantId, playableLinks = true }: Props = $props();

	function variantProgress(variant: PuzzleVariantSummary): VariantProgress | undefined {
		return progressByVariantId?.get(variant.id);
	}

	function variantBestTime(variantId: string): number | null {
		return getBestTime(variantId);
	}
</script>

<div class="difficulty-picker" data-testid="difficulty-picker">
	{#each PUZZLE_DIFFICULTIES as difficulty (difficulty)}
		{@const variant = family.variants[difficulty]}
		{@const presentation = difficultyPresentation[difficulty]}
		{@const progress = variantProgress(variant)}
		{@const bestTime =
			playableLinks && variant.status === 'ready' ? variantBestTime(variant.id) : null}
		{@const hasProgress = playableLinks && variant.status === 'ready' && progress !== undefined}
		{@const progressLabel =
			progress !== undefined ? ` ${progress.placedCount}/${progress.pieceCount}` : ''}
		{#if variant.status === 'ready' && playableLinks}
			<a
				href={resolve(`/puzzle/${variant.id}`)}
				class="difficulty-action"
				class:difficulty-action-active={hasProgress}
				aria-label={`${presentation.label} difficulty, ${variant.pieceCount} pieces${hasProgress ? `, continue saved progress${progressLabel}` : ''}`}
				data-testid="difficulty-action"
				data-difficulty={difficulty}
			>
				<span class="difficulty-gems-wrap">
					<DifficultyGems {difficulty} pieceCount={variant.pieceCount} />
					{#if hasProgress}
						<span class="sr-only" data-testid="difficulty-progress">
							{progress.placedCount}/{progress.pieceCount}
						</span>
					{/if}
				</span>
				{#if bestTime !== null}
					<span
						class="difficulty-best-time"
						data-testid="difficulty-best-time"
						data-difficulty={difficulty}
					>
						◆ {formatTime(bestTime)}
					</span>
				{/if}
			</a>
		{:else}
			<div
				class="difficulty-action difficulty-action-unavailable"
				aria-label={`${presentation.label} difficulty, ${variant.pieceCount} pieces, unavailable`}
				role="group"
				data-testid="difficulty-action"
				data-difficulty={difficulty}
			>
				<span class="difficulty-gems-wrap">
					<DifficultyGems {difficulty} pieceCount={variant.pieceCount} />
				</span>
			</div>
		{/if}
	{/each}
</div>

<style>
	.difficulty-picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.difficulty-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 8px 12px;
		background: var(--bg-0);
		color: var(--text-1);
		font-family: var(--font-mono);
		font-size: 0.65rem;
		letter-spacing: 0.1em;
		text-decoration: none;
		transition:
			border-color 150ms ease,
			background 150ms ease,
			box-shadow 150ms ease;
	}

	.difficulty-action:hover,
	.difficulty-action:focus-visible {
		border-color: var(--accent);
		background: rgba(0, 240, 255, 0.04);
	}

	.difficulty-action-active {
		border-color: var(--accent);
		background: linear-gradient(150deg, rgba(0, 240, 255, 0.2), rgba(0, 184, 216, 0.08));
		box-shadow: 0 3px 0 #00707f;
	}

	.difficulty-action-unavailable {
		opacity: 0.7;
	}

	.difficulty-gems-wrap {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
	}

	.difficulty-best-time {
		flex-shrink: 0;
		color: var(--gold);
		text-shadow: 0 0 10px var(--gold-glow);
		white-space: nowrap;
	}
</style>
