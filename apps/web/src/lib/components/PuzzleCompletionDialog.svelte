<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import { formatTime } from '$lib/stores/timer';
	import type { ResultClass } from '@perseus/types';
	import type { CompletionAwards } from '$lib/types/puzzle';

	const ACHIEVEMENT_LABELS: Record<string, string> = {
		first_clear: 'First Clear',
		getting_started: 'Getting Started',
		puzzle_regular: 'Puzzle Regular',
		full_set: 'Full Set',
		hard_mode: 'Hard Mode',
		hard_veteran: 'Hard Veteran',
		hintless: 'Hintless',
		flawless: 'Flawless',
		rotation_clear: 'Rotation Clear'
	};

	const MASTERY_LABELS: Record<string, string> = {
		hintless: 'Hintless',
		flawless: 'Flawless',
		rotation_clear: 'Rotation Clear'
	};

	const RESULT_LABELS: Record<ResultClass, string> = {
		standard_timed: 'STANDARD TIMED',
		rotation_timed: 'ROTATION TIMED',
		assisted_timed: 'ASSISTED TIMED',
		relaxed: 'RELAXED'
	};

	interface Props {
		puzzleName: string;
		resultClass: ResultClass;
		elapsedSeconds: number | null;
		pieceCount: number;
		hintsUsed: number;
		incorrectAttempts: number;
		rotationEnabled: boolean;
		rotationUsed: boolean;
		bestTime: number | null;
		isNewBest: boolean;
		localStatsFailed: boolean;
		serverSubmissionRetryable: boolean;
		awards?: CompletionAwards;
		onRetryServerSubmission: () => void;
		onPlayAgain: () => void;
		onBackToArcade: () => void;
		onDismiss: () => void;
	}

	let {
		puzzleName,
		resultClass,
		elapsedSeconds,
		pieceCount,
		hintsUsed,
		incorrectAttempts,
		rotationEnabled,
		rotationUsed,
		bestTime,
		isNewBest,
		localStatsFailed,
		serverSubmissionRetryable,
		awards,
		onRetryServerSubmission,
		onPlayAgain,
		onBackToArcade,
		onDismiss
	}: Props = $props();

	const resultLabel = $derived(RESULT_LABELS[resultClass]);
	const timedResult = $derived(resultClass !== 'relaxed');
	const standardTimedResult = $derived(resultClass === 'standard_timed');
	const displayedBestTime = $derived(bestTime ?? (isNewBest ? elapsedSeconds : null));
	const rotationSummary = $derived(
		`${rotationEnabled ? 'ON' : 'OFF'} · ${rotationUsed ? 'USED' : 'NOT USED'}`
	);
</script>

<div
	class="modal-backdrop"
	data-testid="celebration-modal"
	role="presentation"
	onkeydown={(event) => event.key === 'Escape' && onDismiss()}
