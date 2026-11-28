<script lang="ts">
	import type { PuzzleDifficulty } from '@perseus/types';
	import type { PlayerProfile, PlayerProgressionSummary } from '$lib/types/puzzle';
	import { ICONS } from '$lib/constants/icons';
	import DifficultyGems from '$lib/components/DifficultyGems.svelte';
	import ProgressRing from '$lib/components/ProgressRing.svelte';

	interface Props {
		progression: PlayerProgressionSummary | null;
		summary: PlayerProfile['summary'];
	}

	let { progression, summary }: Props = $props();

	const clears = $derived<
		{ difficulty: PuzzleDifficulty; label: string; count: number; color: string }[]
	>([
		{
			difficulty: 'easy',
			label: 'Easy',
			count: progression?.easyClears ?? 0,
			color: 'var(--accent)'
		},
		{
			difficulty: 'normal',
			label: 'Normal',
			count: progression?.normalClears ?? 0,
			color: 'var(--hot)'
		},
		{ difficulty: 'hard', label: 'Hard', count: progression?.hardClears ?? 0, color: 'var(--gold)' }
	]);
	const totalClears = $derived(clears.reduce((sum, row) => sum + row.count, 0));
	const maxClears = $derived(Math.max(1, ...clears.map((row) => row.count)));

	const unlocked = $derived(progression?.achievementsUnlocked ?? 0);
	const achievementsTotal = $derived(progression?.achievementsTotal ?? 9);
	const achievementPercent = $derived(
		achievementsTotal > 0 ? (unlocked / achievementsTotal) * 100 : 0
	);

	const activity = $derived([
		{
			label: 'Uploaded',
			value: summary.puzzlesUploaded,
			icon: ICONS.bolt,
			color: 'var(--accent)',
			testId: 'profile-summary-uploaded'
		},
		{
			label: 'Puzzles solved',
			value: summary.puzzlesSolved,
			icon: ICONS.check,
			color: 'var(--green)',
			testId: 'profile-summary-solved'
		},
		{
			label: 'Total completions',
			value: summary.totalCompletions,
			icon: ICONS.replay,
			color: 'var(--hot)',
			testId: 'profile-summary-completions'
		}
	]);
</script>

<div class="grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-[1.35fr_1fr_1fr]">
	<section class="arcade-panel px-[22px] pt-5 pb-[22px] md:col-span-2 xl:col-span-1">
		<div class="mb-4 flex items-baseline justify-between gap-2.5">
			<h2 class="arcade-panel-title">Clears by difficulty</h2>
			<span class="font-(family-name:--font-mono) text-[0.72rem] tracking-[0.12em] text-(--text-2)">
				{totalClears} TOTAL
			</span>
		</div>
		{#each clears as row (row.difficulty)}
			<div class="clear-row" style={`--row-color: ${row.color}`}>
				<span class="flex" aria-hidden="true"><DifficultyGems difficulty={row.difficulty} /></span>
				<span class="text-base font-semibold text-(--text-1)">{row.label}</span>
				<span class="clear-bar" aria-hidden="true">
					<span style={`width: ${(row.count / maxClears) * 100}%`}></span>
				</span>
				<span class="clear-count" data-testid={`profile-difficulty-${row.difficulty}`}>
					{row.count}
				</span>
			</div>
		{/each}
	</section>

	<section class="arcade-panel px-[22px] pt-5 pb-[22px]">
		<h2 class="arcade-panel-title mb-4">Achievements</h2>
		<div class="flex items-center gap-[18px]">
			<ProgressRing
				percent={achievementPercent}
				size={96}
				accent="gold"
				label={`${unlocked} of ${achievementsTotal} achievements unlocked`}
			>
				<span class="text-[1.3rem]" data-testid="profile-progression-achievements"
					>{unlocked}<small class="text-[0.8rem] text-(--text-2)">/{achievementsTotal}</small></span
				>
			</ProgressRing>
			<div>
				<p class="text-[1.05rem] font-semibold text-(--text-1)">
					{unlocked} of {achievementsTotal} unlocked
				</p>
				<span class="mastery-chip">
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
						><path d={ICONS.star} /></svg
					>
					<span data-testid="profile-mastery-earned">{progression?.masteryEarned ?? 0}</span>
					MASTERY
				</span>
			</div>
		</div>
	</section>

	<section class="arcade-panel px-[22px] pt-5 pb-[22px]">
		<h2 class="arcade-panel-title mb-4">Activity</h2>
		<div class="grid gap-2.5">
			{#each activity as item (item.label)}
				<div class="flex items-center gap-3">
					<span class="activity-icon" style={`color: ${item.color}`} aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="currentColor"><path d={item.icon} /></svg>
					</span>
					<span class="flex-1 text-base font-semibold text-(--text-1)">{item.label}</span>
					<span
						class="font-(family-name:--font-display) text-[1.15rem] font-black"
						data-testid={item.testId}
					>
						{item.value}
					</span>
				</div>
			{/each}
		</div>
	</section>
</div>

<style>
	.clear-row {
		display: grid;
		grid-template-columns: 58px 64px minmax(0, 1fr) 34px;
		align-items: center;
		gap: 10px;
		padding: 7px 0;
	}

	.clear-bar {
		height: 10px;
		overflow: hidden;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
	}

	.clear-bar > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--row-color);
		box-shadow: 0 0 12px var(--row-color);
	}

	.clear-count {
		color: var(--row-color);
		font-family: var(--font-display);
		font-size: 1.15rem;
		font-weight: 900;
		text-align: right;
	}

	.mastery-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
		padding: 6px 12px 6px 8px;
		border: 1px solid rgba(255, 46, 166, 0.42);
		border-radius: 14px;
		background: rgba(255, 46, 166, 0.1);
		color: var(--hot);
		font-family: var(--font-display);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.1em;
	}

	.mastery-chip svg {
		width: 18px;
		height: 18px;
	}

	.activity-icon {
		display: grid;
		width: 34px;
		height: 34px;
		flex: none;
		place-items: center;
		border-radius: 11px;
		background: var(--bg-2);
		box-shadow: 0 0 0 1px var(--border-bright);
	}

	.activity-icon svg {
		width: 17px;
		height: 17px;
	}
</style>
