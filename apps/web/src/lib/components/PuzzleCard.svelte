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
	class="group block overflow-hidden border border-(--border) bg-(--bg-1)
transition-[transform,border-color,box-shadow] duration-200 ease-in-out hover:-translate-y-1
hover:border-(--accent)
hover:[box-shadow:0_0_30px_var(--accent-glow),0_8px_24px_rgba(0,0,0,0.6)]
focus-visible:-translate-y-1 focus-visible:border-(--accent)
focus-visible:[box-shadow:0_0_30px_var(--accent-glow),0_8px_24px_rgba(0,0,0,0.6)]
focus-visible:outline-none"
	data-testid="puzzle-card"
>
	<div class="relative aspect-square overflow-hidden bg-(--bg-2)">
		<img
			src={getThumbnailUrl(puzzle.id)}
			alt={puzzle.name}
			class="block h-full w-full object-cover transition-[transform,filter] duration-[350ms] ease-in-out
group-hover:scale-[1.06] group-hover:brightness-[0.6] group-hover:saturate-[0.8]
group-focus-visible:scale-[1.06] group-focus-visible:brightness-[0.6]
group-focus-visible:saturate-[0.8]"
			loading="lazy"
		/>
		<div
			class="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0
transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
			aria-hidden="true"
			data-testid="card-overlay"
		>
			<span
				class="border border-(--accent) bg-[rgba(0,240,255,0.08)] px-6 py-2 text-[0.85rem]
font-(--font-display) font-bold tracking-[0.3em] text-(--accent)
[box-shadow:0_0_30px_var(--accent-glow)] backdrop-blur-[6px]
[text-shadow:0_0_20px_var(--accent)]"
			>
				▶ PLAY
			</span>
		</div>

		<div
			class="pointer-events-none absolute top-[7px] left-[7px] h-[14px] w-[14px] border-t-2 border-l-2
border-(--accent) opacity-0 transition-opacity duration-200 group-hover:opacity-100
group-focus-visible:opacity-100"
		></div>
		<div
			class="pointer-events-none absolute top-[7px] right-[7px] h-[14px] w-[14px] border-t-2 border-r-2
border-(--accent) opacity-0 transition-opacity duration-200 group-hover:opacity-100
group-focus-visible:opacity-100"
		></div>
		<div
			class="pointer-events-none absolute bottom-[7px] left-[7px] h-[14px] w-[14px]
border-b-2 border-l-2 border-(--accent) opacity-0 transition-opacity duration-200
group-hover:opacity-100 group-focus-visible:opacity-100"
		></div>
		<div
			class="pointer-events-none absolute right-[7px] bottom-[7px] h-[14px] w-[14px]
border-r-2 border-b-2 border-(--accent) opacity-0 transition-opacity duration-200
group-hover:opacity-100 group-focus-visible:opacity-100"
		></div>

		{#if puzzle.category}
			<div class="absolute top-2 left-2">
				<CategoryBadge category={puzzle.category} />
			</div>
		{/if}
	</div>

	<div class="border-t border-(--border) bg-(--bg-1) px-4 pt-3.5 pb-4">
		<h3
			class="truncate text-[0.7rem] font-(--font-display) font-semibold tracking-[0.1em] text-(--text-0) uppercase"
		>
			{puzzle.name}
		</h3>
		<div class="mt-2 flex items-center justify-between gap-4">
			<span
				class="flex items-center gap-1.5 text-[0.65rem] font-(--font-mono) tracking-[0.12em] text-(--text-2)"
			>
				<span
					class="h-[5px] w-[5px] shrink-0 rounded-full bg-(--accent) [box-shadow:0_0_6px_var(--accent)]"
				></span>
				{puzzle.pieceCount} PCS
			</span>
			{#if bestTime !== null}
				<span
					class="text-[0.65rem] font-(--font-mono) tracking-[0.1em] text-(--gold)
[text-shadow:0_0_10px_var(--gold-glow)]"
					data-testid="card-best-time"
				>
					◆ {formatTime(bestTime)}
				</span>
			{/if}
		</div>
	</div>
</a>
