<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchPuzzles, fetchPuzzle, ApiError } from '$lib/services/api';
	import type { PuzzleSummary } from '$lib/types/puzzle';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import CategoryFilter from '$lib/components/CategoryFilter.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import DiscardSessionDialog from '$lib/components/DiscardSessionDialog.svelte';
	import SavedProgressDialog from '$lib/components/SavedProgressDialog.svelte';
	import { listQuick } from '$lib/services/quickPuzzle';
	import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
	import {
		discoverGalleryProgress,
		discoverAllSavedProgress,
		type GalleryProgress
	} from '$lib/services/gameplay/galleryProgress';
	import {
		createSessionStorageAdapter,
		listResumableSessionCandidateIds
	} from '$lib/services/gameplay/session/persistence';
	import { CATEGORY_ALL } from '$lib/constants/categories';
	import type { PuzzleCategory } from '$lib/constants/categories';
	import { resolve } from '$app/paths';

	const sessionStorageAdapter = createSessionStorageAdapter();

	let puzzles: PuzzleSummary[] = $state([]);
	let loading = $state(true);
	let initialLoadComplete = $state(false);
	let error: string | null = $state(null);
	let loadMoreError = $state(false);
	let selectedCategory: PuzzleCategory | typeof CATEGORY_ALL = $state(CATEGORY_ALL);
	let searchQuery = $state('');
	let debouncedQuery = $state('');
	let total = $state(0);
	let loadingMore = $state(false);
	let scrollSentinel = $state<HTMLDivElement | null>(null);
	let nextCursor: string | undefined = $state(undefined);
	let quickPuzzles: StoredQuickPuzzle[] = $state([]);
	let discardTarget = $state<GalleryProgress | null>(null);
	let cardProgressByPuzzleId = $state<ReadonlyMap<string, GalleryProgress>>(new Map());
	let latestProgress = $state<GalleryProgress | null>(null);
	let savedProgressCandidateIds = $state<string[]>([]);
	let savedProgressOpen = $state(false);
	let savedProgressLoading = $state(false);
	let savedProgressItems = $state<GalleryProgress[]>([]);
	// Whether the most recent saved-progress discovery ran to completion.
	// false means a transient 5xx/network failure interrupted discovery, so
	// an empty result list does NOT imply progress is gone — the dialog
	// surfaces a retryable outage instead of "NO SAVED PROGRESS".
	let savedProgressComplete = $state(true);
	let savedProgressRequestId = 0;
	let savedProgressController: AbortController | null = null;
	let hasMore = $derived(nextCursor !== undefined);
	let queryVersion = 0;
	let loadMoreController: AbortController | null = null;

	onMount(() => {
		quickPuzzles = listQuick();
		savedProgressCandidateIds = listResumableSessionCandidateIds();
	});

	$effect(() => {
		const discovery = discoverGalleryProgress({
			serverPuzzles: puzzles,
			quickPuzzles
		});
		cardProgressByPuzzleId = discovery.byPuzzleId;

		const candidate = discovery.newest;
		if (
			candidate &&
			(latestProgress === null || candidate.lastUpdated > latestProgress.lastUpdated)
		) {
			latestProgress = candidate;
		}
	});

	// Debounce raw input into debouncedQuery (300 ms), trimming whitespace
	$effect(() => {
		const q = searchQuery;
		const timer = setTimeout(() => {
			debouncedQuery = q.trim();
		}, 300);
		return () => clearTimeout(timer);
	});

	// Re-fetch whenever debouncedQuery or selectedCategory changes
	$effect(() => {
		const q = debouncedQuery;
		const cat = selectedCategory;
		const version = ++queryVersion;
		loadMoreController?.abort();
		loadMoreController = null;

		loading = true;
		error = null;
		total = 0;
		loadingMore = false;
		loadMoreError = false;
		nextCursor = undefined;

		const controller = new AbortController();
		const catParam = cat === CATEGORY_ALL ? undefined : (cat as PuzzleCategory);

		fetchPuzzles({ q: q || undefined, category: catParam, offset: 0, signal: controller.signal })
			.then((result) => {
				if (controller.signal.aborted || version !== queryVersion) return;
				puzzles = result.puzzles;
				total = result.total;
				nextCursor = result.nextCursor;
			})
			.catch((e) => {
				if (controller.signal.aborted || version !== queryVersion) return;
				error = e instanceof ApiError ? e.message : 'Failed to load puzzles. Please try again.';
			})
			.finally(() => {
				if (!controller.signal.aborted && version === queryVersion) {
					loading = false;
					initialLoadComplete = true;
				}
			});

		return () => controller.abort();
	});

	$effect(() => {
		const sentinel = scrollSentinel;
		if (!sentinel) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && !loadMoreError && !loadingMore && hasMore) loadNextPage();
			},
			{ rootMargin: '200px' }
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	async function loadNextPage() {
		if (loadingMore || !hasMore) return;
		const version = queryVersion;
		const controller = new AbortController();
		loadMoreController = controller;
		loadingMore = true;
		loadMoreError = false;
		const catParam =
			selectedCategory === CATEGORY_ALL ? undefined : (selectedCategory as PuzzleCategory);
		try {
			const result = await fetchPuzzles({
				q: debouncedQuery || undefined,
				category: catParam,
				cursor: nextCursor,
				signal: controller.signal
			});
			if (controller.signal.aborted || version !== queryVersion) return;
			puzzles = [...puzzles, ...result.puzzles];
			total = result.total;
			nextCursor = result.nextCursor;
		} catch (e) {
			const isAbort = e instanceof DOMException && e.name === 'AbortError';
			if (!isAbort) console.error('Failed to load next page:', e);
			if (controller.signal.aborted || version !== queryVersion) return;
			loadMoreError = true;
		} finally {
			if (loadMoreController === controller) {
				loadMoreController = null;
				loadingMore = false;
			}
		}
	}

	function handleCategorySelect(category: PuzzleCategory | typeof CATEGORY_ALL) {
		selectedCategory = category;
	}

	function clearFilters() {
		searchQuery = '';
		debouncedQuery = '';
		selectedCategory = CATEGORY_ALL;
	}

	async function openSavedProgress(): Promise<void> {
		savedProgressOpen = true;
		savedProgressLoading = true;
		savedProgressItems = [];
		savedProgressComplete = true;
		const requestId = ++savedProgressRequestId;
		savedProgressController?.abort();
		const controller = new AbortController();
		savedProgressController = controller;

		try {
			const { rows: items, complete } = await discoverAllSavedProgress({
				puzzleIds: savedProgressCandidateIds,
				serverPuzzles: puzzles,
				quickPuzzles,
				fetchPuzzleById: fetchPuzzle,
				sessionStorage: sessionStorageAdapter,
				signal: controller.signal
			});

			if (requestId !== savedProgressRequestId) return;
			savedProgressItems = items;
			savedProgressComplete = complete;
			savedProgressLoading = false;
			// After a complete discovery, the authoritative result is the source
			// of truth for which candidates survived full peekSession()
			// validation — not a shallow listResumableSessionCandidateIds()
			// re-probe. A current-schema active save can pass the shallow
			// lifecycle/activity probe but fail deep validation (malformed tray
			// order, counters, result-class state, etc.). In that case
			// discoverAllSavedProgress purges the structurally invalid session
			// from storage (like the 400 malformed-id case) and returns { rows: [], complete: true }.
			// Using the authoritative result here clears the affordance on the
			// current mount; the storage purge ensures onMount's shallow re-probe
			// on remount does not re-add the dead id. Valid-but-non-resumable
			// snapshots (e.g. completed sessions) are NOT purged. An incomplete
			// discovery keeps the existing ids intact for retry.
			if (complete) savedProgressCandidateIds = items.map((item) => item.puzzleId);
		} catch (error) {
			// Stale or intentionally aborted requests (picker closed, newer
			// request superseded) must not log or mutate state — the abort is
			// expected, not an error. Only current, non-aborted failures publish
			// the retryable outage state and preserve candidate ids for retry.
			if (requestId !== savedProgressRequestId || controller.signal.aborted) return;
			console.error('Failed to discover saved progress:', error);
			savedProgressItems = [];
			// A rejection means discovery never completed — treat as incomplete
			// so the dialog shows the retryable outage state, not "NO SAVED
			// PROGRESS", and the candidate ids are preserved for retry.
			savedProgressComplete = false;
			savedProgressLoading = false;
		}
	}

	function closeSavedProgress(): void {
		savedProgressRequestId += 1;
		savedProgressController?.abort();
		savedProgressController = null;
		savedProgressOpen = false;
		savedProgressLoading = false;
	}

	function confirmDiscardProgress(): void {
		const target = discardTarget;
		if (!target) return;

		sessionStorageAdapter.clearSession(target.puzzleId);
		const discovery = discoverGalleryProgress({ serverPuzzles: puzzles, quickPuzzles });
		cardProgressByPuzzleId = discovery.byPuzzleId;
		latestProgress = discovery.newest;
		savedProgressCandidateIds = listResumableSessionCandidateIds();
		discardTarget = null;
	}
