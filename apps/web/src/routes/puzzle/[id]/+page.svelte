<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { fetchPuzzle, ApiError } from '$lib/services/api';
	import { getProgress, saveProgress, clearProgress } from '$lib/services/progress';
	import { getBestTime, saveCompletionTime } from '$lib/services/stats';
	import { createTimerStore, formatTime } from '$lib/stores/timer';
	import type { TimerState } from '$lib/stores/timer';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Puzzle, PlacedPiece, PuzzlePiece as TPuzzlePiece } from '$lib/types/puzzle';
	import PuzzleBoard from '$lib/components/PuzzleBoard.svelte';
	import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
	import GameTimer from '$lib/components/GameTimer.svelte';
	import { shuffleArray } from '$lib/utils/shuffle';
	import { resolve } from '$app/paths';

	let puzzle: Puzzle | null = $state(null);
	let loading = $state(true);
	let error: string | null = $state(null);
	let placedPieces: PlacedPiece[] = $state([]);
	let showCelebration = $state(false);
	let rejectedPiece: number | null = $state(null);
	let shuffledPieceIds: number[] = $state([]);

	// Timer and statistics state
	const timer = createTimerStore();
	let timerState: TimerState = $state({ elapsed: 0, running: false });
	let timerStarted = $state(false);
	let bestTime: number | null = $state(null);
	let isNewBest = $state(false);
	let timerUnsubscribe: (() => void) | null = null;

	timerUnsubscribe = timer.subscribe((state) => {
		timerState = state;
	});

	onDestroy(() => {
		if (timerUnsubscribe) {
			timerUnsubscribe();
			timerUnsubscribe = null;
		}
		timer.destroy();
	});

	const puzzleId = $derived($page.params.id);

	// Use SvelteMap so Svelte 5 can track reactive changes while keeping O(1) piece lookup
	const piecesMap = $derived.by(() => {
		const map = new SvelteMap<number, TPuzzlePiece>();
		if (puzzle) {
			for (const p of puzzle.pieces) {
				map.set(p.id, p);
			}
		}
		return map;
	});

	// Get pieces in shuffled order
	const shuffledPieces = $derived(
		shuffledPieceIds
			.map((id) => piecesMap.get(id))
			.filter((p): p is TPuzzlePiece => p !== undefined)
	);

	$effect(() => {
		if (puzzleId) {
			loadPuzzle(puzzleId);
		}
	});

	async function loadPuzzle(id: string) {
		loading = true;
		error = null;

		try {
			puzzle = await fetchPuzzle(id);

			// Shuffle piece order for display
			shuffledPieceIds = shuffleArray(puzzle.pieces.map((p) => p.id));

			// Restore progress from localStorage
			const savedProgress = getProgress(id);
			if (savedProgress) {
				placedPieces = savedProgress.placedPieces;
			}

			// Load best time
			bestTime = getBestTime(id);

			// Reset timer for resumed puzzles
			timer.reset();
			timerStarted = false;
			isNewBest = false;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				// Clear any saved progress for non-existent puzzle
				clearProgress(id);
				error = 'Mission no longer available';
			} else {
				error = 'Failed to load mission';
			}
		} finally {
			loading = false;
		}
	}

	function ensureTimerStarted() {
		if (!timerStarted) {
			timerStarted = true;
			timer.start();
		}
	}

	function handlePiecePlaced(pieceId: number, x: number, y: number) {
		ensureTimerStarted();

		const newPlacement: PlacedPiece = { pieceId, x, y };
		placedPieces = [...placedPieces.filter((p) => p.pieceId !== pieceId), newPlacement];

		// Save progress
		if (puzzle) {
			saveProgress(puzzle.id, placedPieces);
		}

		// Check for completion
		if (puzzle && placedPieces.length === puzzle.pieceCount) {
			timer.pause();
			// Record time and check if new best
			isNewBest = saveCompletionTime(puzzle.id, timerState.elapsed);
			bestTime = getBestTime(puzzle.id);
			showCelebration = true;
		}
	}

	function handleIncorrectPlacement(pieceId: number) {
		ensureTimerStarted();

		rejectedPiece = pieceId;
		setTimeout(() => {
			rejectedPiece = null;
		}, 500);
	}

	function isPiecePlaced(pieceId: number): boolean {
		return placedPieces.some((p) => p.pieceId === pieceId);
	}

	function handlePlayAgain() {
		if (puzzle) {
			placedPieces = [];
			clearProgress(puzzle.id);
			showCelebration = false;
			timer.reset();
			timerStarted = false;
			isNewBest = false;
			// Reshuffle pieces for new game
			shuffledPieceIds = shuffleArray(puzzle.pieces.map((p) => p.id));
		}
	}

	function handleGoHome() {
		goto(resolve('/'));
	}

	// Focus management for modal accessibility
	function manageModalFocus(node: HTMLElement, isOpen: boolean) {
		let previousFocus: HTMLElement | null = null;
		let focusableElements: HTMLElement[] = [];
		let firstElement: HTMLElement | null = null;
		let lastElement: HTMLElement | null = null;
		let focusTimeout: ReturnType<typeof setTimeout> | null = null;
		let restoreFocusTimeout: ReturnType<typeof setTimeout> | null = null;

		// Get all focusable elements within the modal
		const getFocusableElements = (element: HTMLElement) => {
			return Array.from(
				element.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				)
			).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
		};

		// Trap focus within the modal
		const trapFocus = (e: KeyboardEvent) => {
			if (e.key !== 'Tab') return;

			if (e.shiftKey) {
				// Shift+Tab
				if (document.activeElement === firstElement) {
					e.preventDefault();
					lastElement?.focus();
				}
			} else {
				// Tab
				if (document.activeElement === lastElement) {
					e.preventDefault();
					firstElement?.focus();
				}
			}
		};

		if (isOpen) {
			// Save current focus
			previousFocus = document.activeElement as HTMLElement;

			// Get focusable elements
			focusableElements = getFocusableElements(node);
			firstElement = focusableElements[0] || null;
			lastElement = focusableElements[focusableElements.length - 1] || null;

			// Move focus to first element
			focusTimeout = setTimeout(() => firstElement?.focus(), 100);

			// Add event listeners
			document.addEventListener('keydown', trapFocus);
		}

		return {
			destroy() {
				if (focusTimeout !== null) {
					clearTimeout(focusTimeout);
					focusTimeout = null;
				}
				if (restoreFocusTimeout !== null) {
					clearTimeout(restoreFocusTimeout);
					restoreFocusTimeout = null;
				}

				// Remove event listeners
				document.removeEventListener('keydown', trapFocus);

				// Restore focus when modal closes
				if (previousFocus) {
					restoreFocusTimeout = setTimeout(() => previousFocus?.focus(), 0);
				}
			}
		};
	}

	const progressPct = $derived.by(() => {
		if (!puzzle || puzzle.pieceCount === 0) return 0;
		if (placedPieces.length >= puzzle.pieceCount) return 100;
		return Math.floor((placedPieces.length / puzzle.pieceCount) * 100);
	});
