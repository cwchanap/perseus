<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchPuzzles, fetchPuzzle, getFamilyThumbnailUrl, ApiError } from '$lib/services/api';
	import type { PuzzleFamilySummary } from '@perseus/types';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import ProgressRing from '$lib/components/ProgressRing.svelte';
	import CategoryFilter from '$lib/components/CategoryFilter.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import DiscardSessionDialog from '$lib/components/DiscardSessionDialog.svelte';
	import SavedProgressDialog from '$lib/components/SavedProgressDialog.svelte';
	import { listQuick } from '$lib/services/quickPuzzle';
	import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
	import {
		discoverGalleryProgress,
		discoverAllSavedProgress,
		getDifficultyLabel,
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

	let families: PuzzleFamilySummary[] = $state([]);
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
	let cardProgressByVariantId = $state<ReadonlyMap<string, GalleryProgress>>(new Map());
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
	let resumeImageError = $state(false);
	const resumeImageUrl = $derived.by(() => {
		if (!latestProgress) return null;
		if (latestProgress.source === 'local') {
			return (
				quickPuzzles.find((puzzle) => puzzle.id === latestProgress?.puzzleId)?.imageDataUrl ?? null
			);
		}

		const family = families.find((candidate) =>
			[candidate.variants.easy, candidate.variants.normal, candidate.variants.hard].some(
				(variant) => variant.id === latestProgress?.puzzleId
			)
		);
		return family ? getFamilyThumbnailUrl(family.id) : null;
	});

	onMount(() => {
		quickPuzzles = listQuick();
		savedProgressCandidateIds = listResumableSessionCandidateIds();
	});

	$effect(() => {
		const discovery = discoverGalleryProgress({
			serverFamilies: families,
			quickPuzzles
		});
		cardProgressByVariantId = discovery.byVariantId;

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
				families = result.families;
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
			families = [...families, ...result.families];
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
				serverFamilies: families,
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
		const discovery = discoverGalleryProgress({ serverFamilies: families, quickPuzzles });
		cardProgressByVariantId = discovery.byVariantId;
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
	class="min-h-screen bg-transparent"
>
	<div class="gallery-layout">
		<div class="gallery-topbar">
			<h1 class="sr-only">Puzzle Arcade</h1>
			{#if initialLoadComplete}
				<div class="gallery-search-container">
					<details class="gallery-search-disclosure" data-testid="gallery-search-disclosure">
						<summary
							class="gallery-search-toggle"
							aria-label="Open puzzle search"
							data-testid="gallery-search-toggle"
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-width="2.2" d="M21 21l-5.6-5.6" />
								<circle cx="10" cy="10" r="6.4" stroke-width="2.2" />
							</svg>
						</summary>
					</details>
					<div class="gallery-search">
						<SearchBar value={searchQuery} onInput={(v) => (searchQuery = v)} />
					</div>
				</div>
				<div class="gallery-categories">
					<CategoryFilter
						selected={selectedCategory}
						onSelect={handleCategorySelect}
						total={total > 0 ? total : undefined}
					/>
				</div>
			{/if}
		</div>

		{#if total > 0}
			<span class="sr-only" data-testid="availability-badge">{total} AVAILABLE</span>
		{/if}

		{#if latestProgress || savedProgressCandidateIds.length > 0}
			<section
				data-testid="continue-on-device"
				aria-labelledby="continue-on-device-title"
				class="continue-panel"
			>
				{#if resumeImageUrl && !resumeImageError}
					<img
						class="continue-art"
						src={resumeImageUrl}
						alt=""
						aria-hidden="true"
						onerror={() => (resumeImageError = true)}
					/>
				{/if}
				<div class="continue-art-overlay" aria-hidden="true"></div>
				{#if latestProgress}
					<div class="continue-progress-ring">
						<ProgressRing
							percent={latestProgress.pieceCount > 0
								? (latestProgress.placedCount / latestProgress.pieceCount) * 100
								: 0}
							label={`${latestProgress.name} progress`}
						/>
					</div>
					<div class="continue-details">
						<h2 id="continue-on-device-title" class="continue-kicker">CONTINUE ON THIS DEVICE</h2>
						<p class="continue-title">
							{latestProgress.name}{#if latestProgress.difficulty}
								<span
									class="ml-1 text-[0.7rem] font-(--font-mono) tracking-[0.12em] text-(--accent) uppercase"
								>
									{getDifficultyLabel(latestProgress.difficulty)}
								</span>{/if}
						</p>
						<span class="continue-stats">
							{latestProgress.placedCount}/{latestProgress.pieceCount} PLACED
						</span>
					</div>
					<a
						href={resolve(`/puzzle/${latestProgress.puzzleId}`)}
						class="continue-action arcade-btn"
						aria-label={`Continue ${latestProgress.name}${latestProgress.difficulty ? ` (${getDifficultyLabel(latestProgress.difficulty)})` : ''}`}
					>
						<svg
							class="continue-action-icon"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
						>
							<path
								d="M8 5.2v13.6c0 .9 1 1.5 1.8 1l10.4-6.8c.7-.5.7-1.5 0-2L9.8 4.2C9 3.7 8 4.3 8 5.2z"
							/>
						</svg>
						<span class="continue-action-label">RESUME</span>
					</a>
					<details class="continue-secondary">
						<summary aria-label="Saved progress actions" data-testid="continue-secondary-toggle">
							•••
						</summary>
						<div class="continue-secondary-menu">
							<button
								type="button"
								aria-label="Discard saved progress"
								onclick={() => (discardTarget = latestProgress)}
							>
								DISCARD
							</button>
							{#if savedProgressCandidateIds.length > 0}
								<button type="button" onclick={openSavedProgress}>VIEW SAVED PROGRESS</button>
							{/if}
						</div>
					</details>
				{:else}
					<div class="continue-details">
						<h2 id="continue-on-device-title" class="continue-kicker">CONTINUE ON THIS DEVICE</h2>
						<p class="continue-title">SAVED PROGRESS AVAILABLE</p>
					</div>
				{/if}
				{#if savedProgressCandidateIds.length > 0 && !latestProgress}
					<button type="button" class="continue-more-action" onclick={openSavedProgress}>
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
				class="puzzle-grid motion-safe:animate-[slide-up_0.4s_ease-out] motion-reduce:animate-none"
				data-testid="puzzle-grid"
			>
				{#each families as family (family.id)}
					<PuzzleCard {family} progressByVariantId={cardProgressByVariantId} />
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

<style>
	.gallery-layout {
		box-sizing: border-box;
		display: grid;
		width: 100%;
		max-width: 80rem;
		margin: 0 auto;
		padding: 1.625rem 2rem 4rem;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'search categories'
			'resume resume'
			'cards cards';
	}

	.gallery-topbar {
		display: contents;
	}

	.gallery-search-container {
		position: relative;
		width: min(100%, 26rem);
		grid-area: search;
	}

	.gallery-search-disclosure {
		display: block;
	}

	.gallery-search-toggle {
		display: none;
	}

	.gallery-search {
		width: 100%;
	}

	.gallery-categories {
		grid-area: categories;
		justify-self: end;
	}

	.continue-panel {
		position: relative;
		isolation: isolate;
		display: flex;
		min-width: 0;
		min-height: 6.75rem;
		box-sizing: border-box;
		grid-area: resume;
		align-items: center;
		gap: 1.375rem;
		margin-top: 1.125rem;
		margin-bottom: 1.25rem;
		overflow: visible;
		padding: 1.375rem 1.625rem;
		border: 1px solid var(--accent);
		border-radius: 1.5rem;
		background-clip: padding-box;
		z-index: 2;
		background:
			linear-gradient(
				100deg,
				rgba(10, 6, 32, 0.95),
				rgba(10, 6, 32, 0.68) 44%,
				rgba(10, 6, 32, 0.08)
			),
			repeating-linear-gradient(
				115deg,
				#2b3f52 0 26px,
				#35586d 26px 52px,
				#4a6b73 52px 78px,
				#7a6a58 78px 104px
			);
		box-shadow:
			0 14px 34px rgba(0, 0, 0, 0.5),
			0 0 0 1px var(--accent-dim);
	}

	.continue-art,
	.continue-art-overlay {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
	}

	.continue-art {
		z-index: 0;
	}

	.continue-art-overlay {
		z-index: 0;
		background: linear-gradient(
			100deg,
			rgba(10, 6, 32, 0.95),
			rgba(10, 6, 32, 0.68) 44%,
			rgba(10, 6, 32, 0.08)
		);
	}

	.continue-progress-ring,
	.continue-details,
	.continue-action,
	.continue-secondary,
	.continue-more-action {
		position: relative;
		z-index: 1;
	}

	.continue-details {
		min-width: 0;
		flex: 1;
	}

	.continue-kicker {
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

	.continue-title {
		margin: 0;
		overflow: hidden;
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 900;
		letter-spacing: 0.03em;
		text-overflow: ellipsis;
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
		text-transform: uppercase;
		white-space: nowrap;
	}

	.continue-stats {
		display: block;
		margin-top: 0.5rem;
		color: var(--text-1);
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.continue-action {
		width: auto;
		height: 4.375rem;
		flex: none;
		padding: 0 2.125rem;
		border-radius: 1.5rem;
	}

	.continue-action-icon {
		width: 1.75rem;
		height: 1.75rem;
	}

	.continue-action-label {
		display: inline;
	}

	.continue-secondary {
		position: relative;
		flex: none;
		width: 2.25rem;
	}

	.continue-secondary summary {
		display: flex;
		width: 2.25rem;
		height: 2.25rem;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		border: 1px solid var(--border-bright);
		border-radius: 0.75rem;
		color: var(--text-1);
		font-family: var(--font-display);
		font-size: 0.8rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		list-style: none;
		cursor: pointer;
	}

	.continue-secondary summary::-webkit-details-marker {
		display: none;
	}

	.continue-secondary summary:hover,
	.continue-secondary[open] summary {
		border-color: var(--accent);
		color: var(--accent);
	}

	.continue-secondary-menu {
		position: absolute;
		top: calc(100% + 0.5rem);
		right: 0;
		z-index: 4;
		display: flex;
		min-width: 10rem;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.5rem;
		border: 1px solid var(--border-bright);
		border-radius: 0.75rem;
		background: var(--bg-2);
		box-shadow: 0 12px 24px rgba(0, 0, 0, 0.45);
	}

	.continue-secondary-menu button,
	.continue-more-action {
		border: 1px solid transparent;
		background: transparent;
		padding: 0.45rem 0.55rem;
		color: var(--text-1);
		font-family: var(--font-display);
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-align: left;
		cursor: pointer;
	}

	.continue-secondary-menu button:hover,
	.continue-more-action:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.continue-more-action {
		border-color: var(--accent);
		color: var(--accent);
	}

	.continue-progress-ring {
		display: flex;
		width: 4.625rem;
		height: 4.625rem;
		flex: none;
		align-items: center;
		justify-content: center;
	}

	.puzzle-grid {
		display: grid;
		grid-area: cards;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		align-items: start;
		gap: 1.125rem;
	}

	@media (min-width: 90rem) {
		.continue-progress-ring :global(.progress-ring) {
			transform: scale(1.276);
		}
	}

	@media (min-width: 64.01rem) and (max-width: 75rem) {
		.gallery-layout {
			max-width: none;
			margin-top: -5rem;
			padding: 0 1.75rem 2.5rem;
			grid-template-areas:
				'categories search'
				'resume resume'
				'cards cards';
		}

		.gallery-search-container,
		.gallery-categories {
			display: flex;
			height: 5rem;
			align-items: flex-start;
			padding-top: 1.375rem;
			box-sizing: border-box;
		}

		.gallery-categories {
			justify-self: start;
			margin-left: 3.75rem;
		}

		.gallery-search-container {
			position: relative;
			justify-self: end;
			width: 2.625rem;
		}

		.gallery-search-toggle {
			display: flex;
			width: 2.625rem;
			height: 2.625rem;
			align-items: center;
			justify-content: center;
			box-sizing: border-box;
			border: 1px solid var(--border-bright);
			border-radius: 0.875rem;
			background: var(--bg-2);
			color: var(--text-1);
			list-style: none;
			cursor: pointer;
		}

		.gallery-search-toggle::-webkit-details-marker {
			display: none;
		}

		.gallery-search-toggle svg {
			width: 1.1rem;
			height: 1.1rem;
		}

		.gallery-search-toggle:hover,
		.gallery-search-disclosure[open] .gallery-search-toggle,
		.gallery-search-toggle:focus-visible {
			border-color: var(--accent);
			color: var(--accent);
		}

		.gallery-search-container .gallery-search {
			position: absolute;
			top: calc(100% + 0.5rem);
			right: 0;
			z-index: 5;
			display: none;
			width: min(26rem, calc(100vw - 3.5rem));
		}

		.gallery-search-disclosure[open] + .gallery-search {
			display: block;
		}

		.gallery-search-disclosure[open] + .gallery-search :global(.search-input) {
			width: 100%;
			padding: 0.625rem 1rem 0.625rem 3rem;
			color: var(--text-1);
			font-size: 0.95rem;
		}

		.gallery-search-disclosure[open] + .gallery-search :global(.search-icon) {
			inset: 0 auto 0 1rem;
			width: 1.2rem;
			justify-content: flex-start;
		}

		.gallery-search-disclosure[open] + .gallery-search :global(.search-input)::placeholder {
			color: var(--text-1);
		}

		.continue-panel {
			min-height: 6.375rem;
			gap: 1.125rem;
			margin-top: 0;
			margin-bottom: 1.125rem;
			padding: 1.125rem 1.25rem;
		}

		.continue-progress-ring {
			width: 3.875rem;
			height: 3.875rem;
		}

		.continue-title {
			font-size: 1.2rem;
		}

		.continue-stats {
			margin-top: 0.35rem;
			font-size: 0.875rem;
		}

		.continue-action {
			width: 4rem;
			height: 4rem;
			padding: 0;
			border-radius: 1.375rem;
		}

		.continue-action-label {
			display: none;
		}
	}

	@media (max-width: 39.999rem) {
		.gallery-layout {
			display: flex;
			max-width: none;
			flex-direction: column;
			padding: 0 1.125rem 2.5rem;
		}

		.gallery-search-container {
			position: relative;
			width: 100%;
			height: 0;
			grid-area: search;
		}

		.gallery-search-toggle {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
			clip-path: inset(50%);
			white-space: nowrap;
			border: 0;
		}

		.gallery-search-container .gallery-search {
			display: none;
			width: 100%;
		}

		.gallery-search-container:has(.gallery-search-disclosure[open]) {
			height: 2.625rem;
			margin-bottom: 0.75rem;
		}

		.gallery-search-disclosure[open] + .gallery-search {
			display: block;
		}

		.gallery-search-disclosure[open] + .gallery-search :global(.search-input) {
			width: 100%;
			color: var(--text-1);
			font-size: 0.95rem;
		}

		.gallery-search-disclosure[open] + .gallery-search :global(.search-input)::placeholder {
			color: var(--text-1);
		}

		.gallery-categories {
			order: 2;
			margin-bottom: 1rem;
		}

		.continue-panel {
			order: 1;
			min-height: 5.625rem;
			gap: 0.5rem;
			margin-top: 0;
			margin-bottom: 1rem;
			padding: 1rem;
			border-radius: 1.375rem;
		}

		.continue-progress-ring {
			width: 3.625rem;
			height: 3.625rem;
		}

		.continue-title {
			font-size: 1rem;
		}

		.continue-stats {
			margin-top: 0.3rem;
			font-size: 0.8rem;
		}

		.continue-action {
			width: 3.75rem;
			height: 3.75rem;
			padding: 0;
			border-radius: 1.375rem;
		}

		.continue-action-label {
			display: none;
		}

		.continue-secondary {
			width: 2rem;
		}

		.continue-secondary summary {
			width: 2rem;
			height: 2rem;
		}

		.puzzle-grid {
			order: 3;
			grid-template-columns: minmax(0, 1fr);
			gap: 1rem;
		}
	}
</style>