>
	<div
		class="modal-box"
		role="dialog"
		aria-modal="true"
		aria-labelledby="modal-title"
		use:modalFocus
	>
		<div class="modal-scan-line"></div>
		<div class="modal-top-line"></div>

		<div class="modal-tag">// MISSION COMPLETE</div>
		<div class="modal-result" data-testid="completion-result-label">{resultLabel}</div>

		<h2 id="modal-title" class="modal-title">{puzzleName.toUpperCase()}</h2>

		<div class="modal-stats">
			{#if timedResult && elapsedSeconds !== null}
				<div class="modal-stat">
					<span class="mstat-label">FINAL TIME</span>
					<span class="mstat-value" data-testid="completion-final-time">
						{formatTime(elapsedSeconds)}
					</span>
				</div>
			{/if}

			{#if standardTimedResult && displayedBestTime !== null}
				<div class="modal-stat">
					<span class="mstat-label">PERSONAL BEST</span>
					<span class="mstat-value" class:gold={isNewBest} data-testid="completion-best-time">
						{formatTime(displayedBestTime)}
					</span>
					{#if isNewBest}
						{#if localStatsFailed}
							<span class="new-record-badge unsaved" data-testid="new-best-unsaved">UNSAVED</span>
						{:else}
							<span class="new-record-badge">NEW RECORD</span>
						{/if}
					{/if}
				</div>
			{/if}
		</div>

		<div class="completion-summary" data-testid="completion-run-summary">
			<div class="summary-item">
				<span class="mstat-label">PIECES</span>
				<span class="summary-value" data-testid="completion-piece-count">{pieceCount}</span>
			</div>
			<div class="summary-item">
				<span class="mstat-label">HINTS USED</span>
				<span class="summary-value" data-testid="completion-hints-used">{hintsUsed}</span>
			</div>
			<div class="summary-item">
				<span class="mstat-label">INCORRECT ATTEMPTS</span>
				<span class="summary-value" data-testid="completion-incorrect-attempts">
					{incorrectAttempts}
				</span>
			</div>
			<div class="summary-item">
				<span class="mstat-label">ROTATION</span>
				<span class="summary-value" data-testid="completion-rotation">{rotationSummary}</span>
			</div>
		</div>

		{#if awards?.clearPoints}
			<div class="award-banner" data-testid="completion-clear-points">
				+{awards.clearPoints} SCORE
			</div>
		{/if}

		{#if awards?.achievements?.length}
			<div class="award-section" data-testid="completion-achievements">
				<div class="award-heading">NEW ACHIEVEMENTS</div>
				<ul class="award-list">
					{#each awards.achievements as achievement (achievement)}
						<li>{ACHIEVEMENT_LABELS[achievement] ?? achievement}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if awards?.mastery?.length}
			<div class="award-section" data-testid="completion-mastery">
				<div class="award-heading">MASTERY EARNED</div>
				<ul class="award-list">
					{#each awards.mastery as badge (badge)}
						<li>{MASTERY_LABELS[badge] ?? badge}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if awards?.puzzleRank}
			<div class="award-banner" data-testid="completion-puzzle-rank">
				FAMILY RANK #{awards.puzzleRank}
			</div>
		{/if}

		<div class="modal-bottom-line"></div>

		{#if serverSubmissionRetryable}
			<div class="modal-server-retry" role="alert" data-testid="server-retry-banner">
				<span class="server-retry-label">MISSION SYNC FAILED</span>
				<button
					onclick={onRetryServerSubmission}
					class="arcade-btn-ghost"
					data-testid="retry-server-submission"
				>
					RETRY SYNC
				</button>
			</div>
		{/if}

		<div class="modal-actions">
			<button onclick={onPlayAgain} class="arcade-btn">PLAY AGAIN</button>
			<button onclick={onBackToArcade} class="arcade-btn-ghost">BACK TO ARCADE</button>
		</div>
	</div>
</div>

<style>
	/* ===== CELEBRATION MODAL ===== */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(4, 4, 13, 0.9);
		backdrop-filter: blur(6px);
	}

	.modal-box {
		position: relative;
		background: var(--bg-1);
		border: 1px solid var(--accent);
		padding: 2.5rem 2rem;
		text-align: center;
		max-width: 24rem;
		width: calc(100% - 2rem);
		box-shadow:
			0 0 60px var(--accent-glow-strong),
			0 0 120px var(--accent-glow),
			inset 0 0 60px rgba(0, 240, 255, 0.03);
		animation: celebration-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
		overflow: hidden;
	}

	/* Animated scan line inside modal */
	.modal-scan-line {
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		background: linear-gradient(90deg, transparent, var(--accent-dim), transparent);
		animation: scan 2s linear infinite;
		pointer-events: none;
	}

	@keyframes scan {
		0% {
			top: -2px;
		}
		100% {
			top: calc(100% + 2px);
		}
	}

	.modal-top-line,
	.modal-bottom-line {
		height: 1px;
		background: linear-gradient(90deg, transparent, var(--accent), transparent);
		opacity: 0.4;
		margin: 0.75rem 0;
	}

	.modal-tag {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		opacity: 0.7;
		margin-bottom: 0.5rem;
	}

	.modal-result {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 900;
		color: var(--accent);
		text-shadow:
			0 0 30px var(--accent),
			0 0 60px var(--accent-glow-strong);
		letter-spacing: 0.2em;
		line-height: 1;
		animation: neon-flicker 4s ease-in-out infinite;
	}

	.modal-title {
		font-family: var(--font-display);
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		color: var(--text-1);
		margin-top: 0.5rem;
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	.modal-stats {
		margin: 1.25rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.modal-stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
	}

	.mstat-label {
		font-family: var(--font-mono);
		font-size: 0.58rem;
		letter-spacing: 0.25em;
		color: var(--text-2);
	}

	.mstat-value {
		font-family: var(--font-mono);
		font-size: 1.5rem;
		letter-spacing: 0.1em;
		color: var(--text-0);
	}

	.mstat-value.gold {
		color: var(--gold);
		text-shadow: 0 0 15px var(--gold-glow);
	}

	.completion-summary {
		margin: 1.25rem 0 0;
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.875rem 0.75rem;
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}

	.summary-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
	}

	.summary-value {
		font-family: var(--font-mono);
		font-size: 1rem;
		letter-spacing: 0.1em;
		color: var(--text-0);
	}

	.award-banner {
		margin-top: 0.75rem;
		font-family: var(--font-display);
		font-size: 0.7rem;
		letter-spacing: 0.18em;
		color: var(--gold);
	}

	.award-section {
		margin-top: 0.75rem;
		text-align: left;
	}

	.award-heading {
		font-family: var(--font-mono);
		font-size: 0.55rem;
		letter-spacing: 0.2em;
		color: var(--text-2);
		margin-bottom: 0.35rem;
	}

	.award-list {
		margin: 0;
		padding-left: 1rem;
		font-family: var(--font-mono);
		font-size: 0.68rem;
		color: var(--text-1);
	}

	.new-record-badge {
		font-family: var(--font-display);
		font-size: 0.55rem;
		font-weight: 700;
		letter-spacing: 0.25em;
		color: var(--gold);
		border: 1px solid var(--gold-dim);
		padding: 0.15rem 0.625rem;
		text-shadow: 0 0 8px var(--gold);
		box-shadow: 0 0 15px var(--gold-glow);
	}

	.new-record-badge.unsaved {
		color: var(--hot, #ff4444);
		border-color: var(--hot-dim, rgba(255, 68, 68, 0.4));
		text-shadow: 0 0 8px var(--hot-glow, rgba(255, 68, 68, 0.5));
		box-shadow: 0 0 12px var(--hot-glow, rgba(255, 68, 68, 0.3));
	}

	.modal-actions {
		display: flex;
		justify-content: center;
		gap: 0.875rem;
		flex-wrap: wrap;
		padding-top: 0.5rem;
	}

	.modal-server-retry {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0 0.25rem;
	}

	.server-retry-label {
		color: var(--accent-warn, #ffb86b);
		font-size: 0.7rem;
		letter-spacing: 0.12em;
	}

	@media (prefers-reduced-motion: reduce) {
		.modal-scan-line,
		.modal-box,
		.modal-result {
			animation: none;
		}

		.arcade-btn:hover {
			box-shadow: none;
			text-shadow: none;
		}
	}
</style>
