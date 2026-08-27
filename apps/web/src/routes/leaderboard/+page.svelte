<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchOverallLeaderboard } from '$lib/services/api';
	import type { OverallLeaderboardResponse } from '@perseus/types';

	let board = $state<OverallLeaderboardResponse | null>(null);
	let loading = $state(true);
	let loadError = $state(false);

	onMount(() => {
		const controller = new AbortController();
		void fetchOverallLeaderboard(controller.signal)
			.then((response) => {
				if (controller.signal.aborted) return;
				board = response;
			})
			.catch((error) => {
				if (controller.signal.aborted) return;
				console.error('Failed to load overall leaderboard', error);
				loadError = true;
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});
</script>

<section class="mx-auto max-w-3xl px-4 py-8">
	<h1 class="font-(--font-display) text-(--text-0)" data-testid="leaderboard-title">
		Overall Leaderboard
	</h1>
	<p class="mt-1 text-sm text-(--text-2)">
		Score = 100×Easy + 200×Normal + 300×Hard + achievement points
	</p>

	{#if loading}
		<p class="mt-6 text-sm text-(--text-2)" data-testid="leaderboard-loading">Loading…</p>
	{:else if loadError}
		<p class="mt-6 text-sm text-(--hot)" data-testid="leaderboard-error">
			Failed to load leaderboard.
		</p>
	{:else if board}
		<div class="mt-6 overflow-x-auto border border-(--border) bg-(--bg-1)">
			<table class="w-full text-left text-sm" data-testid="overall-leaderboard-table">
				<thead class="border-b border-(--border) text-xs tracking-wider text-(--text-2) uppercase">
					<tr>
						<th class="px-3 py-2">Rank</th>
						<th class="px-3 py-2">Player</th>
						<th class="px-3 py-2">Score</th>
						<th class="px-3 py-2">E</th>
						<th class="px-3 py-2">N</th>
						<th class="px-3 py-2">H</th>
					</tr>
				</thead>
				<tbody>
					{#each board.entries as entry (entry.player.id)}
						<tr class="border-b border-(--border) last:border-b-0">
							<td class="px-3 py-2 font-(--font-mono)">#{entry.rank}</td>
							<td class="px-3 py-2">{entry.player.name}</td>
							<td class="px-3 py-2 font-(--font-mono) text-(--accent)">{entry.score}</td>
							<td class="px-3 py-2 font-(--font-mono)">{entry.easyClears}</td>
							<td class="px-3 py-2 font-(--font-mono)">{entry.normalClears}</td>
							<td class="px-3 py-2 font-(--font-mono)">{entry.hardClears}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if board.me && !board.entries.some((entry) => entry.player.id === board?.me?.player.id)}
			<div
				class="mt-3 grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-3 border border-(--accent-dim) bg-(--bg-1) px-3 py-2 text-sm"
				data-testid="overall-leaderboard-me"
			>
				<span class="font-(--font-mono)">#{board.me.rank}</span>
				<span>{board.me.player.name} (you)</span>
				<span class="font-(--font-mono) text-(--accent)">{board.me.score}</span>
				<span class="font-(--font-mono)">{board.me.easyClears}</span>
				<span class="font-(--font-mono)">{board.me.normalClears}</span>
				<span class="font-(--font-mono)">{board.me.hardClears}</span>
			</div>
		{/if}
	{/if}
</section>
