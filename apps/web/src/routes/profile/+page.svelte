<script lang="ts">
	import { onMount } from 'svelte';
	import {
		getPlayerProfile,
		getPlayerPuzzles,
		getPlayerStats,
		getPlayerProgression,
		fetchFamilyDetail,
		updatePlayerProfile,
		uploadPlayerAvatar,
		resolveAssetUrl
	} from '$lib/services/api';
	import type {
		PlayerProfile,
		PlayerOwnedFamilySummary,
		PlayerStatRow,
		PlayerProgressionSummary
	} from '$lib/types/puzzle';
	import type { PuzzleFamilySummary } from '@perseus/types';
	import { resolve } from '$app/paths';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ProfileHero from '$lib/components/profile/ProfileHero.svelte';
	import ProfileStatPanels from '$lib/components/profile/ProfileStatPanels.svelte';
	import ProfileBestTimes from '$lib/components/profile/ProfileBestTimes.svelte';
	import { ICONS } from '$lib/constants/icons';
	import { ownedFamilyToGalleryFamily, hasPlayableVariantIds } from '$lib/utils/familyCard';

	let profile = $state<PlayerProfile | null>(null);
	let progression = $state<PlayerProgressionSummary | null>(null);
	let families = $state<PuzzleFamilySummary[]>([]);
	let stats = $state<PlayerStatRow[]>([]);
	let loading = $state(true);
	let loadError = $state(false);
	let editing = $state(false);
	let displayName = $state('');
	let saving = $state(false);
	// Pagination cursors returned by the API. Undefined means "no more pages",
	// in which case the "Load more" button isn't rendered. Separate
	// loadingMore flags per list: the puzzles and stats lists are independent,
	// so loading one page shouldn't block the other.
	let puzzlesCursor = $state<string | undefined>(undefined);
	let statsCursor = $state<string | undefined>(undefined);
	let loadingMorePuzzles = $state(false);
	let loadingMoreStats = $state(false);
	// Transient error message from save-name / avatar-upload failures. These
	// are non-fatal (the page stays loaded), so we surface a short inline
	// message rather than flipping loadError (which shows the full error
	// screen). Cleared on the next successful action.
	let saveError = $state<string | null>(null);
	// AbortController for in-flight reads. Aborted on unmount so a navigation
	// away from the profile page cancels pending profile/puzzles/stats fetches
	// rather than letting them resolve and write state to an unmounted component.
	let abortController: AbortController | null = null;

	function toGalleryFamily(p: PlayerOwnedFamilySummary): PuzzleFamilySummary {
		return ownedFamilyToGalleryFamily(p);
	}

	async function enrichOwnedFamilies(
		owned: PlayerOwnedFamilySummary[],
		signal?: AbortSignal
	): Promise<PuzzleFamilySummary[]> {
		const results = await Promise.all(
			owned.map(async (family) => {
				if (family.status !== 'ready') return toGalleryFamily(family);
				try {
					const base = toGalleryFamily(family);
					const detail = await fetchFamilyDetail(family.id, signal);
					return {
						...detail,
						name: family.name,
						...(base.category ? { category: base.category } : {})
					};
				} catch (error) {
					console.error(`Failed to load family detail for ${family.id}`, error);
					return toGalleryFamily(family);
				}
			})
		);
		return results;
	}

	onMount(() => {
		// The profile +layout.svelte guards auth: it only renders this page
		// when playerAuth is authenticated, and redirects to /login on
		// anonymous/logout. So by the time this onMount runs the session is
		// valid — just load the data. The layout handles all redirect logic.
		abortController = new AbortController();
		void loadAll();
		return () => abortController?.abort();
	});

	async function loadAll() {
		const signal = abortController?.signal;
		loading = true;
		loadError = false;
		// Use allSettled so a failure in puzzles/stats doesn't hide a successfully
		// loaded profile: the profile is essential (its failure surfaces the error
		// screen), while puzzle/stat failures degrade gracefully to empty lists.
		const [profileRes, puzzlesRes, statsRes, progressionRes] = await Promise.allSettled([
			getPlayerProfile(signal),
			getPlayerPuzzles({ signal }),
			getPlayerStats({ signal }),
			getPlayerProgression(signal)
		]);
		// If the component unmounted while fetches were in flight, bail before
		// writing state to a dead component.
		if (signal?.aborted) return;
		if (profileRes.status === 'fulfilled') {
			profile = profileRes.value;
			displayName = profile?.name ?? '';
		} else {
			// Without this, a rejected profile request leaves profile null while
			// loading is false, rendering a blank page. Surface an error + retry.
			console.error('Failed to load profile:', profileRes.reason);
			loadError = true;
		}
		if (puzzlesRes.status === 'fulfilled') {
			families = await enrichOwnedFamilies(puzzlesRes.value.families, signal);
			puzzlesCursor = puzzlesRes.value.nextCursor;
		} else {
			families = [];
			puzzlesCursor = undefined;
			// Degrade non-essential failures noisily but without blocking the UI.
			console.error('Failed to load puzzles:', puzzlesRes.reason);
		}
		if (statsRes.status === 'fulfilled') {
			stats = statsRes.value.stats;
			statsCursor = statsRes.value.nextCursor;
		} else {
			stats = [];
			statsCursor = undefined;
			console.error('Failed to load stats:', statsRes.reason);
		}
		if (progressionRes.status === 'fulfilled') {
			progression = progressionRes.value;
		} else {
			progression = null;
			console.error('Failed to load progression:', progressionRes.reason);
		}
		loading = false;
	}

	// Append the next page of puzzles. The API omits nextCursor when no more rows
	// exist; when undefined, the "Load more" button isn't rendered. loadingMorePuzzles
	// guards against a double-click appending the same page twice.
	async function loadMorePuzzles() {
		if (loadingMorePuzzles || puzzlesCursor === undefined) return;
		const cursor = puzzlesCursor;
		const signal = abortController?.signal;
		loadingMorePuzzles = true;
		try {
			const r = await getPlayerPuzzles({ cursor, signal });
			if (signal?.aborted) return;
			families = [...families, ...(await enrichOwnedFamilies(r.families, signal))];
			puzzlesCursor = r.nextCursor;
		} catch (error) {
			if (signal?.aborted) return;
			console.error('Failed to load more puzzles:', error);
		} finally {
			loadingMorePuzzles = false;
		}
	}

	async function loadMoreStats() {
		if (loadingMoreStats || statsCursor === undefined) return;
		const cursor = statsCursor;
		const signal = abortController?.signal;
		loadingMoreStats = true;
		try {
			const r = await getPlayerStats({ cursor, signal });
			if (signal?.aborted) return;
			stats = [...stats, ...r.stats];
			statsCursor = r.nextCursor;
		} catch (error) {
			if (signal?.aborted) return;
			console.error('Failed to load more stats:', error);
		} finally {
			loadingMoreStats = false;
		}
	}

	// Refetch only the profile after a name/avatar mutation. Puzzles and stats
	// are unaffected by those edits, so a full loadAll() would waste two extra
	// requests and briefly flicker the lists.
	async function loadProfile() {
		const signal = abortController?.signal;
		try {
			const p = await getPlayerProfile(signal);
			if (signal?.aborted) return;
			profile = p;
			displayName = p?.name ?? '';
		} catch (error) {
			if (signal?.aborted) return;
			console.error('Failed to reload profile:', error);
		}
	}

	async function saveName() {
		saving = true;
		try {
			await updatePlayerProfile({ displayName });
			editing = false;
			saveError = null;
			await loadProfile();
		} catch (error) {
			console.error('Failed to save name:', error);
			saveError = 'Failed to save name. Please try again.';
		} finally {
			saving = false;
		}
	}

	// Clear the display-name override, reverting to the Google-sourced name.
	// The API treats displayName: null as "remove the override".
	async function resetName() {
		saving = true;
		try {
			await updatePlayerProfile({ displayName: null });
			editing = false;
			saveError = null;
			await loadProfile();
		} catch (error) {
			console.error('Failed to reset name:', error);
			saveError = 'Failed to reset name. Please try again.';
		} finally {
			saving = false;
		}
	}

	function cancelEditing() {
		// Drop any in-progress draft so re-entering edit mode starts from the
		// currently saved name rather than a stale typed value.
		displayName = profile?.name ?? '';
		editing = false;
	}

	async function onAvatarChosen(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const result = await uploadPlayerAvatar(file);
			saveError = null;
			await loadProfile();
			// Re-uploads overwrite the same R2 key and the API returns the same
			// avatarUrl path, so loadProfile() yields an identical profile.picture
			// string. Svelte then sees no <img src> change and the browser keeps
			// serving the cached image. Append a cache-buster derived from the
			// upload result so the <img> re-fetches the new bytes immediately.
			// resolveAssetUrl prefixes the origin-relative path with API_BASE
			// (needed when the API is on a separate origin, e.g. local dev);
			// without it the <img> would fetch from the web origin and 404.
			if (profile) {
				const resolved = resolveAssetUrl(result.avatarUrl);
				if (resolved) profile.picture = appendAvatarCacheBuster(resolved);
			}
		} catch (error) {
			console.error('Failed to upload avatar:', error);
			saveError = 'Failed to upload avatar. Please try again.';
		} finally {
			// Reset the input so selecting the same file again still fires a
			// change event (needed to retry a failed upload).
			input.value = '';
		}
	}

	// Append a version query param to an avatar URL so the browser treats a
	// re-upload (same path, new bytes) as a distinct resource and bypasses its
	// cache. Handles URLs that already carry a query string.
	function appendAvatarCacheBuster(url: string): string {
		const sep = url.includes('?') ? '&' : '?';
		return `${url}${sep}v=${Date.now()}`;
	}
