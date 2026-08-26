<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ApiError,
		addPlayerAllowlistEntry,
		fetchPlayerAllowlist,
		removePlayerAllowlistEntry
	} from '$lib/services/api';
	import type { PlayerAllowlistEntry } from '$lib/types/puzzle';

	let allowlist: PlayerAllowlistEntry[] = $state([]);
	let allowlistEmail = $state('');
	let loadingAllowlist = $state(true);
	let allowlistError: string | null = $state(null);
	let allowlistSaving = $state(false);
	let removingAllowlistEmail: string | null = $state(null);
	let allowlistLoadSequence = 0;

	onMount(() => {
		void loadAllowlist();
	});

	async function loadAllowlist(): Promise<PlayerAllowlistEntry[]> {
		const loadSequence = ++allowlistLoadSequence;
		loadingAllowlist = true;
		allowlistError = null;
		try {
			const latestAllowlist = await fetchPlayerAllowlist();
			if (loadSequence !== allowlistLoadSequence) return allowlist;
			allowlist = latestAllowlist;
			return latestAllowlist;
		} catch (error) {
			console.error('Failed to load player access', error);
			if (loadSequence !== allowlistLoadSequence) return allowlist;
			allowlistError = error instanceof ApiError ? error.message : 'Failed to load player access';
			allowlist = [];
			return [];
		} finally {
			if (loadSequence === allowlistLoadSequence) {
				loadingAllowlist = false;
			}
		}
	}

	async function handleAllowlistSubmit(event: Event) {
		event.preventDefault();
		const email = allowlistEmail.trim();
		if (!email) return;

		allowlistSaving = true;
		allowlistError = null;
		try {
			await addPlayerAllowlistEntry(email);
			allowlistEmail = '';
			await loadAllowlist();
		} catch (error) {
			console.error('Failed to add player', error);
			allowlistError = error instanceof ApiError ? error.message : 'Failed to add player';
		} finally {
			allowlistSaving = false;
		}
	}

	async function handleAllowlistRemove(email: string) {
		removingAllowlistEmail = email;
		allowlistError = null;
		try {
			await removePlayerAllowlistEntry(email);
			await loadAllowlist();
		} catch (error) {
			console.error('Failed to remove player', error);
			allowlistError = error instanceof ApiError ? error.message : 'Failed to remove player';
		} finally {
			removingAllowlistEmail = null;
		}
	}
</script>

<div class="border border-(--border) bg-(--bg-1)">
	<div class="flex items-center justify-between border-b border-(--border) bg-(--bg-2) px-4 py-3">
		<span
			class="text-[0.6rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
		>
			PLAYER ACCESS
		</span>
		<span class="text-[0.6rem] font-(--font-mono) tracking-[0.1em] text-(--accent)">
			{allowlist.length} ALLOWED
		</span>
	</div>

	<div class="flex flex-col gap-4 p-5">
		<form onsubmit={handleAllowlistSubmit} class="flex flex-col gap-3 sm:flex-row">
			<input
				type="email"
				aria-label="Player email"
				bind:value={allowlistEmail}
				class="min-w-0 flex-1 border border-(--border) bg-(--bg-0) px-3.5 py-2.5
text-[0.8rem] font-(--font-mono) text-(--text-0)
transition-[border-color,box-shadow] duration-150 placeholder:text-(--text-2)
focus:border-(--accent) focus:[box-shadow:0_0_12px_var(--accent-glow)]
focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
				placeholder="player@example.com"
				disabled={allowlistSaving}
			/>
			<button
				type="submit"
				disabled={allowlistSaving || removingAllowlistEmail !== null || !allowlistEmail.trim()}
				class="border border-(--accent) px-4 py-2.5 text-[0.6rem]
font-(--font-display) font-bold tracking-[0.2em] text-(--accent)
transition-all duration-200 hover:bg-(--accent-glow)
disabled:cursor-not-allowed disabled:opacity-40"
			>
				{allowlistSaving ? 'ADDING...' : 'ADD PLAYER'}
			</button>
		</form>

		{#if allowlistError}
			<div
				class="border border-(--hot-dim) bg-[rgba(255,0,102,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) tracking-[0.05em] text-(--hot)"
				role="alert"
			>
				{allowlistError}
			</div>
		{/if}

		{#if loadingAllowlist}
			<div
				class="border border-(--border) bg-(--bg-0) px-4 py-6 text-center
text-[0.72rem] font-(--font-mono) tracking-[0.08em] text-(--text-2)"
			>
				LOADING ACCESS LIST...
			</div>
		{:else if allowlist.length === 0}
			<div
				class="border border-(--border) bg-(--bg-0) px-4 py-6 text-center
text-[0.72rem] font-(--font-mono) tracking-[0.08em] text-(--text-2)"
			>
				No players allowlisted.
			</div>
		{:else}
			<div class="flex flex-col border border-(--border) bg-(--bg-0)">
				{#each allowlist as entry (entry.email)}
					<div
						class="flex flex-col gap-3 border-b border-(--border) px-4 py-3
last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
					>
						<div class="flex min-w-0 flex-col gap-[0.2rem]">
							<span
								class="truncate text-[0.8rem] font-(--font-mono) tracking-[0.03em] text-(--text-0)"
							>
								{entry.email}
							</span>
							<span class="text-[0.65rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
								{entry.player?.name ?? 'No account created'}
							</span>
						</div>

						<button
							type="button"
							onclick={() => handleAllowlistRemove(entry.email)}
							disabled={allowlistSaving || removingAllowlistEmail !== null}
							class="shrink-0 border border-(--hot-dim) px-2.5 py-[0.35rem]
text-[0.55rem] font-(--font-display) font-semibold tracking-[0.15em]
text-(--hot) transition-all duration-150 hover:border-(--hot)
hover:bg-(--hot-glow) disabled:cursor-not-allowed disabled:opacity-40"
						>
							{removingAllowlistEmail === entry.email ? '...' : 'REMOVE'}
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