</script>

<svelte:head>
	<title>Puzzle Arcade | Perseus</title>
</svelte:head>

<main
	inert={discardTarget !== null || savedProgressOpen}
	aria-hidden={discardTarget !== null || savedProgressOpen}
	class="min-h-screen bg-(--bg-0)
[background-image:linear-gradient(rgba(0,240,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.025)_1px,transparent_1px)]
[background-size:48px_48px]"
>
	<div class="mx-auto max-w-[80rem] px-6 pt-8 pb-16 sm:px-8 sm:pt-10">
		<header class="mb-12">
			<div
				class="h-px bg-[linear-gradient(90deg,transparent_0%,var(--accent)_30%,var(--accent)_70%,transparent_100%)] opacity-40"
			></div>
			<div class="flex items-end justify-between gap-4 py-5 max-sm:flex-col max-sm:items-start">
				<div class="shrink-0">
					<div
						class="mb-1 text-[0.65rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
					>
						// PERSEUS SYSTEM v1.0
					</div>
					<h1
						class="text-[clamp(1.75rem,5vw,3.25rem)] leading-none font-(--font-display)
font-black tracking-[0.06em] text-(--text-0) uppercase"
					>
						PUZZLE
						<span
							class="ml-[0.3em] text-(--accent)
[text-shadow:0_0_20px_var(--accent),0_0_50px_var(--accent-glow-strong)]"
						>
							ARCADE
						</span>
					</h1>
				</div>
				<div
					class="flex flex-col items-end gap-[0.3rem] text-right max-sm:items-start max-sm:text-left"
				>
					<span
						class="text-[0.7rem] font-(--font-mono) tracking-[0.25em] text-(--text-2) uppercase"
					>
						SELECT YOUR MISSION
					</span>
					{#if total > 0}
						<span
							class="text-[0.7rem] font-(--font-mono) tracking-[0.15em] text-(--accent) opacity-70"
							data-testid="availability-badge"
						>
							{total} AVAILABLE
						</span>
					{/if}
				</div>
			</div>
			<div
				class="h-px bg-[linear-gradient(90deg,transparent_0%,var(--accent)_30%,var(--accent)_70%,transparent_100%)] opacity-40"
			></div>

			{#if initialLoadComplete}
				<div class="flex flex-col gap-3 pt-5">
					<SearchBar value={searchQuery} onInput={(v) => (searchQuery = v)} />
					<CategoryFilter selected={selectedCategory} onSelect={handleCategorySelect} />
				</div>
			{/if}
		</header>

		{#if latestProgress || savedProgressCandidateIds.length > 0}
			<section
				data-testid="continue-on-device"
				aria-labelledby="continue-on-device-title"
				class="mb-8 flex flex-wrap items-center gap-x-6 gap-y-3 border border-(--accent) bg-(--bg-1)
				px-6 py-4 [box-shadow:0_0_25px_var(--accent-glow)]"
			>
				{#if latestProgress}
					<div class="min-w-40">
						<h2
							id="continue-on-device-title"
							class="text-[0.65rem] font-(--font-mono) tracking-[0.18em] text-(--accent) uppercase"
						>
							Continue on this device
						</h2>
						<p class="mt-1 truncate text-[0.9rem] font-(--font-display) font-bold text-(--text-0)">
							{latestProgress.name}
						</p>
					</div>
					<span class="text-[0.7rem] font-(--font-mono) tracking-[0.12em] text-(--text-1)">
						{latestProgress.placedCount}/{latestProgress.pieceCount} PLACED
					</span>
					<a
						href={resolve(`/puzzle/${latestProgress.puzzleId}`)}
						class="border border-(--accent) px-5 py-2 text-[0.65rem] font-(--font-display) font-bold
						tracking-[0.2em] text-(--accent) uppercase transition-colors hover:bg-(--accent-glow)"
					>
						CONTINUE
					</a>
					<button
						type="button"
						aria-label="Discard saved progress"
						class="border border-(--border) px-5 py-2 text-[0.65rem] font-(--font-display) font-bold
						tracking-[0.2em] text-(--text-1) uppercase transition-colors hover:bg-(--border)"
						onclick={() => (discardTarget = latestProgress)}
					>
						DISCARD
					</button>
				{:else}
					<div class="min-w-40">
						<h2
							id="continue-on-device-title"
							class="text-[0.65rem] font-(--font-mono) tracking-[0.18em] text-(--accent) uppercase"
						>
							Continue on this device
						</h2>
						<p class="mt-1 truncate text-[0.9rem] font-(--font-display) font-bold text-(--text-0)">
							SAVED PROGRESS AVAILABLE
						</p>
					</div>
				{/if}
				{#if savedProgressCandidateIds.length > 0}
					<button
						type="button"
						aria-label="View saved progress"
						class="border border-(--accent) px-5 py-2 text-[0.65rem] font-(--font-display) font-bold
						tracking-[0.2em] text-(--accent) uppercase transition-colors hover:bg-(--accent-glow)"
						onclick={openSavedProgress}
					>
						VIEW SAVED PROGRESS
					</button>
				{/if}
			</section>
		{/if}

		{#if loading}
			<div
				class="flex flex-col items-center justify-center gap-6 py-24"
				data-testid="loading-state"
				role="status"
				aria-live="polite"
			>
				<div
					class="h-11 w-11 rounded-full border-2 border-(--border) border-t-(--accent)
[box-shadow:0_0_20px_var(--accent-glow)]
motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none
motion-reduce:[box-shadow:none]"
				></div>
				<span
					class="text-[0.75rem] font-(--font-mono) tracking-[0.25em] text-(--accent)
motion-safe:animate-[neon-flicker_3s_ease-in-out_infinite]
motion-reduce:animate-none"
				>
					SCANNING MISSIONS...
				</span>
			</div>
		{:else if error}
			<div
				class="mx-auto flex max-w-[32rem] flex-col items-center gap-4 border border-(--hot)
bg-(--bg-1) px-8 py-12 text-center
[box-shadow:0_0_40px_var(--hot-glow),inset_0_0_40px_rgba(255,0,102,0.04)]"
				data-testid="error-state"
			>
				<div
					class="text-[1.75rem] font-(--font-display) font-black tracking-[0.15em] text-(--hot)
[text-shadow:0_0_25px_var(--hot)]"
				>
					SYS_ERR
				</div>
				<p class="text-[0.8rem] font-(--font-mono) tracking-[0.05em] text-(--text-1)">{error}</p>
				<button
					onclick={() => window.location.reload()}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
				>
					RETRY SCAN
				</button>
			</div>
		{:else if total === 0 && !debouncedQuery && selectedCategory === CATEGORY_ALL}
			<div
				class="flex flex-col items-center gap-4 border border-(--border) bg-(--bg-1) px-8 py-16 text-center"
				data-testid="empty-state"
			>
				<div
					class="opacity-35 motion-safe:animate-[float_3s_ease-in-out_infinite]
motion-reduce:animate-none"
				>
					<svg
						class="h-16 w-16 text-(--text-1)"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						aria-hidden="true"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="1.5"
							d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
						/>
					</svg>
				</div>
				<h2
					class="text-[1rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-1)
uppercase"
				>
					NO MISSIONS AVAILABLE
				</h2>
				<p class="text-[0.9rem] tracking-[0.05em] text-(--text-2)">
					Initialize the system via the admin portal.
				</p>
				<a
					href={resolve('/admin')}
					data-sveltekit-reload
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
				>
					ADMIN PORTAL
				</a>
			</div>
		{:else if total === 0}
			<div
				class="flex flex-col items-center gap-4 border border-(--border) bg-(--bg-1) px-8 py-16 text-center"
				data-testid="no-results-state"
			>
				<h2
					class="text-[1rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-1)
uppercase"
				>
					NO MISSIONS MATCH YOUR SCAN
				</h2>
				<p class="text-[0.9rem] tracking-[0.05em] text-(--text-2)">
					Try a different search term or category.
				</p>
				<button
					onclick={clearFilters}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
					data-testid="clear-filters-btn"
				>
					CLEAR FILTERS
				</button>
			</div>
		{:else}
			<div
				class="grid grid-cols-1 gap-5 motion-safe:animate-[slide-up_0.4s_ease-out]
motion-reduce:animate-none sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
				data-testid="puzzle-grid"
			>
				{#each puzzles as puzzle (puzzle.id)}
					<PuzzleCard {puzzle} placedCount={cardProgressByPuzzleId.get(puzzle.id)?.placedCount} />
				{/each}
			</div>

			{#if loadingMore}
				<div
					class="flex justify-center py-8"
					role="status"
					aria-live="polite"
					data-testid="load-more-spinner"
				>
					<div
						class="h-8 w-8 rounded-full border-2 border-(--border) border-t-(--accent)
[box-shadow:0_0_15px_var(--accent-glow)]
motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none"
					></div>
				</div>
			{:else if loadMoreError}
				<div class="flex justify-center py-8" data-testid="load-more-error">
					<button
						onclick={loadNextPage}
						class="border border-(--hot) px-6 py-2 text-[0.65rem] font-(--font-mono)
tracking-[0.15em] text-(--hot) uppercase transition-colors duration-150
hover:bg-[rgba(255,0,102,0.08)]"
					>
						RETRY LOAD
					</button>
				</div>
			{/if}

			<div
				bind:this={scrollSentinel}
				data-testid="scroll-sentinel"
				class="h-px"
				aria-hidden="true"
			></div>
		{/if}
	</div>
</main>

{#if discardTarget}
	<DiscardSessionDialog
		puzzleName={discardTarget.name}
		onConfirm={confirmDiscardProgress}
		onCancel={() => (discardTarget = null)}
	/>
{/if}

{#if savedProgressOpen}
	<SavedProgressDialog
		progress={savedProgressItems}
		loading={savedProgressLoading}
		complete={savedProgressComplete}
		onClose={closeSavedProgress}
	/>
{/if}
