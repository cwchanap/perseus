<script lang="ts">
	import type { PuzzleDifficulty, PuzzleFamilySummary } from '@perseus/types';
	import { getFamilyThumbnailUrl } from '$lib/services/api';
	import { getDifficultyLabel } from '$lib/services/gameplay/galleryProgress';
	import CategoryBadge from './CategoryBadge.svelte';
	import DifficultyGems from './DifficultyGems.svelte';
	import PuzzleDifficultyPicker from './PuzzleDifficultyPicker.svelte';

	interface VariantProgress {
		placedCount: number;
		pieceCount: number;
	}

	interface Props {
		family: PuzzleFamilySummary;
		progressByVariantId?: ReadonlyMap<string, VariantProgress>;
		playableLinks?: boolean;
		bookmarked?: boolean;
		bookmarkPending?: boolean;
		highestClearedDifficulty?: PuzzleDifficulty | null;
		onBookmarkToggle?: (family: PuzzleFamilySummary) => void;
	}

	let {
		family,
		progressByVariantId,
		playableLinks = true,
		bookmarked = false,
		bookmarkPending = false,
		highestClearedDifficulty,
		onBookmarkToggle
	}: Props = $props();

	let thumbnailError = $state(false);

	const isReady = $derived(family.status === 'ready');
	const statusLabel = $derived(family.status === 'processing' ? 'PROCESSING…' : 'FAILED');
	const featuredProgress = $derived(
		[family.variants.easy, family.variants.normal, family.variants.hard]
			.map((variant) => progressByVariantId?.get(variant.id))
			.find((progress) => progress !== undefined)
	);
</script>

<article
	class="puzzle-card group relative overflow-hidden rounded-[20px] border border-(--border) bg-(--bg-1)
	[box-shadow:0_10px_26px_rgba(0,0,0,0.45),0_0_0_1px_var(--border)] {isReady ? '' : 'opacity-80'}"
	data-testid="puzzle-card"
