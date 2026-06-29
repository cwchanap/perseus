<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		getPlayerProfile,
		getPlayerPuzzles,
		getPlayerStats,
		updatePlayerProfile,
		uploadPlayerAvatar
	} from '$lib/services/api';
	import type {
		PlayerProfile,
		PlayerPuzzleSummary,
		PuzzleSummary,
		PlayerStatRow
	} from '$lib/types/puzzle';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import { formatTime } from '$lib/stores/timer';

	let profile = $state<PlayerProfile | null>(null);
	let puzzles = $state<PlayerPuzzleSummary[]>([]);
	let stats = $state<PlayerStatRow[]>([]);
	let loading = $state(true);
	let loadError = $state(false);
	let editing = $state(false);
	let displayName = $state('');
	let saving = $state(false);
	let saveError = $state(false);
	let avatarError = $state(false);
	let avatarInput = $state<HTMLInputElement | null>(null);
	// Infinite-scroll state for "My Puzzles". Mirrors the gallery's pattern:
	// a sentinel div observed by IntersectionObserver triggers loadNextPuzzles
	// when the user scrolls near the bottom and a nextCursor is present.
	let nextCursor = $state<string | undefined>(undefined);
	let loadingMore = $state(false);
	let loadMoreError = $state(false);
	let scrollSentinel = $state<HTMLDivElement | null>(null);
	let loadMoreController: AbortController | null = null;
	let hasMore = $derived(nextCursor !== undefined);

	const initials = $derived(
		(profile?.name ?? '?')
			.split(' ')
			.map((p) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	function toCard(p: PlayerPuzzleSummary): PuzzleSummary {
		return {
			id: p.id,
			name: p.name,
			pieceCount: p.pieceCount,
			status: p.status,
			...(p.category ? { category: p.category as PuzzleSummary['category'] } : {})
		};
	}

	onMount(() => {
		// The /profile/+layout.svelte guard ensures the user is authenticated
		// before this page mounts, so we can load data immediately without
		// re-checking playerAuth here.
		void loadAll();
	});

	async function loadAll() {
		loading = true;
		loadError = false;
		// Cancel any in-flight pagination request before replacing the list,
		// otherwise a pending loadNextPuzzles result could append stale items
		// after the fresh reload completes.
		if (loadMoreController) {
			loadMoreController.abort();
			loadMoreController = null;
		}
		loadingMore = false;
		try {
			// Reset pagination state on a fresh load (e.g. after avatar upload
			// triggers reloadAll). The puzzles list is replaced, not appended.
			nextCursor = undefined;
			loadMoreError = false;
			const [profileRes, puzzlesRes, statsRes] = await Promise.all([
				getPlayerProfile(),
				getPlayerPuzzles(),
				getPlayerStats()
			]);
			profile = profileRes;
			puzzles = puzzlesRes.puzzles;
			nextCursor = puzzlesRes.nextCursor;
			stats = statsRes.stats;
			displayName = profile?.name ?? '';
		} catch (e) {
			// Without this, a rejected request leaves profile null while loading
			// is false, rendering a blank page. Surface an error + retry instead.
			console.error('Failed to load profile:', e);
			loadError = true;
		} finally {
			loading = false;
		}
	}

	async function loadNextPuzzles() {
		if (loadingMore || !hasMore) return;
		const controller = new AbortController();
		loadMoreController = controller;
		loadingMore = true;
		loadMoreError = false;
		try {
			const result = await getPlayerPuzzles({ cursor: nextCursor });
			if (controller.signal.aborted) return;
			puzzles = [...puzzles, ...result.puzzles];
			nextCursor = result.nextCursor;
		} catch (e) {
			const isAbort = e instanceof DOMException && e.name === 'AbortError';
			if (!isAbort) console.error('Failed to load more puzzles:', e);
			if (controller.signal.aborted) return;
			loadMoreError = true;
		} finally {
			if (loadMoreController === controller) {
				loadMoreController = null;
				loadingMore = false;
			}
		}
	}

	// Observe the scroll sentinel and trigger the next page load when it
	// scrolls into view. Re-creates the observer whenever the sentinel
	// element binding changes (e.g. when the puzzles section appears).
	$effect(() => {
		const sentinel = scrollSentinel;
		if (!sentinel) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && !loadMoreError && !loadingMore && hasMore) {
					void loadNextPuzzles();
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	async function saveName() {
		saving = true;
		saveError = false;
		try {
			await updatePlayerProfile({ displayName });
			editing = false;
			await loadAll();
		} catch (e) {
			console.error('Failed to save display name:', e);
			saveError = true;
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
		avatarError = false;
		try {
			await uploadPlayerAvatar(file);
			await loadAll();
		} catch (e) {
			console.error('Failed to upload avatar:', e);
			avatarError = true;
		} finally {
			// Reset the input so selecting the same file again still fires a
			// change event (needed to retry a failed upload).
			input.value = '';
		}
	}
</script>

{#if loading}
	<p data-testid="profile-loading">Loading…</p>
{:else if loadError}
	<section class="mx-auto max-w-4xl px-4 py-8">
		<p data-testid="profile-error" class="text-(--text-1)">Failed to load your profile.</p>
		<button type="button" class="mt-3 text-sm text-(--accent)" onclick={loadAll}>Try again</button>
	</section>
{:else if profile}
	<section class="mx-auto max-w-4xl px-4 py-8">
		<div class="flex items-center gap-4 border border-(--border) bg-(--bg-1) p-5">
			{#if profile.picture}
				<img src={profile.picture} alt={profile.name} class="h-16 w-16 rounded-full object-cover" />
			{:else}
				<div
					class="flex h-16 w-16 items-center justify-center rounded-full bg-(--bg-2) text-(--accent)"
				>
					{initials}
				</div>
			{/if}
			<div class="min-w-0">
				{#if editing}
					<input
						data-testid="display-name-input"
						bind:value={displayName}
						class="border border-(--border) bg-(--bg-2) px-2 py-1 text-(--text-0)"
					/>
					<button type="button" onclick={saveName} disabled={saving}>Save</button>
					<button type="button" data-testid="cancel-edit" onclick={cancelEditing}>Cancel</button>
					{#if saveError}
						<p data-testid="save-name-error" class="mt-1 text-xs text-(--hot)">
							Failed to save name. Try again.
						</p>
					{/if}
				{:else}
					<h1 class="font-(--font-display) text-(--text-0)" data-testid="profile-name">
						{profile.name}
					</h1>
					<p class="text-sm text-(--text-2)">{profile.email}</p>
				{/if}
				<input
					bind:this={avatarInput}
					data-testid="avatar-input"
					type="file"
					accept="image/*"
					onchange={onAvatarChosen}
					class="mt-2 text-xs text-(--text-2)"
				/>
				{#if avatarError}
					<p data-testid="avatar-upload-error" class="mt-1 text-xs text-(--hot)">
						Failed to upload avatar. Try again.
					</p>
				{/if}
			</div>
		</div>

		<div class="mt-6 grid grid-cols-3 gap-3 text-center">
			<div class="border border-(--border) bg-(--bg-1) p-4">
				<div class="text-xl font-bold text-(--accent)">
					{profile.summary.puzzlesUploaded}
				</div>
				<div class="text-xs tracking-wider text-(--text-2) uppercase">Uploaded</div>
			</div>
			<div class="border border-(--border) bg-(--bg-1) p-4">
				<div class="text-xl font-bold text-(--accent)">
					{profile.summary.puzzlesSolved}
				</div>
				<div class="text-xs tracking-wider text-(--text-2) uppercase">Solved</div>
			</div>
			<div class="border border-(--border) bg-(--bg-1) p-4">
				<div class="text-xl font-bold text-(--accent)">
					{profile.summary.totalCompletions}
				</div>
				<div class="text-xs tracking-wider text-(--text-2) uppercase">Completions</div>
			</div>
		</div>

		<button
			type="button"
			class="mt-4 text-sm text-(--accent)"
			onclick={() => (editing ? cancelEditing() : (editing = true))}
		>
			{editing ? 'Cancel' : 'Edit profile'}
		</button>

		<h2 class="mt-8 font-(--font-display) text-(--text-0)">My Puzzles</h2>
		{#if puzzles.length === 0}
			<p class="text-sm text-(--text-2)">You haven't uploaded any puzzles yet.</p>
		{:else}
			<div class="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
				{#each puzzles as p (p.id)}
					<PuzzleCard puzzle={toCard(p)} />
				{/each}
			</div>

			{#if loadingMore}
				<div class="mt-4 flex justify-center py-4" data-testid="profile-load-more-spinner">
					<div
						class="h-6 w-6 rounded-full border-2 border-(--border) border-t-(--accent)
motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none"
					></div>
				</div>
			{:else if loadMoreError}
				<div class="mt-4 flex justify-center" data-testid="profile-load-more-error">
					<button
						type="button"
						onclick={() => void loadNextPuzzles()}
						class="border border-(--hot) px-4 py-1.5 text-xs text-(--hot) uppercase
hover:bg-[rgba(255,0,102,0.08)]"
					>
						Retry
					</button>
				</div>
			{/if}

			<div
				bind:this={scrollSentinel}
				data-testid="profile-scroll-sentinel"
				class="h-px"
				aria-hidden="true"
			></div>
		{/if}

		<h2 class="mt-8 font-(--font-display) text-(--text-0)">Best Times</h2>
		{#if stats.length === 0}
			<p class="text-sm text-(--text-2)">No solves recorded yet.</p>
		{:else}
			<ul class="mt-3 divide-y divide-(--border)">
				{#each stats as s (s.puzzleId)}
					<li class="flex items-center justify-between gap-3 py-2 text-sm">
						{#if s.puzzleName}
							<a href={resolve(`/puzzle/${s.puzzleId}`)} class="min-w-0 truncate text-(--text-1)">
								{s.puzzleName}
							</a>
						{:else}
							<span class="min-w-0 truncate text-(--text-2)">
								{s.puzzleId}
							</span>
						{/if}
						<span class="shrink-0 text-xs text-(--text-2)">
							{s.totalCompletions}×
						</span>
						<span class="shrink-0 font-(--font-mono) text-(--gold)">
							{formatTime(s.bestTimeSeconds)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
