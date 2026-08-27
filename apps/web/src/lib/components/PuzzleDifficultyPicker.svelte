<script lang="ts">
	import type { PuzzleFamilySummary, PuzzleVariantSummary } from '@perseus/types';
	import { PUZZLE_DIFFICULTIES } from '@perseus/types';
	import { getBestTime } from '$lib/services/stats';
	import { formatTime } from '$lib/stores/timer';
	import { resolve } from '$app/paths';

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

	let { family, progressByVariantId, playableLinks = true }: Props = $props();

	const difficultyLabels: Record<string, string> = {
		easy: 'Easy',
		normal: 'Normal',
		hard: 'Hard'
	};

	function variantProgress(variant: PuzzleVariantSummary): VariantProgress | undefined {
		return progressByVariantId?.get(variant.id);
	}

	function variantBestTime(variantId: string): number | null {
		return getBestTime(variantId);
	}
</script>

<div class="flex flex-col gap-2" data-testid="difficulty-picker">
	{#each PUZZLE_DIFFICULTIES as difficulty (difficulty)}
		{@const variant = family.variants[difficulty]}
		{@const progress = variantProgress(variant)}
		{@const bestTime =
			playableLinks && variant.status === 'ready' ? variantBestTime(variant.id) : null}
		{@const hasProgress = playableLinks && variant.status === 'ready' && progress !== undefined}
		{#if variant.status === 'ready' && playableLinks}
			<a
				href={resolve(`/puzzle/${variant.id}`)}
				class="group/diff flex items-center justify-between gap-3 border border-(--border) bg-(--bg-0)
				px-3 py-2 text-[0.65rem] font-(--font-mono) tracking-[0.1em] text-(--text-1)
				transition-colors hover:border-(--accent) hover:bg-[rgba(0,240,255,0.04)]"
				data-testid="difficulty-action"
				data-difficulty={difficulty}
			>
				<span class="flex min-w-0 items-center gap-2 text-(--text-0)">
					<span class="font-(--font-display) font-semibold tracking-[0.12em] uppercase">
						{difficultyLabels[difficulty]}
					</span>
					<span class="text-(--text-2)">·</span>
					<span>{variant.pieceCount}</span>
					{#if hasProgress}
						<span class="text-(--text-2)">·</span>
						<span class="text-(--accent)">
							CONTINUE {progress.placedCount}/{progress.pieceCount}
						</span>
					{:else}
						<span class="text-(--text-2)">·</span>
						<span class="text-(--accent) opacity-0 transition-opacity group-hover/diff:opacity-100">
							PLAY
						</span>
					{/if}
				</span>
				{#if bestTime !== null}
					<span
						class="shrink-0 text-(--gold) [text-shadow:0_0_10px_var(--gold-glow)]"
						data-testid="difficulty-best-time"
						data-difficulty={difficulty}
					>
						◆ {formatTime(bestTime)}
					</span>
				{/if}
			</a>
		{:else}
			<div
				class="flex items-center justify-between gap-3 border border-(--border) bg-(--bg-0) px-3 py-2
				text-[0.65rem] font-(--font-mono) tracking-[0.1em] text-(--text-2) opacity-70"
				data-testid="difficulty-action"
				data-difficulty={difficulty}
			>
				<span class="flex min-w-0 items-center gap-2">
					<span class="font-(--font-display) font-semibold tracking-[0.12em] uppercase">
						{difficultyLabels[difficulty]}
					</span>
					<span>·</span>
					<span>{variant.pieceCount}</span>
				</span>
			</div>
		{/if}
	{/each}
</div>
