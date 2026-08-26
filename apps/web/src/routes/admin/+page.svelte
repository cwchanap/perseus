<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		ApiError,
		addPlayerAllowlistEntry,
		deletePuzzle,
		fetchAdminPuzzles,
		fetchPlayerAllowlist,
		getThumbnailUrl,
		removePlayerAllowlistEntry
	} from '$lib/services/api';
	import { createSessionStorageAdapter } from '$lib/services/gameplay/session/persistence';
	import type { PlayerAllowlistEntry, PuzzleSummary } from '$lib/types/puzzle';

	// Reuses the session persistence adapter so the localStorage key prefix
	// (puzzle-progress-) stays encapsulated in one place. Admin only needs the
	// best-effort clear after a delete; no session-awareness required.
	const sessionStorageAdapter = createSessionStorageAdapter();

	let puzzles: PuzzleSummary[] = $state([]);
	let loadingPuzzles = $state(true);
	let puzzlesError: string | null = $state(null);
	let puzzlesFetchInFlight = $state(false);
	let allowlist: PlayerAllowlistEntry[] = $state([]);
	let allowlistEmail = $state('');
	let loadingAllowlist = $state(true);
	let allowlistError: string | null = $state(null);
	let allowlistSaving = $state(false);
	let removingAllowlistEmail: string | null = $state(null);
	let allowlistLoadSequence = 0;
	let successMessage: string | null = $state(null);
	let successTimeout: ReturnType<typeof setTimeout> | null = null;
	let deletingId: string | null = $state(null);
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let mounted = false;

	onMount(async () => {
		mounted = true;
		void loadAllowlist();
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
		const hasProcessing = puzzles.some((p) => p.status === 'processing');
		if (hasProcessing && pollInterval === null) {
			pollInterval = setInterval(async () => {
				if (!mounted || puzzlesFetchInFlight) return;
				puzzlesFetchInFlight = true;
				try {
					const latestPuzzles = await loadPuzzles(true);
					if (!mounted) return;
					const stillProcessing = latestPuzzles.some((p) => p.status === 'processing');
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
		} catch (e) {
			console.error('Failed to load puzzles', e);
			if (!silent) {
				puzzlesError = e instanceof ApiError ? e.message : 'Failed to load puzzles';
				puzzles = [];
			}
			return puzzles;
		} finally {
			if (!silent) {
				loadingPuzzles = false;
			}
		}
	}

	async function loadAllowlist(): Promise<PlayerAllowlistEntry[]> {
		const loadSequence = ++allowlistLoadSequence;
		loadingAllowlist = true;
		allowlistError = null;
		try {
			const latestAllowlist = await fetchPlayerAllowlist();
			if (loadSequence !== allowlistLoadSequence) return allowlist;
			allowlist = latestAllowlist;
			return latestAllowlist;
		} catch (e) {
			console.error('Failed to load player access', e);
			if (loadSequence !== allowlistLoadSequence) return allowlist;
			allowlistError = e instanceof ApiError ? e.message : 'Failed to load player access';
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
		} catch (e) {
			console.error('Failed to add player', e);
			allowlistError = e instanceof ApiError ? e.message : 'Failed to add player';
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
		} catch (e) {
			console.error('Failed to remove player', e);
			allowlistError = e instanceof ApiError ? e.message : 'Failed to remove player';
		} finally {
			removingAllowlistEmail = null;
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
		} catch (e) {
			const message = e instanceof ApiError ? e.message : 'Failed to delete puzzle';
			alert(message);
		} finally {
			deletingId = null;
		}
	}
</script>

<svelte:head>
	<title>Admin Portal | Perseus</title>
</svelte:head>

<main
	class="min-h-screen bg-(--bg-0)
[background-image:linear-gradient(rgba(0,240,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.02)_1px,transparent_1px)]
[background-size:40px_40px]"
>
	<div class="mx-auto max-w-[80rem] px-6 pt-8 pb-16 sm:px-8">
		<header class="flex flex-wrap items-end justify-between gap-4 py-4">
			<div>
				<div
					class="mb-1 text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
				>
					// PERSEUS ADMIN
				</div>
				<h1
					class="text-[clamp(1.25rem,4vw,2rem)] font-(--font-display) font-black tracking-[0.1em] text-(--text-0)"
				>
					CONTROL PANEL
				</h1>
			</div>
			<div class="flex items-center gap-3">
				<a
					href={resolve('/upload')}
					class="text-[0.58rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--accent)
transition-colors duration-150 hover:text-(--text-0)"
				>
					UPLOAD
				</a>
				<a
					href={resolve('/')}
					class="text-[0.58rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)"
				>
					VIEW ARCADE
				</a>
			</div>
		</header>

		<div
			class="mb-8 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] opacity-30"
		></div>

		{#if successMessage}
			<div
				class="mb-4 border border-[rgba(0,255,136,0.4)] bg-[rgba(0,255,136,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) tracking-[0.05em] text-(--green)"
				role="status"
			>
				{successMessage}
			</div>
		{/if}

		<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
			<div class="border border-(--border) bg-(--bg-1)">
				<div
					class="flex items-center justify-between border-b border-(--border) bg-(--bg-2) px-4 py-3"
				>
					<span
						class="text-[0.6rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
					>
						MISSION DATABASE
					</span>
					<span class="text-[0.6rem] font-(--font-mono) tracking-[0.1em] text-(--accent)">
						{puzzles.length} TOTAL
					</span>
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
				{:else}
					<div class="flex flex-col">
						{#each puzzles as puzzle (puzzle.id)}
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
										<span
											class="text-[0.65rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)"
										>
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
									title={puzzle.status === 'processing'
										? 'Force delete stuck puzzle'
										: 'Delete puzzle'}
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
					</div>
				{/if}
			</div>

			<div class="border border-(--border) bg-(--bg-1)">
				<div
					class="flex items-center justify-between border-b border-(--border) bg-(--bg-2) px-4 py-3"
				>
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
							disabled={allowlistSaving ||
								removingAllowlistEmail !== null ||
								!allowlistEmail.trim()}
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
										<span
											class="text-[0.65rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)"
										>
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
		</div>
	</div>
</main>
