<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import { PUZZLE_CATEGORIES } from '$lib/constants/categories';
	import type { PuzzleCategory } from '$lib/constants/categories';
	import { ApiError, deletePuzzle, fetchAdminPuzzles, getThumbnailUrl } from '$lib/services/api';
	import { createSessionStorageAdapter } from '$lib/services/gameplay/session/persistence';
	import type { PuzzleStatus, PuzzleSummary } from '$lib/types/puzzle';
	import { filterAdminPuzzles, pageSlice } from './adminPuzzleList';

	// Reuses the session persistence adapter so the localStorage key prefix
	// (puzzle-progress-) stays encapsulated in one place. Admin only needs the
	// best-effort clear after a delete; no session-awareness required.
	const sessionStorageAdapter = createSessionStorageAdapter();
	const PAGE_SIZE = 20;

	let puzzles: PuzzleSummary[] = $state([]);
	let loadingPuzzles = $state(true);
	let puzzlesError: string | null = $state(null);
	let puzzlesFetchInFlight = $state(false);
	let successMessage: string | null = $state(null);
	let successTimeout: ReturnType<typeof setTimeout> | null = null;
	let deletingId: string | null = $state(null);
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let mounted = false;
	let searchQuery = $state('');
	let categoryFilter = $state<'all' | PuzzleCategory>('all');
	let statusFilter = $state<'all' | PuzzleStatus>('all');
	let pageIndex = $state(0);
	const hasActiveCriteria = $derived(
		searchQuery.trim().length > 0 || categoryFilter !== 'all' || statusFilter !== 'all'
	);
	const filteredPuzzles = $derived(
		filterAdminPuzzles(puzzles, {
			query: searchQuery,
			category: categoryFilter,
			status: statusFilter
		})
	);
	const pageResult = $derived(pageSlice(filteredPuzzles, pageIndex, PAGE_SIZE));
	const visiblePuzzles = $derived(pageResult.page);

	onMount(async () => {
		mounted = true;
		await loadPuzzles();
		startPollingIfNeeded();
	});

	onDestroy(() => {
		mounted = false;
		if (successTimeout !== null) {
			clearTimeout(successTimeout);
			successTimeout = null;
		}
		if (pollInterval !== null) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	});

	function showSuccess(message: string, timeoutMs = 5000) {
		successMessage = message;
		if (successTimeout !== null) clearTimeout(successTimeout);
		successTimeout = setTimeout(() => {
			successMessage = null;
			successTimeout = null;
		}, timeoutMs);
	}

	function startPollingIfNeeded() {
		if (!mounted) return;
		const hasProcessing = puzzles.some((puzzle) => puzzle.status === 'processing');
		if (hasProcessing && pollInterval === null) {
			pollInterval = setInterval(async () => {
				if (!mounted || puzzlesFetchInFlight) return;
				puzzlesFetchInFlight = true;
				try {
					const latestPuzzles = await loadPuzzles(true);
					if (!mounted) return;
					const stillProcessing = latestPuzzles.some((puzzle) => puzzle.status === 'processing');
					if (!stillProcessing && pollInterval !== null) {
						clearInterval(pollInterval);
						pollInterval = null;
					}
				} finally {
					if (mounted) {
						puzzlesFetchInFlight = false;
					}
				}
			}, 3000);
		}
	}

	async function loadPuzzles(silent = false): Promise<PuzzleSummary[]> {
		if (!silent) {
			loadingPuzzles = true;
			puzzlesError = null;
		}
		try {
			puzzles = await fetchAdminPuzzles();
			return puzzles;
		} catch (error) {
			console.error('Failed to load puzzles', error);
			if (!silent) {
				puzzlesError = error instanceof ApiError ? error.message : 'Failed to load puzzles';
				puzzles = [];
			}
			return puzzles;
		} finally {
			if (!silent) {
				loadingPuzzles = false;
			}
		}
	}

	async function handleDelete(puzzleId: string, isProcessing: boolean = false) {
		const confirmMessage = isProcessing
			? 'This puzzle is still processing. Force delete may leave orphaned assets. Continue?'
			: 'Are you sure you want to delete this puzzle?';
		if (!confirm(confirmMessage)) return;

		deletingId = puzzleId;
		try {
			const deleteResult = await deletePuzzle(puzzleId, { force: isProcessing });
			sessionStorageAdapter.clearSession(puzzleId);
			if (deleteResult && 'partialSuccess' in deleteResult && deleteResult.partialSuccess) {
				showSuccess(deleteResult.warning);
			}
			await loadPuzzles();
		} catch (error) {
			const message = error instanceof ApiError ? error.message : 'Failed to delete puzzle';
			alert(message);
		} finally {
			deletingId = null;
		}
	}

	function resetCriteria() {
		searchQuery = '';
		categoryFilter = 'all';
		statusFilter = 'all';
		pageIndex = 0;
	}
