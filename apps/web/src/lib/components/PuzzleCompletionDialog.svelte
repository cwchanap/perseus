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
		referenceImageUrl: string | null;
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
		referenceImageUrl,
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
	const competitiveTimedResult = $derived(
		resultClass === 'standard_timed' || resultClass === 'rotation_timed'
	);
	const completionStarCount = $derived(
		resultClass === 'relaxed'
			? 1
			: competitiveTimedResult && hintsUsed === 0 && incorrectAttempts === 0
				? 3
				: 2
	);
	const standardTimedResult = $derived(resultClass === 'standard_timed');
	const serverPersonalBest = $derived(awards?.personalBest);
	const displayedBestTime = $derived(
		serverPersonalBest?.bestTimeSeconds ??
			(standardTimedResult ? (bestTime ?? (isNewBest ? elapsedSeconds : null)) : null)
	);
	const displayedIsNewBest = $derived(
		serverPersonalBest?.isNew ?? (standardTimedResult && isNewBest)
	);
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
		<div class="completion-layout">
			<div class="completion-art-column">
				{#if referenceImageUrl}
					<img
						class="completion-reference-art"
						data-testid="completion-reference-art"
						src={referenceImageUrl}
						alt={`${puzzleName} finished artwork`}
					/>
				{:else}
					<div
						class="completion-reference-fallback"
						data-testid="completion-reference-fallback"
						role="img"
						aria-label="Finished artwork unavailable"
					>
						<span>FINISHED ART</span>
						<strong>REFERENCE UNAVAILABLE</strong>
					</div>
				{/if}
			</div>

			<div class="completion-result-column">
				<div
					class="completion-stars"
					role="img"
					aria-label={`${completionStarCount} stars awarded`}
				>
					{#each Array.from({ length: completionStarCount }) as _, index (index)}
						<svg
							class="completion-star"
							data-testid="completion-star"
							viewBox="0 0 24 24"
							aria-hidden="true"
							style={`--star-size: ${index === 1 && completionStarCount === 3 ? '5.5rem' : '4rem'}`}
						>
							<path
								d="M12 2l2.9 6.3 6.9.8-5 4.7 1.3 6.8L12 17.4 5.9 20.6 7.2 13.8l-5-4.7 6.9-.8z"
							/>
						</svg>
					{/each}
				</div>

				<div class="completion-result-content">
					<div class="completion-identity">
						<div class="modal-tag">// MISSION COMPLETE</div>
						<div class="modal-result" data-testid="completion-result-label">{resultLabel}</div>
						<h2 id="modal-title" class="modal-title">{puzzleName.toUpperCase()}</h2>
					</div>

					<div class="modal-stats">
						{#if timedResult && elapsedSeconds !== null}
							<div class="modal-stat modal-stat-primary">
								<span class="mstat-label">FINAL TIME</span>
								<span class="mstat-value" data-testid="completion-final-time">
									{formatTime(elapsedSeconds)}
								</span>
							</div>
						{/if}

						{#if competitiveTimedResult && displayedBestTime !== null}
							<div class="modal-stat modal-stat-best">
								<svg class="record-icon" viewBox="0 0 24 24" aria-hidden="true">
									<path
										d="M7 3h10v3a5 5 0 0 1-3 4.58V14h3v3H7v-3h3v-3.42A5 5 0 0 1 7 6V3Zm-3 1h3v2H4V4Zm13 0h3v2h-3V4Z"
									/>
								</svg>
								<span class="mstat-label">RECORD</span>
								<span
									class="mstat-value"
									class:gold={displayedIsNewBest}
									class:record-new={displayedIsNewBest}
									data-testid="completion-best-time"
								>
									{formatTime(displayedBestTime)}
								</span>
								{#if displayedIsNewBest}
									{#if localStatsFailed && !serverPersonalBest}
										<span class="new-record-badge unsaved" data-testid="new-best-unsaved"
											>UNSAVED</span
										>
									{:else}
										<span class="new-record-badge">NEW RECORD</span>
									{/if}
								{/if}
							</div>
						{/if}
					</div>

					<div class="completion-summary" data-testid="completion-run-summary">
						<div class="summary-item">
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M5 5h14v14H5zM8 8h3v3H8zm5 0h3v3h-3zM8 13h3v3H8zm5 0h3v3h-3z" />
							</svg>
							<span class="mstat-label">PIECES</span>
							<span class="summary-value" data-testid="completion-piece-count">{pieceCount}</span>
						</div>
						<div class="summary-item">
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12 3a7 7 0 0 0-4 12.74V19h8v-3.26A7 7 0 0 0 12 3Zm-2 18h4v-1h-4v1Z" />
							</svg>
							<span class="mstat-label">HINTS USED</span>
							<span class="summary-value" data-testid="completion-hints-used">{hintsUsed}</span>
						</div>
						<div class="summary-item">
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Zm1 0v7h7v2h-9V3h2Z" />
							</svg>
							<span class="mstat-label">INCORRECT ATTEMPTS</span>
							<span class="summary-value" data-testid="completion-incorrect-attempts">
								{incorrectAttempts}
							</span>
						</div>
						<div class="summary-item">
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path
									d="M6 7h10.17l-1.58-1.59L16 4l4 4-4 4-1.41-1.41L16.17 9H6V7Zm12 10H7.83l1.58 1.59L8 20l-4-4 4-4 1.41 1.41L7.83 15H18v2Z"
								/>
							</svg>
							<span class="mstat-label">ROTATION</span>
							<span class="summary-value rotation-value">
								<span aria-hidden="true">{rotationEnabled ? 'ON' : 'OFF'}</span>
								<span class="rotation-summary-full" data-testid="completion-rotation"
									>{rotationSummary}</span
								>
							</span>
						</div>
					</div>

					<div class="modal-actions">
						<button onclick={onPlayAgain} class="arcade-btn">PLAY AGAIN</button>
						<button onclick={onBackToArcade} class="arcade-btn-ghost">BACK TO ARCADE</button>
					</div>

					<div class="completion-awards">
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
					</div>

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
				</div>
			</div>
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
		padding: clamp(1.25rem, 3vw, 3.5rem);
		width: min(calc(100% - 2rem), 84rem);
		max-height: calc(100vh - 2rem);
		box-shadow:
			0 0 60px var(--accent-glow-strong),
			0 0 120px var(--accent-glow),
			inset 0 0 60px rgba(0, 240, 255, 0.03);
		animation: celebration-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
		overflow-x: hidden;
		overflow-y: auto;
	}

	.completion-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: center;
		gap: 1.5rem;
		max-width: 1120px;
		margin: 0 auto;
	}

	.completion-art-column {
		display: flex;
		justify-content: center;
		min-width: 0;
	}

	.completion-reference-art,
	.completion-reference-fallback {
		width: min(100%, 230px);
		aspect-ratio: 3 / 4;
		border-radius: 1.25rem;
		box-shadow:
			0 0 0 3px rgba(255, 204, 0, 0.6),
			0 0 46px rgba(255, 204, 0, 0.35),
			0 16px 40px rgba(0, 0, 0, 0.55);
	}

	.completion-reference-art {
		display: block;
		background: var(--bg-2);
		object-fit: cover;
	}

	.completion-reference-fallback {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 1.5rem;
		box-sizing: border-box;
		background:
			radial-gradient(circle at 50% 30%, var(--accent-glow-strong), transparent 48%), var(--bg-2);
		border: 1px dashed var(--gold-dim);
		color: var(--gold);
		font-family: var(--font-display);
		font-size: 0.65rem;
		letter-spacing: 0.14em;
		text-align: center;
	}

	.completion-reference-fallback strong {
		color: var(--text-1);
		font-size: 0.55rem;
		font-weight: 600;
		letter-spacing: 0.12em;
	}

	.completion-result-column {
		min-width: 0;
		text-align: center;
	}

	.completion-stars {
		display: flex;
		align-items: flex-end;
		justify-content: center;
		gap: 0.5rem;
		min-height: 4rem;
		margin: 1rem 0 0.5rem;
		color: var(--gold);
		filter: drop-shadow(0 0 14px var(--gold-glow));
	}

	.completion-star {
		width: var(--star-size);
		height: var(--star-size);
		fill: currentColor;
		flex: 0 0 auto;
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
		font-size: clamp(1.2rem, 3vw, 2rem);
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
		margin: 0.5rem 0 0;
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	.modal-stats {
		margin: 1.25rem 0 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.modal-stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
	}

	.modal-stat-primary .mstat-value {
		font-size: clamp(3rem, 8vw, 6.5rem);
		line-height: 0.95;
		letter-spacing: 0.01em;
		text-shadow: 0 0 34px var(--accent-glow-strong);
	}

	.modal-stat-best {
		padding: 0.65rem 1rem;
		border-radius: 1rem;
		background: linear-gradient(160deg, #ffe06b, #ffbb00);
		box-shadow:
			0 4px 0 #a37500,
			0 8px 22px rgba(255, 204, 0, 0.35);
	}

	.modal-stat-best .mstat-label,
	.modal-stat-best .mstat-value {
		color: #3a2600;
	}

	.modal-stat-best .mstat-value.gold {
		color: #3a2600;
		text-shadow: none;
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
		margin: 1.5rem 0 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.summary-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
		min-width: 0;
		padding: 0.75rem 0.35rem;
		border: 1px solid var(--border);
		border-radius: 1rem;
		background: var(--bg-2);
	}

	.summary-value {
		font-family: var(--font-mono);
		font-size: clamp(0.8rem, 2vw, 1.3rem);
		letter-spacing: 0.1em;
		color: var(--text-0);
	}

	.completion-awards {
		max-height: min(16rem, 30vh);
		margin-top: 1rem;
		overflow-y: auto;
		padding-right: 0.35rem;
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
		color: #3a2600;
		border: 1px solid rgba(58, 38, 0, 0.55);
		padding: 0.15rem 0.625rem;
		text-shadow: none;
		box-shadow: 0 0 15px rgba(58, 38, 0, 0.2);
	}

	.new-record-badge.unsaved {
		color: #720032;
		border-color: rgba(114, 0, 50, 0.55);
		text-shadow: none;
		box-shadow: 0 0 12px rgba(114, 0, 50, 0.2);
	}

	.modal-actions {
		display: flex;
		justify-content: center;
		gap: 0.875rem;
		flex-wrap: wrap;
		padding-top: 0.75rem;
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

	@media (min-width: 900px) {
		.modal-box {
			width: min(calc(100% - 2rem), 84rem);
			padding: 1.5rem;
		}

		.completion-layout {
			grid-template-columns: minmax(0, 396px) minmax(0, 560px);
			gap: clamp(2rem, 4vw, 2.75rem);
		}

		.completion-reference-art,
		.completion-reference-fallback {
			width: 396px;
		}

		.completion-result-column {
			text-align: left;
		}

		.completion-stars,
		.modal-stats {
			justify-content: flex-start;
		}

		.completion-star:nth-child(2) {
			margin-bottom: 0.75rem;
		}

		.modal-actions {
			justify-content: flex-start;
		}
	}

	@media (min-width: 1440px) {
		.modal-box {
			width: min(calc(100% - 4rem), 84rem);
			padding: 3rem 4rem;
		}

		.completion-layout {
			grid-template-columns: minmax(0, 504px) minmax(0, 560px);
			gap: 3.5rem;
		}

		.completion-reference-art,
		.completion-reference-fallback {
			width: 504px;
		}
	}

	@media (max-width: 639px) {
		.modal-box {
			padding: 1.25rem 1rem;
		}

		.modal-stats {
			flex-direction: column;
		}

		.modal-stat-primary .mstat-value {
			font-size: clamp(3.25rem, 16vw, 4.5rem);
		}

		.modal-actions > button {
			flex: 1 1 10rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.modal-box,
		.modal-result {
			animation: none;
		}

		.arcade-btn:hover {
			box-shadow: none;
			text-shadow: none;
		}
	}

	/* ===== RESULTS PRESENTATION ===== */
	.modal-backdrop {
		background:
			radial-gradient(circle at 50% 34%, rgba(255, 197, 64, 0.16), transparent 30rem),
			radial-gradient(circle at 50% 100%, rgba(255, 143, 48, 0.14), transparent 38rem),
			rgba(8, 6, 24, 0.94);
	}

	.modal-box {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		max-height: 100vh;
		padding: 1rem;
		background:
			radial-gradient(circle at 50% 74%, rgba(255, 197, 64, 0.1), transparent 25rem), transparent;
		border: 0;
		box-shadow: none;
		animation: celebration-in 0.35s ease-out;
	}

	.completion-layout {
		box-sizing: border-box;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto auto minmax(0, 1fr);
		align-items: stretch;
		gap: 0.75rem;
		width: 100%;
		max-width: 1128px;
		height: 100%;
		min-height: 100%;
	}

	.completion-art-column {
		grid-row: 2;
		align-items: flex-start;
	}

	.completion-reference-art,
	.completion-reference-fallback {
		width: min(100%, 235px);
		border-radius: 1.2rem;
		box-shadow:
			0 0 0 2px rgba(255, 204, 0, 0.7),
			0 0 35px rgba(255, 178, 58, 0.3),
			0 14px 32px rgba(0, 0, 0, 0.5);
	}

	.completion-result-column {
		display: contents;
	}

	.completion-stars {
		grid-row: 1;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 4.5rem;
		margin: 0;
	}

	.completion-star {
		width: min(var(--star-size), 4.75rem);
		height: min(var(--star-size), 4.75rem);
	}

	.completion-result-content {
		grid-row: 3;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		text-align: center;
	}

	.completion-identity {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.modal-stats {
		justify-content: center;
		gap: 0.75rem;
		margin: 0.2rem 0 0;
	}

	.modal-stat-primary .mstat-value {
		font-family: var(--font-display);
		font-size: clamp(3.5rem, 16vw, 5.75rem);
		font-weight: 900;
		line-height: 0.95;
		letter-spacing: 0.01em;
		color: var(--text-0);
		text-shadow: 0 0 30px var(--accent-glow-strong);
	}

	.modal-stat-best {
		flex-direction: row;
		align-items: center;
		gap: 0.35rem;
		padding: 0.5rem 0.8rem;
		border-radius: 999px;
		background: linear-gradient(145deg, #ffe873, #ffc51c);
		box-shadow:
			0 3px 0 #9a6c00,
			0 8px 20px rgba(255, 204, 0, 0.3);
	}

	.record-icon {
		width: 1rem;
		height: 1rem;
		fill: #3a2600;
		flex: 0 0 auto;
	}

	.modal-stat-best .mstat-label,
	.modal-stat-best .mstat-value,
	.modal-stat-best .mstat-value.gold {
		font-family: var(--font-display);
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		color: #3a2600;
		text-shadow: none;
	}

	.new-record-badge {
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		font-size: 0.48rem;
		letter-spacing: 0.12em;
		box-shadow: none;
	}

	.completion-summary {
		margin: 1.15rem 0 0;
		gap: 0.5rem;
		width: min(100%, 400px);
	}

	.summary-item {
		box-sizing: border-box;
		height: 4.65rem;
		justify-content: center;
		gap: 0.25rem;
		padding: 0.45rem 0.25rem;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 1rem;
		background: rgba(30, 20, 63, 0.78);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}

	.summary-item > svg {
		width: 1.25rem;
		height: 1.25rem;
		fill: var(--accent);
		filter: drop-shadow(0 0 7px var(--accent-glow));
	}

	.summary-item .mstat-label {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.summary-value {
		font-family: var(--font-display);
		font-size: clamp(0.9rem, 3vw, 1.3rem);
		font-weight: 800;
		letter-spacing: 0.06em;
		color: var(--text-0);
	}

	.modal-actions {
		justify-content: center;
		gap: 0.65rem;
		margin-top: auto;
		padding-top: 1.1rem;
	}

	.modal-actions > button {
		min-height: 3.875rem;
		padding: 0.75rem 1rem;
	}

	.completion-awards {
		max-height: min(16rem, 30vh);
		margin-top: 0.85rem;
		padding-right: 0.35rem;
	}

	.modal-server-retry {
		margin-top: 0.75rem;
		padding: 0.5rem 0 0.25rem;
	}

	@media (min-width: 900px) {
		.modal-box {
			padding: 0;
		}

		.completion-layout {
			grid-template-columns: minmax(0, 396px) minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr);
			align-items: center;
			gap: 3rem;
			width: min(100%, 972px);
			height: auto;
			min-height: 0;
		}

		.completion-art-column {
			grid-row: auto;
		}

		.completion-reference-art,
		.completion-reference-fallback {
			width: 396px;
		}

		.completion-result-column {
			display: flex;
			flex-direction: column;
			justify-content: center;
			min-height: 0;
		}

		.completion-stars,
		.modal-stats {
			justify-content: flex-start;
		}

		.completion-stars {
			grid-row: auto;
			min-height: 4.5rem;
		}

		.completion-result-content {
			grid-row: auto;
			text-align: left;
		}

		.completion-summary {
			margin-top: 1.5rem;
		}

		.modal-actions {
			justify-content: flex-start;
			margin-top: 2rem;
		}
	}

	@media (min-width: 1440px) {
		.completion-layout {
			grid-template-columns: minmax(0, 512px) minmax(0, 1fr);
			gap: 3.25rem;
			width: min(100%, 1128px);
		}

		.completion-reference-art,
		.completion-reference-fallback {
			width: 512px;
		}
	}

	@media (max-width: 639px) {
		.modal-box {
			padding: 0.5rem 1.25rem 1.25rem;
		}

		.completion-layout {
			gap: 0.65rem;
		}

		.completion-art-column {
			align-items: flex-start;
		}

		.completion-stars {
			min-height: 4.25rem;
		}

		.completion-result-content {
			text-align: center;
		}

		.modal-stats {
			flex-direction: column;
			align-items: center;
			gap: 0.55rem;
			margin-top: 0;
		}

		.modal-stat-best {
			padding: 0.45rem 0.75rem;
		}

		.completion-summary {
			margin-top: 1rem;
			width: 100%;
		}

		.modal-actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.6rem;
			margin-top: auto;
		}

		.modal-actions > button {
			width: 100%;
			min-width: 0;
			padding: 0.65rem 0.5rem;
		}

		.rotation-value {
			font-size: 0.72rem;
			letter-spacing: 0.04em;
		}
	}

	@media (min-width: 900px) {
		.modal-box {
			display: flex;
			flex-direction: column;
			justify-content: center;
		}

		.completion-layout {
			margin: 0 auto;
		}

		.completion-result-column {
			justify-content: center;
		}

		.modal-stats {
			flex-direction: column;
			align-items: flex-start;
			gap: 1rem;
			margin-top: 0.65rem;
		}

		.completion-summary {
			margin-top: 1.7rem;
		}

		.summary-item {
			height: 5.9rem;
		}

		.modal-actions {
			margin-top: 2.4rem;
		}
	}

	.rotation-summary-full {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.record-new {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (max-width: 639px) {
		.modal-stat-best {
			gap: 0.2rem;
			padding: 0.4rem 0.65rem;
		}

		.record-icon {
			width: 0.85rem;
			height: 0.85rem;
		}

		.modal-stat-best .mstat-label,
		.modal-stat-best .mstat-value,
		.modal-stat-best .mstat-value.gold {
			font-size: 0.58rem;
			letter-spacing: 0.04em;
		}

		.new-record-badge {
			padding: 0.08rem 0.3rem;
			font-size: 0.4rem;
			letter-spacing: 0.06em;
		}
	}
</style>
