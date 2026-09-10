<script lang="ts">
	import { resolve } from '$app/paths';
	import { onDestroy, onMount } from 'svelte';
	import DifficultyGems from '$lib/components/DifficultyGems.svelte';
	import ReferenceOverlay from '$lib/components/ReferenceOverlay.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import { PUZZLE_CATEGORIES } from '$lib/constants/categories';
	import type { PuzzleCategory } from '$lib/constants/categories';
	import {
		ApiError,
		deletePuzzle,
		fetchAdminPuzzles,
		getFamilyThumbnailUrl,
		getReferenceImageUrl
	} from '$lib/services/api';
	import { createSessionStorageAdapter } from '$lib/services/gameplay/session/persistence';
	import type { PuzzleStatus } from '$lib/types/puzzle';
	import type { PuzzleFamilySummary } from '@perseus/types';
	import { filterAdminPuzzles, pageSlice } from './adminPuzzleList';

	interface AdminPuzzlesPanelProps {
		active?: boolean;
		onCountChange?: (count: number) => void;
	}

	let { active = true, onCountChange }: AdminPuzzlesPanelProps = $props();

	// Reuses the session persistence adapter so the localStorage key prefix
	// (puzzle-progress-) stays encapsulated in one place. Admin only needs the
	// best-effort clear after a delete; no session-awareness required.
	const sessionStorageAdapter = createSessionStorageAdapter();
	const PAGE_SIZE = 20;

	let puzzles: PuzzleFamilySummary[] = $state([]);
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
	let previewFamily: PuzzleFamilySummary | null = $state(null);
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
	const readyCount = $derived(puzzles.filter((puzzle) => puzzle.status === 'ready').length);
	const processingCount = $derived(
		puzzles.filter((puzzle) => puzzle.status === 'processing').length
	);
	const failedCount = $derived(puzzles.filter((puzzle) => puzzle.status === 'failed').length);

	onMount(async () => {
		mounted = true;
		await loadPuzzles();
		if (active) startPollingIfNeeded();
	});

	$effect(() => {
		if (!mounted) return;
		if (active) {
			startPollingIfNeeded();
		} else {
			stopPolling();
		}
	});

	onDestroy(() => {
		mounted = false;
		if (successTimeout !== null) {
			clearTimeout(successTimeout);
			successTimeout = null;
		}
		stopPolling();
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
		if (!mounted || !active) return;
		const hasProcessing = puzzles.some((puzzle) => puzzle.status === 'processing');
		if (!hasProcessing) {
			stopPolling();
			return;
		}
		if (pollInterval === null) {
			pollInterval = setInterval(async () => {
				if (!mounted || !active || puzzlesFetchInFlight) return;
				puzzlesFetchInFlight = true;
				try {
					const latestPuzzles = await loadPuzzles(true);
					if (!mounted) return;
					const stillProcessing = latestPuzzles.some((puzzle) => puzzle.status === 'processing');
					if (!stillProcessing) stopPolling();
				} finally {
					if (mounted) {
						puzzlesFetchInFlight = false;
					}
				}
			}, 3000);
		}
	}

	function stopPolling() {
		if (pollInterval === null) return;
		clearInterval(pollInterval);
		pollInterval = null;
	}

	async function loadPuzzles(silent = false): Promise<PuzzleFamilySummary[]> {
		if (!silent) {
			loadingPuzzles = true;
			puzzlesError = null;
		}
		try {
			puzzles = await fetchAdminPuzzles();
			onCountChange?.(puzzles.length);
			return puzzles;
		} catch (error) {
			console.error('Failed to load puzzles', error);
			if (!silent) {
				puzzlesError = error instanceof ApiError ? error.message : 'Failed to load puzzles';
				puzzles = [];
				onCountChange?.(0);
			}
			return puzzles;
		} finally {
			if (!silent) {
				loadingPuzzles = false;
			}
		}
	}

	async function handleDelete(familyId: string, isProcessing = false) {
		const confirmMessage = isProcessing
			? 'This puzzle family is still processing. Force delete may leave orphaned assets. Continue?'
			: 'Are you sure you want to delete this puzzle family?';
		if (!confirm(confirmMessage)) return;

		deletingId = familyId;
		try {
			const deleteResult = await deletePuzzle(familyId, { force: isProcessing });
			const family = puzzles.find((entry) => entry.id === familyId);
			if (family) {
				for (const difficulty of ['easy', 'normal', 'hard'] as const) {
					sessionStorageAdapter.clearSession(family.variants[difficulty].id);
				}
			}
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

	function dismissPreview() {
		previewFamily = null;
	}

	function handlePreviewKeyDown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || previewFamily === null) return;
		event.preventDefault();
		dismissPreview();
	}
</script>

<svelte:window onkeydown={handlePreviewKeyDown} />

<ReferenceOverlay
	imageUrl={previewFamily ? getReferenceImageUrl(previewFamily.variants.easy.id) : null}
	active={previewFamily !== null}
	dismissible
	onDismiss={dismissPreview}
/>

{#if successMessage}
	<div
		class="mb-4 rounded-2xl border border-[rgba(0,255,136,0.4)] bg-[rgba(0,255,136,0.06)] px-4 py-3
		text-[0.9rem] font-(--font-body) font-semibold tracking-[0.04em] text-(--green)"
		role="status"
	>
		{successMessage}
	</div>
{/if}

<div class="flex min-h-full min-w-0 flex-col">
	<div class="flex flex-wrap items-end justify-between gap-4 pb-2">
		<div>
			<h2
				class="text-[clamp(1.25rem,3vw,1.7rem)] font-(--font-display) font-black tracking-[0.08em] text-(--text-0)"
				style="font-family: var(--font-display)"
			>
				MISSION DATABASE
			</h2>
			<p
				class="mt-1 text-[0.95rem] font-(--font-body) font-semibold tracking-[0.02em] text-(--text-2)"
			>
				{puzzles.length} puzzle families · 3 difficulty variants each
			</p>
		</div>
		<div class="flex flex-wrap items-center justify-end gap-2">
			<span
				aria-label={`${readyCount} ready`}
				class="rounded-full border border-(--green-dim) bg-[rgba(0,255,136,0.08)] px-3 py-1.5 text-[0.62rem]
				font-(--font-display) font-bold tracking-[0.1em] text-(--green)"
			>
				<span class="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-(--green)" aria-hidden="true"
				></span>
				{readyCount} <span class="status-summary-label status-ready" aria-hidden="true"></span>
			</span>
			<span
				aria-label={`${processingCount} processing`}
				class="rounded-full border border-(--accent-dim) bg-(--accent-glow) px-3 py-1.5 text-[0.62rem]
				font-(--font-display) font-bold tracking-[0.1em] text-(--accent)"
			>
				<span class="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-(--accent)" aria-hidden="true"
				></span>
				{processingCount}
				<span class="status-summary-label status-processing" aria-hidden="true"></span>
			</span>
			<span
				aria-label={`${failedCount} failed`}
				class="rounded-full border border-(--hot-dim) bg-(--hot-glow) px-3 py-1.5 text-[0.62rem]
				font-(--font-display) font-bold tracking-[0.1em] text-(--hot)"
			>
				<span class="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-(--hot)" aria-hidden="true"
				></span>
				{failedCount} <span class="status-summary-label status-failed" aria-hidden="true"></span>
			</span>
			{#if hasActiveCriteria}
				<span
					class="rounded-full border border-(--border-bright) bg-(--bg-3) px-3 py-1.5 text-[0.62rem]
					font-(--font-mono) tracking-[0.1em] text-(--text-1)"
				>
					{filteredPuzzles.length} OF {puzzles.length}
				</span>
			{/if}
			<a
				href={resolve('/upload')}
				class="inline-flex h-[47px] items-center gap-1.5 rounded-full border border-(--accent)
				bg-[linear-gradient(160deg,#5affff,#00c2dc)] px-4 text-sm font-(--font-display)
				font-black tracking-[0.1em] text-[#03202a]
				shadow-[0_3px_0_#00707f] transition-[filter] hover:brightness-105"
			>
				<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
					<path d="M12 3l4 4h-3v6h-2V7H8zM5 15h14v5H5z" />
				</svg>
				UPLOAD MISSION
			</a>
		</div>
	</div>

	<div class="flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
		<div class="w-full max-w-[380px]">
			<SearchBar
				value={searchQuery}
				onInput={(value) => {
					searchQuery = value;
					pageIndex = 0;
				}}
			/>
		</div>
		<div class="flex flex-wrap gap-2">
			<select
				aria-label="Filter by category"
				value={categoryFilter}
				onchange={(event) => {
					categoryFilter = event.currentTarget.value as 'all' | PuzzleCategory;
					pageIndex = 0;
				}}
				class="min-w-0 flex-1 rounded-[18px] border border-(--border-bright) bg-(--bg-1) px-3 py-2.5
				text-sm font-(--font-body) font-semibold tracking-[0.05em] text-(--text-1)
				focus:border-(--accent) focus:outline-none sm:w-40"
			>
				<option value="all">ALL CATEGORIES</option>
				{#each PUZZLE_CATEGORIES as category (category)}
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
				class="min-w-0 flex-1 rounded-[18px] border border-(--border-bright) bg-(--bg-1) px-3 py-2.5
				text-sm font-(--font-body) font-semibold tracking-[0.05em] text-(--text-1)
				focus:border-(--accent) focus:outline-none sm:w-36"
			>
				<option value="all">ALL STATUS</option>
				<option value="ready">READY</option>
				<option value="processing">PROCESSING</option>
				<option value="failed">FAILED</option>
			</select>
			{#if hasActiveCriteria}
				<button
					type="button"
					onclick={resetCriteria}
					class="shrink-0 rounded-[18px] border border-(--accent-dim) px-3 py-2.5 text-[0.65rem]
					font-(--font-display) font-semibold tracking-[0.15em] text-(--accent) transition-colors
					hover:border-(--accent) hover:bg-(--accent-glow)"
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
				motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none"
			></div>
		</div>
	{:else if puzzlesError}
		<div
			class="m-4 rounded-xl border border-(--hot-dim) bg-[rgba(255,0,102,0.06)] px-4 py-3
			text-sm font-(--font-body) font-semibold tracking-[0.04em] text-(--hot)"
			role="alert"
		>
			{puzzlesError}
		</div>
	{:else if puzzles.length === 0}
		<div class="px-4 py-10 text-center text-sm font-(--font-body) font-semibold text-(--text-2)">
			<p>No missions found.</p>
		</div>
	{:else if filteredPuzzles.length === 0}
		<div class="px-4 py-10 text-center text-sm font-(--font-body) font-semibold text-(--text-2)">
			<p>No missions match the current search and filters.</p>
		</div>
	{:else}
		<div
			class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-(--border) bg-[rgba(10,7,28,0.46)]"
		>
			<div class="min-h-0 flex-1 overflow-x-auto">
				<div class="min-h-full min-w-[760px]">
					<div
						class="grid grid-cols-[76px_minmax(180px,1fr)_140px_270px_112px] items-center gap-4 border-b border-(--border)
					bg-[rgba(28,20,64,0.7)] px-5 py-3 text-xs font-(--font-body) font-bold tracking-[0.1em] text-(--text-2) uppercase"
					>
						<span></span>
						<span>Mission</span>
						<span>Status</span>
						<span>Pieces</span>
						<span class="text-right">Actions</span>
					</div>
					{#each visiblePuzzles as puzzle (puzzle.id)}
						<div
							data-testid="admin-puzzle-row"
							class="grid grid-cols-[76px_minmax(180px,1fr)_140px_270px_112px] items-center gap-4 border-b border-[rgba(44,28,96,0.7)]
						px-5 py-3.5 transition-colors duration-150 last:border-b-0 hover:bg-(--bg-2)"
						>
							<div
								data-admin-thumbnail="60"
								class="flex h-[60px] w-[60px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-(--border-bright) bg-(--bg-2)"
							>
								{#if puzzle.status === 'processing'}
									<div
										class="h-5 w-5 rounded-full border-2 border-(--border) border-t-(--accent)
									motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none"
										role="status"
										aria-label="Processing puzzle"
									></div>
								{:else if puzzle.status === 'failed'}
									<span
										class="text-2xl font-(--font-display) text-(--hot)"
										role="img"
										aria-label="Puzzle failed">×</span
									>
								{:else}
									<img
										src={getFamilyThumbnailUrl(puzzle.id)}
										alt={puzzle.name}
										class="h-full w-full object-cover"
									/>
								{/if}
							</div>

							<div class="min-w-0">
								<div
									class="truncate text-[1.05rem] font-(--font-body) font-bold tracking-[0.02em] text-(--text-0)"
								>
									{puzzle.name}
								</div>
								<div
									class="mt-1 text-sm font-(--font-body) font-semibold tracking-[0.04em] text-(--text-2)"
								>
									{puzzle.category ?? 'Uncategorized'}
								</div>
							</div>

							<div
								data-testid="admin-status"
								class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.7rem]
						font-(--font-body) font-bold tracking-[0.05em]
						{puzzle.status === 'ready'
									? 'border-(--green-dim) bg-[rgba(0,255,136,0.08)] text-(--green)'
									: puzzle.status === 'processing'
										? 'border-(--accent-dim) bg-(--accent-glow) text-(--accent)'
										: 'border-(--hot-dim) bg-(--hot-glow) text-(--hot)'}"
							>
								<span
									class="h-2.5 w-2.5 rounded-full
								{puzzle.status === 'ready'
										? 'bg-(--green) shadow-[0_0_10px_var(--green-glow)]'
										: puzzle.status === 'processing'
											? 'bg-(--accent) shadow-[0_0_10px_var(--accent-glow-strong)]'
											: 'bg-(--hot) shadow-[0_0_10px_var(--hot-glow)]'}"
									aria-hidden="true"
								></span>
								{puzzle.status.toUpperCase()}
							</div>

							<div class="flex items-center gap-2">
								<DifficultyGems difficulty="easy" pieceCount={puzzle.variants.easy.pieceCount} />
								<DifficultyGems
									difficulty="normal"
									pieceCount={puzzle.variants.normal.pieceCount}
								/>
								<DifficultyGems difficulty="hard" pieceCount={puzzle.variants.hard.pieceCount} />
							</div>

							<div class="flex items-center justify-end gap-2">
								{#if puzzle.status === 'ready'}
									<button
										type="button"
										aria-label={`View full image for ${puzzle.name}`}
										title={`Preview ${puzzle.name}`}
										onclick={() => (previewFamily = puzzle)}
										class="flex h-11 w-11 items-center justify-center rounded-xl border border-(--border-bright) bg-(--bg-3) text-(--text-1)
									transition-colors hover:border-(--accent) hover:text-(--accent) focus-visible:outline-2 focus-visible:outline-(--accent)"
									>
										<svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
											<path
												d="M12 5C7 5 3.2 8.4 2 12c1.2 3.6 5 7 10 7s8.8-3.4 10-7c-1.2-3.6-5-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8z"
											/>
										</svg>
									</button>
								{/if}
								<button
									type="button"
									aria-label={`${puzzle.status === 'processing' ? 'Force delete' : 'Delete'} ${puzzle.name}`}
									title={puzzle.status === 'processing'
										? 'Force delete stuck family'
										: 'Delete family'}
									onclick={() => handleDelete(puzzle.id, puzzle.status === 'processing')}
									disabled={deletingId === puzzle.id}
									class="flex h-11 w-11 items-center justify-center rounded-xl border border-(--hot-dim) bg-[rgba(255,0,102,0.1)]
								text-(--hot) transition-colors hover:border-(--hot) hover:bg-(--hot-glow)
								focus-visible:outline-2 focus-visible:outline-(--hot) disabled:cursor-not-allowed disabled:opacity-40"
								>
									<svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
										<path d="M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7z" />
									</svg>
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
			{#if pageResult.totalPages > 1}
				<div
					class="flex items-center justify-between border-t border-(--border) bg-[rgba(28,20,64,0.7)] px-5 py-3"
				>
					<button
						type="button"
						aria-label="Previous page"
						disabled={pageResult.clampedIndex === 0}
						onclick={() => (pageIndex = pageResult.clampedIndex - 1)}
						class="rounded-xl border border-(--border-bright) px-3 py-2 text-[0.6rem] font-(--font-display)
					font-semibold tracking-[0.12em] text-(--text-1) transition-colors hover:border-(--accent)
					hover:text-(--accent) disabled:cursor-not-allowed disabled:opacity-35"
					>
						PREVIOUS
					</button>
					<span class="text-sm font-(--font-body) font-semibold tracking-[0.08em] text-(--text-2)">
						PAGE {pageResult.clampedIndex + 1} OF {pageResult.totalPages}
					</span>
					<button
						type="button"
						aria-label="Next page"
						disabled={pageResult.clampedIndex === pageResult.totalPages - 1}
						onclick={() => (pageIndex = pageResult.clampedIndex + 1)}
						class="rounded-xl border border-(--border-bright) px-3 py-2 text-[0.6rem] font-(--font-display)
					font-semibold tracking-[0.12em] text-(--text-1) transition-colors hover:border-(--accent)
					hover:text-(--accent) disabled:cursor-not-allowed disabled:opacity-35"
					>
						NEXT
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.status-summary-label::after {
		font-family: var(--font-display);
		content: '';
	}

	.status-ready::after {
		content: 'READY';
	}

	.status-processing::after {
		content: 'PROCESSING';
	}

	.status-failed::after {
		content: 'FAILED';
	}
</style>
