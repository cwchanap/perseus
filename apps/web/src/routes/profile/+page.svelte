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

	const initials = $derived(
		(profile?.name ?? '?')
			.split(' ')
			.filter((p) => p.length > 0)
			.map((p) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase() || '?'
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
		// The profile +layout.svelte guards auth: it only renders this page
		// when playerAuth is authenticated, and redirects to /login on
		// anonymous/logout. So by the time this onMount runs the session is
		// valid — just load the data. The layout handles all redirect logic.
		void loadAll();
	});

	async function loadAll() {
		loading = true;
		loadError = false;
		// Use allSettled so a failure in puzzles/stats doesn't hide a successfully
		// loaded profile: the profile is essential (its failure surfaces the error
		// screen), while puzzle/stat failures degrade gracefully to empty lists.
		const [profileRes, puzzlesRes, statsRes] = await Promise.allSettled([
			getPlayerProfile(),
			getPlayerPuzzles(),
			getPlayerStats()
		]);
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
			puzzles = puzzlesRes.value.puzzles;
			puzzlesCursor = puzzlesRes.value.nextCursor;
		} else {
			puzzles = [];
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
		loading = false;
	}

	// Append the next page of puzzles. The API omits nextCursor when no more rows
	// exist; when undefined, the "Load more" button isn't rendered. loadingMorePuzzles
	// guards against a double-click appending the same page twice.
	async function loadMorePuzzles() {
		if (loadingMorePuzzles || puzzlesCursor === undefined) return;
		const cursor = puzzlesCursor;
		loadingMorePuzzles = true;
		try {
			const r = await getPlayerPuzzles({ cursor });
			puzzles = [...puzzles, ...r.puzzles];
			puzzlesCursor = r.nextCursor;
		} catch (error) {
			console.error('Failed to load more puzzles:', error);
		} finally {
			loadingMorePuzzles = false;
		}
	}

	async function loadMoreStats() {
		if (loadingMoreStats || statsCursor === undefined) return;
		const cursor = statsCursor;
		loadingMoreStats = true;
		try {
			const r = await getPlayerStats({ cursor });
			stats = [...stats, ...r.stats];
			statsCursor = r.nextCursor;
		} catch (error) {
			console.error('Failed to load more stats:', error);
		} finally {
			loadingMoreStats = false;
		}
	}

	// Refetch only the profile after a name/avatar mutation. Puzzles and stats
	// are unaffected by those edits, so a full loadAll() would waste two extra
	// requests and briefly flicker the lists.
	async function loadProfile() {
		try {
			profile = await getPlayerProfile();
			displayName = profile?.name ?? '';
		} catch (error) {
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
			await uploadPlayerAvatar(file);
			saveError = null;
			await loadProfile();
		} catch (error) {
			console.error('Failed to upload avatar:', error);
			saveError = 'Failed to upload avatar. Please try again.';
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
					<button
						type="button"
						data-testid="reset-name"
						onclick={resetName}
						disabled={saving}
						class="text-sm text-(--text-2)"
					>
						Reset to Google default
					</button>
				{:else}
					<h1 class="font-(--font-display) text-(--text-0)" data-testid="profile-name">
						{profile.name}
					</h1>
					<p class="text-sm text-(--text-2)">{profile.email}</p>
					<p class="text-xs text-(--text-2)" data-testid="profile-join-date">
						Joined {new Date(profile.createdAt).toLocaleDateString()}
					</p>
					<p class="text-xs text-(--text-2)" data-testid="profile-last-login">
						Last login {new Date(profile.lastLoginAt).toLocaleString()}
					</p>
				{/if}
				<input
					data-testid="avatar-input"
					type="file"
					accept="image/*"
					onchange={onAvatarChosen}
					class="mt-2 text-xs text-(--text-2)"
				/>
			</div>
		</div>

		{#if saveError}
			<p data-testid="profile-save-error" class="mt-2 text-sm text-red-500">{saveError}</p>
		{/if}

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
			{#if puzzlesCursor !== undefined}
				<button
					type="button"
					data-testid="load-more-puzzles"
					class="mt-4 text-sm text-(--accent) disabled:opacity-50"
					onclick={loadMorePuzzles}
					disabled={loadingMorePuzzles}
				>
					{loadingMorePuzzles ? 'Loading…' : 'Load more'}
				</button>
			{/if}
		{/if}

		<h2 class="mt-8 font-(--font-display) text-(--text-0)">Best Times</h2>
		{#if stats.length === 0}
			<p class="text-sm text-(--text-2)">No solves recorded yet.</p>
		{:else}
			<ul class="mt-3 divide-y divide-(--border)" data-testid="best-times-list">
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
			{#if statsCursor !== undefined}
				<button
					type="button"
					data-testid="load-more-stats"
					class="mt-4 text-sm text-(--accent) disabled:opacity-50"
					onclick={loadMoreStats}
					disabled={loadingMoreStats}
				>
					{loadingMoreStats ? 'Loading…' : 'Load more'}
				</button>
			{/if}
		{/if}
	</section>
{/if}