</script>

<svelte:head>
	<title>{puzzle?.name || 'Mission'} | Perseus Arcade</title>
</svelte:head>

<div class="puzzle-page">
	<!-- HUD Header -->
	<header class="hud-header">
		<div class="hud-left">
			<a
				href={resolve('/')}
				class="back-btn"
				aria-label="Return to arcade"
				data-testid="back-to-arcade-link"
			>
				<svg
					class="back-icon"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M10 19l-7-7m0 0l7-7m-7 7h18"
					/>
				</svg>
				<span>ARCADE</span>
			</a>
		</div>

		{#if puzzle}
			<div class="hud-center">
				<div class="mission-tag">// MISSION</div>
				<div class="mission-name">{puzzle.name.toUpperCase()}</div>
			</div>

			<div class="hud-right">
				<div class="progress-stat">
					<span class="stat-label">PIECES</span>
					<span class="stat-value"
						>{placedPieces.length}<span class="stat-total">/{puzzle.pieceCount}</span></span
					>
				</div>
				<div class="hud-divider"></div>
				<GameTimer {timerState} {bestTime} />
			</div>
		{/if}
	</header>

	<!-- Progress bar -->
	{#if puzzle}
		<div class="progress-bar-wrap">
			<div class="progress-bar-fill" style="width: {progressPct}%"></div>
		</div>
	{/if}

	<!-- Content -->
	<main class="puzzle-main" inert={showCelebration} aria-hidden={showCelebration}>
		{#if loading}
			<div class="state-center">
				<div class="loading-ring"></div>
				<span class="state-label">LOADING MISSION...</span>
			</div>
		{:else if error}
			<div class="error-panel">
				<svg
					class="err-icon"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
				<h2 class="err-title">{error}</h2>
				<p class="err-sub">This mission may have been deleted.</p>
				<a href={resolve('/')} class="arcade-btn">RETURN TO ARCADE</a>
			</div>
		{:else if puzzle}
			<div class="game-layout">
				<!-- Board panel -->
				<div class="board-panel">
					<div class="panel-header">
						<span class="panel-tag">PUZZLE BOARD</span>
					</div>
					<div class="board-wrap">
						<PuzzleBoard
							{puzzle}
							{placedPieces}
							onPiecePlaced={handlePiecePlaced}
							onIncorrectPlacement={handleIncorrectPlacement}
						/>
					</div>
				</div>

				<!-- Inventory panel -->
				<div class="inventory-panel">
					<div class="panel-header">
						<span class="panel-tag">INVENTORY</span>
						<span class="inv-count">{puzzle.pieceCount - placedPieces.length} LEFT</span>
					</div>
					<div class="pieces-grid">
						{#each shuffledPieces as piece (piece.id)}
							{#if !isPiecePlaced(piece.id)}
								<div
									class="piece-slot"
									class:rejected={rejectedPiece === piece.id}
									class:animate-shake={rejectedPiece === piece.id}
								>
									<PuzzlePiece {piece} isPlaced={false} />
								</div>
							{/if}
						{/each}
					</div>
					{#if placedPieces.length === puzzle.pieceCount}
						<div class="complete-msg">
							<span class="complete-icon">◆</span>
							ALL PIECES PLACED
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</main>
</div>

<!-- Mission Complete Modal -->
{#if showCelebration}
	<div
		class="modal-backdrop"
		data-testid="celebration-modal"
		role="presentation"
		onkeydown={(e) => e.key === 'Escape' && (showCelebration = false)}
	>
		<div
			class="modal-box"
			role="dialog"
			aria-modal="true"
			aria-labelledby="modal-title"
			use:manageModalFocus={showCelebration}
		>
			<div class="modal-scan-line"></div>
			<div class="modal-top-line"></div>

			<div class="modal-tag">// MISSION COMPLETE</div>
			<div class="modal-rank">S RANK</div>

			<h2 id="modal-title" class="modal-title">{puzzle?.name?.toUpperCase()}</h2>

			<div class="modal-stats">
				<div class="modal-stat">
					<span class="mstat-label">FINAL TIME</span>
					<span class="mstat-value">{formatTime(timerState.elapsed)}</span>
				</div>
				{#if isNewBest}
					<div class="modal-stat new-best">
						<span class="mstat-label">PERSONAL BEST</span>
						<span class="mstat-value gold">{formatTime(bestTime ?? timerState.elapsed)}</span>
						<span class="new-record-badge">NEW RECORD</span>
					</div>
				{/if}
			</div>

			<div class="modal-bottom-line"></div>

			<div class="modal-actions">
				<button onclick={handlePlayAgain} class="arcade-btn">PLAY AGAIN</button>
				<button onclick={handleGoHome} class="arcade-btn-ghost">BACK TO ARCADE</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* ===== PAGE STRUCTURE ===== */
	.puzzle-page {
		min-height: 100vh;
		background-color: var(--bg-0);
		background-image:
			linear-gradient(rgba(0, 240, 255, 0.02) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0, 240, 255, 0.02) 1px, transparent 1px);
		background-size: 40px 40px;
		display: flex;
		flex-direction: column;
	}

	/* ===== HUD HEADER ===== */
	.hud-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1.25rem;
		background: var(--bg-1);
		border-bottom: 1px solid var(--border);
		gap: 1rem;
		flex-shrink: 0;
	}

	.hud-left {
		flex-shrink: 0;
	}

	.back-btn {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
		text-decoration: none;
		transition: color 0.15s ease;
		padding: 0.3rem 0;
	}

	.back-btn:hover {
		color: var(--accent);
	}

	.back-icon {
		width: 0.875rem;
		height: 0.875rem;
	}

	.hud-center {
		flex: 1;
		text-align: center;
		min-width: 0;
	}

	.mission-tag {
		font-family: var(--font-mono);
		font-size: 0.55rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		opacity: 0.6;
	}

	.mission-name {
		font-family: var(--font-display);
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: var(--text-0);
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	.hud-right {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		flex-shrink: 0;
	}

	.progress-stat {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.1rem;
	}

	.stat-label {
		font-family: var(--font-mono);
		font-size: 0.5rem;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.stat-value {
		font-family: var(--font-mono);
		font-size: 0.9rem;
		color: var(--text-0);
		letter-spacing: 0.05em;
	}

	.stat-total {
		color: var(--text-2);
		font-size: 0.75rem;
	}

	.hud-divider {
		width: 1px;
		height: 2rem;
		background: var(--border);
	}

	/* Progress bar */
	.progress-bar-wrap {
		height: 2px;
		background: var(--bg-3);
		flex-shrink: 0;
	}

	.progress-bar-fill {
		height: 100%;
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
		transition: width 0.3s ease;
	}

	/* ===== MAIN CONTENT ===== */
	.puzzle-main {
		flex: 1;
		padding: 1.25rem;
		overflow: auto;
	}

	.state-center {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 5rem 0;
		gap: 1.5rem;
	}

	.loading-ring {
		width: 2.5rem;
		height: 2.5rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
		box-shadow: 0 0 20px var(--accent-glow);
	}

	.state-label {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.25em;
		color: var(--accent);
		animation: neon-flicker 3s ease-in-out infinite;
	}

	/* Error panel */
	.error-panel {
		max-width: 32rem;
		margin: 3rem auto;
		background: var(--bg-1);
		border: 1px solid var(--hot);
		padding: 3rem 2rem;
		text-align: center;
		box-shadow: 0 0 40px var(--hot-glow);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.875rem;
	}

	.err-icon {
		width: 3rem;
		height: 3rem;
		color: var(--hot);
		filter: drop-shadow(0 0 8px var(--hot));
	}

	.err-title {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-0);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.err-sub {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-2);
	}

	/* ===== GAME LAYOUT ===== */
	.game-layout {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1.25rem;
		max-width: 80rem;
		margin: 0 auto;
	}

	@media (min-width: 1024px) {
		.game-layout {
			grid-template-columns: 1fr 280px;
		}
	}

	/* Board panel */
	.board-panel {
		background: var(--bg-1);
		border: 1px solid var(--border);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-2);
	}

	.panel-tag {
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.board-wrap {
		padding: 1rem;
		overflow: auto;
	}

	/* Inventory panel */
	.inventory-panel {
		background: var(--bg-1);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}

	.inv-count {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.15em;
	}

	.pieces-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.375rem;
		padding: 0.875rem;
		overflow-y: auto;
		flex: 1;
	}

	@media (min-width: 640px) and (max-width: 1023px) {
		.pieces-grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	.piece-slot {
		aspect-ratio: 1;
		border: 1px solid var(--border);
		padding: 0.2rem;
		transition: border-color 0.15s ease;
	}

	.piece-slot.rejected {
		border-color: var(--hot);
		box-shadow: 0 0 12px var(--hot-glow);
	}

	.complete-msg {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.875rem;
		font-family: var(--font-display);
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.2em;
		color: var(--green);
		text-shadow: 0 0 12px var(--green);
		border-top: 1px solid var(--border);
	}

	.complete-icon {
		font-size: 0.5rem;
		text-shadow: 0 0 8px var(--green);
	}

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

	.modal-rank {
		font-family: var(--font-display);
		font-size: 3rem;
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

	.modal-actions {
		display: flex;
		justify-content: center;
		gap: 0.875rem;
		flex-wrap: wrap;
		padding-top: 0.5rem;
	}

	/* ===== REDUCED MOTION ACCESSIBILITY ===== */
	@media (prefers-reduced-motion: reduce) {
		.progress-bar-fill {
			transition: none;
		}

		.loading-ring {
			animation: none;
			box-shadow: none;
		}

		.state-label {
			animation: none;
		}

		.modal-scan-line {
			animation: none;
		}

		.modal-box {
			animation: none;
		}

		.modal-rank {
			animation: none;
		}

		.piece-slot.rejected {
			box-shadow: none;
		}

		.arcade-btn:hover {
			box-shadow: none;
			text-shadow: none;
		}

		.err-icon {
			filter: none;
		}

		.error-panel {
			box-shadow: none;
		}
	}
</style>
