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
</script>

<div
	class="block overflow-hidden border border-(--border) bg-(--bg-1) {isReady ? '' : 'opacity-80'}"
	data-testid="puzzle-card"
>
	<div class="relative aspect-square overflow-hidden bg-(--bg-2)">
		{#if !thumbnailError}
			<img
				src={getFamilyThumbnailUrl(family.id)}
				alt={family.name}
				class="block h-full w-full object-cover"
				loading="lazy"
				onerror={() => (thumbnailError = true)}
			/>
		{:else}
			<div class="flex h-full w-full items-center justify-center text-(--text-2)">
				<span class="text-xs font-(--font-mono) tracking-wider uppercase">No preview</span>
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

		{#if family.category}
			<div class="absolute top-2 left-2">
				<CategoryBadge category={family.category} />
			</div>
		{/if}
	</div>

	<div class="border-t border-(--border) bg-(--bg-1) px-4 pt-3.5 pb-4">
		<h3
			class="truncate text-[0.7rem] font-(--font-display) font-semibold tracking-[0.1em] text-(--text-0) uppercase"
		>
			{family.name}
		</h3>
		<div class="mt-3">
			<PuzzleDifficultyPicker {family} {progressByVariantId} {playableLinks} />
		</div>
	</div>
</div>