</script>

{#if successMessage}
	<div
		class="mb-4 border border-[rgba(0,255,136,0.4)] bg-[rgba(0,255,136,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) tracking-[0.05em] text-(--green)"
		role="status"
	>
		{successMessage}
	</div>
{/if}

<div class="border border-(--border) bg-(--bg-1)">
	<div class="flex items-center justify-between border-b border-(--border) bg-(--bg-2) px-4 py-3">
		<span
			class="text-[0.6rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
		>
			MISSION DATABASE
		</span>
		<span class="text-[0.6rem] font-(--font-mono) tracking-[0.1em] text-(--accent)">
			{#if hasActiveCriteria}
				{filteredPuzzles.length} OF {puzzles.length}
			{:else}
				{puzzles.length} TOTAL
			{/if}
		</span>
	</div>

	<div class="flex flex-col gap-2 border-b border-(--border) p-4 sm:flex-row">
		<SearchBar
			value={searchQuery}
			onInput={(value) => {
				searchQuery = value;
				pageIndex = 0;
			}}
		/>
		<div class="flex gap-2">
			<select
				aria-label="Filter by category"
				value={categoryFilter}
				onchange={(event) => {
					categoryFilter = event.currentTarget.value as 'all' | PuzzleCategory;
					pageIndex = 0;
				}}
				class="min-w-0 flex-1 border border-(--border) bg-(--bg-1) px-3 py-2.5
text-[0.6rem] font-(--font-mono) tracking-[0.1em] text-(--text-1)
focus:border-(--accent) focus:outline-none sm:w-40"
			>
				<option value="all">ALL CATEGORIES</option>
				{#each PUZZLE_CATEGORIES as category}
					<option value={category}>{category.toUpperCase()}</option>
				{/each}
			</select>
			<select
				aria-label="Filter by status"
				value={statusFilter}
				onchange={(event) => {
					statusFilter = event.currentTarget.value as 'all' | PuzzleStatus;
					pageIndex = 0;
				}}
				class="min-w-0 flex-1 border border-(--border) bg-(--bg-1) px-3 py-2.5
text-[0.6rem] font-(--font-mono) tracking-[0.1em] text-(--text-1)
focus:border-(--accent) focus:outline-none sm:w-36"
			>
				<option value="all">ALL STATUS</option>
				<option value="ready">READY</option>
				<option value="processing">PROCESSING</option>
				<option value="failed">FAILED</option>
			</select>
			{#if hasActiveCriteria}
				<button
					onclick={resetCriteria}
					class="shrink-0 border border-(--accent-dim) px-3 py-2.5 text-[0.55rem]
font-(--font-display) font-semibold tracking-[0.15em] text-(--accent)
transition-colors hover:border-(--accent) hover:bg-(--accent-glow)"
				>
					RESET
				</button>
			{/if}
		</div>
	</div>

	{#if loadingPuzzles}
		<div class="flex justify-center p-10">
			<div
				class="h-7 w-7 rounded-full border-2 border-(--border) border-t-(--accent)
motion-safe:animate-[spin-cw_0.75s_linear_infinite]
motion-reduce:animate-none"
			></div>
		</div>
	{:else if puzzlesError}
		<div
			class="m-4 border border-(--hot-dim) bg-[rgba(255,0,102,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) tracking-[0.05em] text-(--hot)"
			role="alert"
		>
			{puzzlesError}
		</div>
	{:else if puzzles.length === 0}
		<div
			class="px-4 py-10 text-center text-[0.72rem] font-(--font-mono) tracking-[0.08em] text-(--text-2)"
		>
			<p>No missions found.</p>
		</div>
	{:else if filteredPuzzles.length === 0}
		<div
			class="px-4 py-10 text-center text-[0.72rem] font-(--font-mono) tracking-[0.08em] text-(--text-2)"
		>
			<p>No missions match the current search and filters.</p>
		</div>
	{:else}
		<div class="flex flex-col">
			{#each visiblePuzzles as puzzle (puzzle.id)}
				<div
					class="flex items-center justify-between gap-3 border-b border-(--border) px-4 py-3
transition-colors duration-150 last:border-b-0 hover:bg-(--bg-2)"
				>
					<div class="flex min-w-0 items-center gap-3">
						{#if puzzle.status === 'processing'}
							<div
								class="flex h-12 w-12 shrink-0 items-center justify-center border border-(--border)
bg-(--bg-2)"
								role="status"
								aria-label="Processing puzzle"
							>
								<div
									class="h-5 w-5 rounded-full border-2 border-(--border) border-t-(--accent)
motion-safe:animate-[spin-cw_0.75s_linear_infinite]
motion-reduce:animate-none"
								></div>
							</div>
						{:else if puzzle.status === 'failed'}
							<div
								class="flex h-12 w-12 shrink-0 items-center justify-center border border-(--border)
bg-(--bg-2)"
								aria-label="Puzzle failed"
								role="img"
							>
								<span class="text-(--hot)">x</span>
							</div>
						{:else}
							<img
								src={getThumbnailUrl(puzzle.id)}
								alt={puzzle.name}
								class="h-12 w-12 shrink-0 object-cover"
							/>
						{/if}

						<div class="flex min-w-0 flex-col gap-[0.2rem]">
							<div class="flex flex-wrap items-center gap-2">
								<span
									class="max-w-40 truncate text-[0.85rem] font-(--font-body) font-semibold text-(--text-0)"
								>
									{puzzle.name}
								</span>
								{#if puzzle.status === 'processing'}
									<span
										class="shrink-0 border border-(--accent-dim) bg-(--accent-glow) px-[0.45rem]
py-[0.15rem] text-[0.55rem] font-(--font-mono)
tracking-[0.15em] text-(--accent)"
									>
										PROCESSING
									</span>
								{:else if puzzle.status === 'failed'}
									<span
										class="shrink-0 border border-(--hot-dim) bg-(--hot-glow) px-[0.45rem]
py-[0.15rem] text-[0.55rem] font-(--font-mono)
tracking-[0.15em] text-(--hot)"
									>
										FAILED
									</span>
								{:else}
									<span
										class="shrink-0 border border-[rgba(0,255,136,0.4)] bg-[rgba(0,255,136,0.06)]
px-[0.45rem] py-[0.15rem] text-[0.55rem] font-(--font-mono)
tracking-[0.15em] text-(--green)"
									>
										READY
									</span>
								{/if}
							</div>
							<span class="text-[0.65rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
								{puzzle.pieceCount} pieces
								{#if puzzle.status === 'processing' && puzzle.progress}
									<span class="text-(--accent)">
										({puzzle.progress.generatedPieces}/{puzzle.progress.totalPieces})
									</span>
								{/if}
							</span>
						</div>
					</div>

					<button
						onclick={() => handleDelete(puzzle.id, puzzle.status === 'processing')}
						disabled={deletingId === puzzle.id}
						class="shrink-0 border border-(--hot-dim) px-2.5 py-[0.35rem]
text-[0.55rem] font-(--font-display) font-semibold tracking-[0.15em]
text-(--hot) transition-all duration-150 hover:border-(--hot)
hover:bg-(--hot-glow) disabled:cursor-not-allowed disabled:opacity-40"
						title={puzzle.status === 'processing' ? 'Force delete stuck puzzle' : 'Delete puzzle'}
					>
						{#if deletingId === puzzle.id}
							...
						{:else if puzzle.status === 'processing'}
							FORCE DEL
						{:else}
							DELETE
						{/if}
					</button>
				</div>
			{/each}
			{#if pageResult.totalPages > 1}
				<div
					class="flex items-center justify-between border-t border-(--border) bg-(--bg-2)
px-4 py-3"
				>
					<button
						aria-label="Previous page"
						disabled={pageResult.clampedIndex === 0}
						onclick={() => (pageIndex = pageResult.clampedIndex - 1)}
						class="border border-(--border) px-3 py-2 text-[0.55rem] font-(--font-display)
font-semibold tracking-[0.12em] text-(--text-1) transition-colors
hover:border-(--accent) hover:text-(--accent)
disabled:cursor-not-allowed disabled:opacity-35"
					>
						PREVIOUS
					</button>
					<span class="text-[0.6rem] font-(--font-mono) tracking-[0.1em] text-(--text-2)">
						PAGE {pageResult.clampedIndex + 1} OF {pageResult.totalPages}
					</span>
					<button
						aria-label="Next page"
						disabled={pageResult.clampedIndex === pageResult.totalPages - 1}
						onclick={() => (pageIndex = pageResult.clampedIndex + 1)}
						class="border border-(--border) px-3 py-2 text-[0.55rem] font-(--font-display)
font-semibold tracking-[0.12em] text-(--text-1) transition-colors
hover:border-(--accent) hover:text-(--accent)
disabled:cursor-not-allowed disabled:opacity-35"
					>
						NEXT
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
