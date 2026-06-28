<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { playerAuth } from '$lib/stores/playerAuth';
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
	let avatarInput = $state<HTMLInputElement | null>(null);

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
			status: p.status as PuzzleSummary['status'],
			...(p.category ? { category: p.category as PuzzleSummary['category'] } : {})
		};
	}

	onMount(() => {
		// The root layout already calls playerAuth.refresh() on mount.
		// Subscribe and wait for the store to settle (leave 'loading') before
		// deciding whether to redirect to login. Calling refresh() here would
		// race with the layout's call via the store's operationId guard.
		let settled = false;
		const unsubscribe = playerAuth.subscribe((state) => {
			if (settled || state.status === 'loading') return;
			settled = true;
			if (state.status !== 'authenticated') {
				goto(resolve('/login'));
				return;
			}
			void loadAll();
		});
		return unsubscribe;
	});

	async function loadAll() {
		loading = true;
		loadError = false;
		try {
			[profile, puzzles, stats] = await Promise.all([
				getPlayerProfile(),
				getPlayerPuzzles().then((r) => r.puzzles),
				getPlayerStats().then((r) => r.stats)
			]);
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

	async function saveName() {
		saving = true;
		try {
			await updatePlayerProfile({ displayName });
			editing = false;
			await loadAll();
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
			await loadAll();
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
		{/if}

		<h2 class="mt-8 font-(--font-display) text-(--text-0)">Best Times</h2>
		{#if stats.length === 0}
			<p class="text-sm text-(--text-2)">No solves recorded yet.</p>
		{:else}
			<ul class="mt-3 divide-y divide-(--border)">
				{#each stats as s (s.puzzleId)}
					<li class="flex justify-between py-2 text-sm">
						<a href={resolve(`/puzzle/${s.puzzleId}`)} class="text-(--text-1)">
							{s.puzzleId}
						</a>
						<span class="font-(--font-mono) text-(--gold)">
							{formatTime(s.bestTimeSeconds)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
