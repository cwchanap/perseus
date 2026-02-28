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

<a
	href={resolve(`/puzzle/${puzzle.id}`)}
	class="group block overflow-hidden rounded-lg bg-white shadow-md transition-all hover:shadow-lg"
	data-testid="puzzle-card"
>
	<div class="relative aspect-square overflow-hidden bg-gray-100">
		<img
			src={getThumbnailUrl(puzzle.id)}
			alt={puzzle.name}
			class="h-full w-full object-cover transition-transform group-hover:scale-105"
			loading="lazy"
		/>
		{#if puzzle.category}
			<div class="absolute top-2 left-2">
				<CategoryBadge category={puzzle.category} />
			</div>
		{/if}
	</div>
	<div class="p-4">
		<h3 class="truncate text-lg font-semibold text-gray-900">{puzzle.name}</h3>
		<div class="mt-1 flex items-center justify-between text-sm text-gray-500">
			<span>{puzzle.pieceCount} pieces</span>
			{#if bestTime !== null}
				<span class="text-amber-600" data-testid="card-best-time">
					🏆 {formatTime(bestTime)}
				</span>
			{/if}
		</div>
	</div>
</a>
