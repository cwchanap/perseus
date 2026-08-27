<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import { formatTime } from '$lib/stores/timer';
	import { fetchFamilyLeaderboard } from '$lib/services/api';
	import type { PuzzleDifficulty, PuzzleLeaderboardResponse } from '@perseus/types';
	import { PUZZLE_DIFFICULTIES } from '@perseus/types';

	interface Props {
		familyId: string;
		familyName: string;
		initialDifficulty?: PuzzleDifficulty;
		initialMode?: 'standard' | 'rotation';
		onDismiss: () => void;
	}

	let {
		familyId,
		familyName,
		initialDifficulty = 'normal',
		initialMode = 'standard',
		onDismiss
	}: Props = $props();

	let difficulty = $state<PuzzleDifficulty>('normal');
	let mode = $state<'standard' | 'rotation'>('standard');

	$effect(() => {
		difficulty = initialDifficulty;
		mode = initialMode;
	});
	let loading = $state(true);
	let error = $state(false);
	let board = $state<PuzzleLeaderboardResponse | null>(null);

	$effect(() => {
		const currentDifficulty = difficulty;
		const currentMode = mode;
		const currentFamilyId = familyId;
		loading = true;
		error = false;
		const controller = new AbortController();
		void fetchFamilyLeaderboard(
			currentFamilyId,
			{ difficulty: currentDifficulty, mode: currentMode },
			controller.signal
		)
			.then((response) => {
				if (controller.signal.aborted) return;
				board = response;
			})
			.catch((err) => {
				if (controller.signal.aborted) return;
				console.error('Failed to load family leaderboard', err);
				error = true;
				board = null;
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});
</script>

<div
	class="modal-backdrop"
	data-testid="family-leaderboard-modal"
	role="presentation"
	onkeydown={(event) => event.key === 'Escape' && onDismiss()}
>
	<div
		class="modal-box"
		role="dialog"
		aria-modal="true"
		aria-labelledby="leaderboard-title"
		use:modalFocus
	>
		<div class="modal-tag">// FAMILY LEADERBOARD</div>
		<h2 id="leaderboard-title" class="modal-title">{familyName.toUpperCase()}</h2>

		<div class="selector-row">
			<label class="selector">
				<span class="selector-label">DIFFICULTY</span>
				<select data-testid="leaderboard-difficulty" bind:value={difficulty}>
					{#each PUZZLE_DIFFICULTIES as option (option)}
						<option value={option}>{option.toUpperCase()}</option>
					{/each}
				</select>
			</label>
			<label class="selector">
				<span class="selector-label">MODE</span>
				<select data-testid="leaderboard-mode" bind:value={mode}>
					<option value="standard">STANDARD</option>
					<option value="rotation">ROTATION</option>
				</select>
			</label>
		</div>

		{#if loading}
			<p class="status" data-testid="leaderboard-loading">Loading…</p>
		{:else if error}
			<p class="status error" data-testid="leaderboard-error">Failed to load leaderboard.</p>
		{:else if board}
			<ul class="board-list" data-testid="leaderboard-entries">
				{#each board.entries as entry (entry.player.id)}
					<li class="board-row">
						<span class="rank">#{entry.rank}</span>
						<span class="name">{entry.player.name}</span>
						<span class="time">{formatTime(entry.bestTimeSeconds)}</span>
					</li>
				{/each}
			</ul>
			{#if board.me && !board.entries.some((entry) => entry.player.id === board?.me?.player.id)}
				<div class="me-row" data-testid="leaderboard-me">
					<span class="rank">#{board.me.rank}</span>
					<span class="name">{board.me.player.name} (you)</span>
					<span class="time">{formatTime(board.me.bestTimeSeconds)}</span>
				</div>
			{/if}
		{/if}

		<div class="modal-actions">
			<button type="button" class="arcade-btn-ghost" onclick={onDismiss}>CLOSE</button>
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(4, 4, 13, 0.9);
		backdrop-filter: blur(6px);
	}

	.modal-box {
		background: var(--bg-1);
		border: 1px solid var(--accent);
		padding: 2rem 1.5rem;
		width: min(28rem, calc(100% - 2rem));
		max-height: calc(100vh - 2rem);
		overflow: auto;
	}

	.modal-tag {
		font-family: var(--font-mono);
		font-size: 0.58rem;
		color: var(--accent);
		letter-spacing: 0.2em;
	}

	.modal-title {
		margin-top: 0.5rem;
		font-family: var(--font-display);
		font-size: 0.8rem;
		letter-spacing: 0.12em;
		color: var(--text-0);
	}

	.selector-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
		margin: 1rem 0;
	}

	.selector {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.selector-label {
		font-family: var(--font-mono);
		font-size: 0.55rem;
		letter-spacing: 0.18em;
		color: var(--text-2);
	}

	select {
		background: var(--bg-2);
		border: 1px solid var(--border);
		color: var(--text-0);
		padding: 0.35rem 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.7rem;
	}

	.status {
		text-align: center;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-2);
		padding: 1rem 0;
	}

	.status.error {
		color: var(--hot, #ff4444);
	}

	.board-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.board-row,
	.me-row {
		display: grid;
		grid-template-columns: 2.5rem 1fr auto;
		gap: 0.5rem;
		align-items: center;
		padding: 0.45rem 0;
		border-bottom: 1px solid var(--border);
		font-family: var(--font-mono);
		font-size: 0.72rem;
	}

	.me-row {
		margin-top: 0.75rem;
		border: 1px solid var(--accent-dim);
		padding: 0.5rem;
		color: var(--accent);
	}

	.rank {
		color: var(--text-2);
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.time {
		color: var(--gold);
	}

	.modal-actions {
		display: flex;
		justify-content: center;
		margin-top: 1rem;
	}
</style>