</script>

<svelte:head>
	<title>Profile | Perseus</title>
</svelte:head>

{#if loading}
	<div
		class="flex flex-col items-center justify-center gap-4 py-24"
		role="status"
		data-testid="profile-loading"
	>
		<div
			class="h-9 w-9 rounded-full border-2 border-(--border) border-t-(--accent)
			[box-shadow:0_0_20px_var(--accent-glow)] motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none"
		></div>
		<span
			class="font-(family-name:--font-mono) text-xs tracking-[0.25em] text-(--accent) uppercase"
		>
			Loading profile…
		</span>
	</div>
{:else if loadError}
	<section class="mx-auto w-full max-w-[72rem] px-4 pt-2 pb-12 md:px-7">
		<div class="arcade-panel flex flex-col items-center gap-4 px-6 py-10 text-center">
			<p data-testid="profile-error" class="text-lg font-semibold text-(--text-1)">
				Failed to load your profile.
			</p>
			<button type="button" class="arcade-btn-ghost" onclick={loadAll}>Try again</button>
		</div>
	</section>
{:else if profile}
	<div
		class="mx-auto grid w-full max-w-[72rem] gap-4 px-4 pt-1 pb-12 md:gap-[22px] md:px-7 md:pt-2 md:pb-16"
	>
		<ProfileHero
			{profile}
			score={progression?.score ?? 0}
			rank={progression?.rank ?? null}
			{editing}
			bind:displayName
			{saving}
			{saveError}
			onEdit={() => (editing = true)}
			onCancel={cancelEditing}
			onSave={saveName}
			onReset={resetName}
			{onAvatarChosen}
		/>

		<ProfileStatPanels {progression} summary={profile.summary} />

		<div class="mt-2.5">
			<ProfileBestTimes
				{stats}
				hasMore={statsCursor !== undefined}
				loadingMore={loadingMoreStats}
				onLoadMore={loadMoreStats}
			/>
		</div>

		<section class="mt-2.5 grid gap-3.5">
			<div class="flex items-center gap-3">
				<h2 class="arcade-section-title">My puzzles</h2>
				{#if families.length > 0}
					<span class="arcade-chip">{profile.summary.puzzlesUploaded} UPLOADED</span>
					<span class="flex-1"></span>
					<a
						class="arcade-btn-ghost px-3 md:px-5"
						href={resolve('/upload')}
						aria-label="Upload a puzzle"
					>
						<svg
							viewBox="0 0 24 24"
							fill="currentColor"
							class="h-[15px] w-[15px]"
							aria-hidden="true"
						>
							<path d={ICONS.bolt} />
						</svg>
						<span class="ml-2 hidden md:inline">Upload</span>
					</a>
				{/if}
			</div>
			{#if families.length === 0}
				<EmptyState
					icon={ICONS.bolt}
					title="No uploads yet"
					message="You haven't uploaded any puzzles yet."
					testId="my-puzzles-empty"
				>
					<a class="arcade-btn" href={resolve('/upload')}>Upload a puzzle</a>
				</EmptyState>
			{:else}
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-[18px] xl:grid-cols-4">
					{#each families as p (p.id)}
						<PuzzleCard
							family={p}
							playableLinks={p.status === 'ready' && hasPlayableVariantIds(p)}
						/>
					{/each}
				</div>
				{#if puzzlesCursor !== undefined}
					<div class="flex justify-center">
						<button
							type="button"
							data-testid="load-more-puzzles"
							class="arcade-btn-ghost"
							onclick={loadMorePuzzles}
							disabled={loadingMorePuzzles}
						>
							{loadingMorePuzzles ? 'Loading…' : 'Load more'}
						</button>
					</div>
				{/if}
			{/if}
		</section>
	</div>
{/if}
