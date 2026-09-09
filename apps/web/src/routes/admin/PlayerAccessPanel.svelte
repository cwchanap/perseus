<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ApiError,
		addPlayerAllowlistEntry,
		fetchPlayerAllowlist,
		removePlayerAllowlistEntry
	} from '$lib/services/api';
	import type { PlayerAllowlistEntry } from '$lib/types/puzzle';

	interface PlayerAccessPanelProps {
		active?: boolean;
		onCountChange?: (count: number) => void;
	}

	let { active = true, onCountChange }: PlayerAccessPanelProps = $props();

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
			onCountChange?.(latestAllowlist.length);
			return latestAllowlist;
		} catch (error) {
			console.error('Failed to load player access', error);
			if (loadSequence !== allowlistLoadSequence) return allowlist;
			allowlistError = error instanceof ApiError ? error.message : 'Failed to load player access';
			allowlist = [];
			onCountChange?.(0);
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

<div data-active={active} class="flex min-h-full min-w-0 flex-col">
	<div class="flex flex-wrap items-end justify-between gap-4 pb-2">
		<div>
			<h2
				class="text-[clamp(1.25rem,3vw,1.7rem)] font-(--font-display) font-black tracking-[0.08em] text-(--text-0)"
				style="font-family: var(--font-display)"
			>
				PLAYER ACCESS
			</h2>
			<p
				class="mt-1 text-[0.95rem] font-(--font-body) font-semibold tracking-[0.02em] text-(--text-2)"
			>
				Only allowlisted emails can sign in
			</p>
		</div>
		<span
			data-testid="player-count"
			class="rounded-full border border-(--green-dim) bg-[rgba(0,255,136,0.08)] px-3 py-1.5 text-[0.62rem]
			font-(--font-display) font-bold tracking-[0.1em] text-(--green)"
		>
			<span class="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-(--green)" aria-hidden="true"
			></span>
			{allowlist.length} ALLOWED
		</span>
	</div>

	<div class="flex min-h-0 flex-1 flex-col gap-4 pt-1">
		<form
			onsubmit={handleAllowlistSubmit}
			class="flex w-full max-w-[714px] flex-col gap-3 sm:flex-row"
		>
			<label class="sr-only" for="player-email">Player email</label>
			<input
				id="player-email"
				type="email"
				aria-label="Player email"
				bind:value={allowlistEmail}
				class="min-w-0 flex-1 rounded-[18px] border border-(--border-bright) bg-(--bg-0) px-4 py-3
				text-[0.95rem] font-(--font-body) font-semibold tracking-[0.03em] text-(--text-0)
				transition-[border-color,box-shadow] duration-150 placeholder:text-(--text-2)
				focus:border-(--accent) focus:[box-shadow:0_0_12px_var(--accent-glow)] focus:outline-none
				disabled:cursor-not-allowed disabled:opacity-50"
				placeholder="player@example.com"
				disabled={allowlistSaving}
			/>
			<button
				type="submit"
				disabled={allowlistSaving || removingAllowlistEmail !== null || !allowlistEmail.trim()}
				class="inline-flex h-[47px] w-full shrink-0 items-center justify-center gap-2 rounded-[18px]
				border border-(--accent) bg-[linear-gradient(160deg,#5affff,#00c2dc)]
				px-5 py-3 text-[0.65rem] font-(--font-display) font-black
				tracking-[0.12em] text-[#03202a] shadow-[0_4px_0_#00707f] transition-all
				duration-200 hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40 sm:w-[183px]"
			>
				<svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
					<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
				</svg>
				{allowlistSaving ? 'ADDING...' : 'ADD PLAYER'}
			</button>
		</form>

		{#if allowlistError}
			<div
				class="rounded-xl border border-(--hot-dim) bg-[rgba(255,0,102,0.06)] px-4 py-3
				text-sm font-(--font-body) font-semibold tracking-[0.04em] text-(--hot)"
				role="alert"
			>
				{allowlistError}
			</div>
		{/if}

		{#if loadingAllowlist}
			<div
				class="rounded-xl border border-(--border) bg-(--bg-0) px-4 py-8 text-center
				text-sm font-(--font-body) font-semibold tracking-[0.06em] text-(--text-2)"
			>
				LOADING ACCESS LIST...
			</div>
		{:else if allowlist.length === 0}
			<div
				class="rounded-xl border border-(--border) bg-(--bg-0) px-4 py-8 text-center
				text-sm font-(--font-body) font-semibold tracking-[0.06em] text-(--text-2)"
			>
				No players allowlisted.
			</div>
		{:else}
			<div
				data-testid="player-access-table"
				class="flex min-h-0 min-h-[340px] flex-1 overflow-x-auto rounded-2xl border border-(--border) bg-[rgba(10,7,28,0.46)]"
			>
				<div class="min-h-full min-w-[560px] flex-1">
					<div
						class="grid grid-cols-[44px_minmax(160px,1fr)_220px_56px] items-center gap-4 border-b border-(--border)
						bg-(--bg-2) px-4 py-3 text-xs font-(--font-body) font-bold tracking-[0.1em] text-(--text-2) uppercase"
					>
						<span></span>
						<span>Email</span>
						<span>Account</span>
						<span class="text-right">Actions</span>
					</div>
					{#each allowlist as entry (entry.email)}
						<div
							class="grid grid-cols-[44px_minmax(160px,1fr)_220px_56px] items-center gap-4 border-b border-[rgba(44,28,96,0.7)]
						px-4 py-3.5 last:border-b-0"
						>
							<div
								class="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(160deg,#ff5cc0,#e0148c)]
							text-xs font-(--font-display) font-bold text-white"
								aria-hidden="true"
							>
								{entry.email.slice(0, 2).toUpperCase()}
							</div>
							<div
								class="min-w-0 truncate text-[0.95rem] font-(--font-body) font-semibold tracking-[0.02em] text-(--text-0)"
							>
								{entry.email}
							</div>
							<div
								class="truncate text-sm font-(--font-body) font-semibold tracking-[0.02em] text-(--text-2)"
							>
								{entry.player?.name ?? 'No account created'}
							</div>
							<div class="flex justify-end">
								<button
									type="button"
									aria-label={`Remove ${entry.email}`}
									title={`Remove ${entry.email}`}
									onclick={() => handleAllowlistRemove(entry.email)}
									disabled={allowlistSaving || removingAllowlistEmail !== null}
									class="flex h-11 w-11 items-center justify-center rounded-xl border border-(--hot-dim)
								bg-[rgba(255,0,102,0.1)] text-(--hot) transition-colors hover:border-(--hot)
								hover:bg-(--hot-glow) focus-visible:outline-2 focus-visible:outline-(--hot)
								disabled:cursor-not-allowed disabled:opacity-40"
								>
									<svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
										<path d="M5 11h14v2H5z" />
									</svg>
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>
