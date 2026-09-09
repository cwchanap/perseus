<script lang="ts">
	import type { PuzzleFamilySummary } from '@perseus/types';
	import { getFamilyThumbnailUrl } from '$lib/services/api';
	import CategoryBadge from './CategoryBadge.svelte';
	import PuzzleDifficultyPicker from './PuzzleDifficultyPicker.svelte';

	interface VariantProgress {
		placedCount: number;
		pieceCount: number;
	}

	interface Props {
		family: PuzzleFamilySummary;
		progressByVariantId?: ReadonlyMap<string, VariantProgress>;
		playableLinks?: boolean;
	}

	let { family, progressByVariantId, playableLinks = true }: Props = $props();

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
			>
				<CategoryBadge category={family.category} compact showLabel={false} />
			</div>
		{/if}

		{#if featuredProgress}
			<span
				class="absolute top-3 right-3 rounded-[14px] bg-[rgba(10,6,32,0.72)] px-2.5 py-1
				text-[0.62rem] font-(--font-mono) tracking-[0.08em] text-(--accent)"
				data-testid="card-progress"
			>
				{featuredProgress.placedCount}/{featuredProgress.pieceCount}
			</span>
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

		<div class="absolute right-3 bottom-3 left-3 min-w-0">
			<h3
				class="truncate text-[1.05rem] font-(--font-display) font-black tracking-[0.03em] text-(--text-0)
				[text-shadow:0_2px_10px_rgba(0,0,0,0.7)]"
				data-testid="puzzle-card-title"
			>
				{family.name}
			</h3>
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

	.card-difficulty-picker :global([data-testid='difficulty-gems']) {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 900;
	}
</style>