>
	<div class="relative aspect-square overflow-hidden bg-(--bg-2)" data-testid="puzzle-card-art">
		{#if !thumbnailError}
			<img
				src={getFamilyThumbnailUrl(family.id)}
				alt={family.name}
				class="absolute inset-0 block h-full w-full object-cover transition-transform duration-300
				group-hover:scale-[1.03]"
				loading="lazy"
				onerror={() => (thumbnailError = true)}
			/>
		{:else}
			<div class="absolute inset-0 flex items-center justify-center text-(--text-2)">
				<span class="text-xs font-(--font-mono) tracking-wider uppercase">No preview</span>
			</div>
		{/if}

		<div
			class="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(10,6,32,0.02)_38%,rgba(10,6,32,0.94)_100%)]"
			aria-hidden="true"
		></div>

		{#if family.category}
			<div
				class="absolute top-3 left-3 flex h-[34px] w-[34px] items-center justify-center rounded-xl
				bg-[rgba(10,6,32,0.72)] backdrop-blur-[6px]"
				data-testid="card-category-status"
			>
				<CategoryBadge category={family.category} compact showLabel={false} />
			</div>
		{/if}

		{#if highestClearedDifficulty || featuredProgress}
			<div
				class="absolute top-3 right-3 flex flex-col items-end gap-1.5"
				data-testid="card-status-stack"
			>
				{#if highestClearedDifficulty}
					<div
						class="flex items-center rounded-[14px] bg-[rgba(10,6,32,0.72)] px-2.5 py-1
						text-(--accent) backdrop-blur-[6px]"
						role="img"
						aria-label={`Highest cleared difficulty: ${getDifficultyLabel(highestClearedDifficulty)}`}
						data-testid="card-cleared-difficulty"
					>
						<span class="flex items-center gap-1" aria-hidden="true">
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="3"
								class="h-3 w-3"
								aria-hidden="true"
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M4 12.5l5 5L20 6.5" />
							</svg>
							<DifficultyGems
								difficulty={highestClearedDifficulty}
								pieceCount={family.variants[highestClearedDifficulty].pieceCount}
								showPieceCount={false}
							/>
						</span>
					</div>
				{/if}
				{#if featuredProgress}
					<span
						class="rounded-[14px] bg-[rgba(10,6,32,0.72)] px-2.5 py-1 text-[0.62rem]
						font-(--font-mono) tracking-[0.08em] text-(--accent)"
						data-testid="card-progress"
					>
						{featuredProgress.placedCount}/{featuredProgress.pieceCount}
					</span>
				{/if}
			</div>
		{/if}

		{#if !isReady}
			<div
				class="pointer-events-none absolute inset-0 flex items-center justify-center bg-[rgba(0,0,0,0.6)]"
				data-testid="card-status-overlay"
			>
				<span
					class="px-4 py-2 text-[0.7rem] font-(--font-display) font-bold tracking-[0.25em] uppercase
					{family.status === 'failed' ? 'text-red-400' : 'text-(--text-1)'}"
				>
					{statusLabel}
				</span>
			</div>
		{/if}

		<div class="absolute right-3 bottom-3 left-3 flex min-w-0 items-center gap-2">
			<h3
				class="min-w-0 flex-1 truncate text-[1.05rem] font-(--font-display) font-black tracking-[0.03em]
				text-(--text-0) [text-shadow:0_2px_10px_rgba(0,0,0,0.7)]"
				data-testid="puzzle-card-title"
			>
				{family.name}
			</h3>
			{#if onBookmarkToggle}
				<button
					type="button"
					class="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-xl
					bg-[rgba(10,6,32,0.72)] backdrop-blur-[6px] transition-colors duration-150
					{bookmarked ? 'text-(--accent)' : 'text-(--text-1)'}
					hover:text-(--accent) disabled:cursor-not-allowed disabled:opacity-60"
					aria-label={bookmarked
						? `Remove bookmark: ${family.name}`
						: `Add bookmark: ${family.name}`}
					aria-pressed={bookmarked}
					disabled={bookmarkPending}
					data-testid="card-bookmark"
					onclick={() => onBookmarkToggle(family)}
				>
					<svg
						viewBox="0 0 24 24"
						fill={bookmarked ? 'currentColor' : 'none'}
						stroke="currentColor"
						stroke-width="2"
						class="h-4 w-4"
						aria-hidden="true"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z"
						/>
					</svg>
				</button>
			{/if}
		</div>
	</div>

	<div class="p-2.5">
		<div class="card-difficulty-picker">
			<PuzzleDifficultyPicker {family} {progressByVariantId} {playableLinks} />
		</div>
	</div>
</article>

<style>
	.card-difficulty-picker :global([data-testid='difficulty-picker']) {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
	}

	.card-difficulty-picker :global([data-testid='difficulty-action']) {
		min-width: 0;
		min-height: 58px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		border-radius: 14px;
		border-color: var(--border-bright);
		background: var(--bg-3);
		padding: 9px 4px;
		text-align: center;
	}

	.card-difficulty-picker :global([data-testid='difficulty-action'] > span:first-child) {
		min-width: 0;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.card-difficulty-picker
		:global([data-testid='difficulty-action'] [data-testid='difficulty-gems']) {
		flex-direction: column;
		gap: 4px;
	}

	.card-difficulty-picker :global([data-testid='difficulty-action'] .difficulty-best-time) {
		font-size: 0.58rem;
		letter-spacing: 0.04em;
	}

	.card-difficulty-picker :global([data-testid='difficulty-action'].difficulty-action-active) {
		border-color: var(--accent);
		background: linear-gradient(160deg, #5affff, #00c2dc);
		box-shadow:
			0 4px 0 #00707f,
			0 8px 18px rgba(0, 240, 255, 0.4);
		color: #03202a;
	}

	.card-difficulty-picker
		:global(
			[data-testid='difficulty-action'].difficulty-action-active [data-testid='difficulty-gems']
		) {
		color: #03202a;
		--gem-foreground: #03202a;
	}

	.card-difficulty-picker :global([data-testid='difficulty-action']:hover) {
		border-color: var(--accent);
		background: var(--bg-3);
		box-shadow: 0 4px 0 #00707f;
	}

	.puzzle-card :global([data-testid='puzzle-card-title']) {
		font-family: var(--font-display);
		font-size: 1.2rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	@media (max-width: 39.999rem) {
		.puzzle-card [data-testid='puzzle-card-art'] {
			aspect-ratio: 343 / 215;
		}
	}

	.card-difficulty-picker :global([data-testid='difficulty-gems']) {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 900;
	}
</style>
