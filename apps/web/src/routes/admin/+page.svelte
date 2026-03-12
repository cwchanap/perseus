<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		logout,
		createPuzzle,
		deletePuzzle,
		fetchAdminPuzzles,
		getThumbnailUrl,
		ApiError
	} from '$lib/services/api';
	import { clearProgress } from '$lib/services/progress';
	import { PUZZLE_CATEGORIES, type PuzzleCategory } from '$lib/constants/categories';
	import type { PuzzleSummary } from '$lib/types/puzzle';
	import { resolve } from '$app/paths';

	const ALLOWED_PIECE_COUNT = 225; // 15x15 grid

	let loggingOut = $state(false);
	let logoutError: string | null = $state(null);
	let puzzles: PuzzleSummary[] = $state([]);
	let loadingPuzzles = $state(true);
	let puzzlesError: string | null = $state(null);
	let puzzlesFetchInFlight = $state(false);

	// Form state
	let name = $state('');
	let category: PuzzleCategory | '' = $state('');
	let pieceCount = $state(ALLOWED_PIECE_COUNT);
	let imageFile: File | null = $state(null);
	let imagePreview: string | null = $state(null);
	let imageInput: HTMLInputElement | null = $state(null);
	let creating = $state(false);
	let formError: string | null = $state(null);
	let successMessage: string | null = $state(null);
	let successTimeout: ReturnType<typeof setTimeout> | null = null;

	// Delete state
	let deletingId: string | null = $state(null);

	// Polling interval for processing puzzles
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let mounted = false;

	onMount(async () => {
		mounted = true;
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

	function startPollingIfNeeded() {
		// Check if any puzzles are processing
		const hasProcessing = puzzles.some((p) => p.status === 'processing');
		if (hasProcessing && pollInterval === null) {
			pollInterval = setInterval(async () => {
				if (!mounted) return;
				if (puzzlesFetchInFlight) return;
				puzzlesFetchInFlight = true;
				try {
					const latestPuzzles = await loadPuzzles(true);
					if (!mounted) return;
					// Stop polling if no more processing puzzles
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
			}, 3000); // Poll every 3 seconds
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
				return [];
			}
			return puzzles;
		} finally {
			if (!silent) {
				loadingPuzzles = false;
			}
		}
	}

	async function handleLogout() {
		loggingOut = true;
		logoutError = null;

		try {
			await logout();
			goto(resolve('/admin/login'));
		} catch (e) {
			console.error('Failed to logout', e);
			logoutError = 'Failed to logout';
		} finally {
			loggingOut = false;
		}
	}

	function clearSelectedImage() {
		imageFile = null;
		imagePreview = null;
		if (imageInput) {
			imageInput.value = '';
		}
	}

	function handleImageSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (file) {
			imageFile = file;
			const reader = new FileReader();
			reader.onload = (e) => {
				imagePreview = e.target?.result as string;
			};
			reader.onerror = () => {
				console.error('Failed to read image for preview', reader.error);
				clearSelectedImage();
				formError = 'Failed to load image preview';
			};
			reader.onabort = () => {
				clearSelectedImage();
				formError = 'Image preview was aborted';
			};
			reader.readAsDataURL(file);
		}
	}

	function clearForm() {
		name = '';
		category = '';
		pieceCount = ALLOWED_PIECE_COUNT;
		clearSelectedImage();
		formError = null;
	}

	async function handleSubmit(event: Event) {
		event.preventDefault();
		formError = null;
		successMessage = null;

		if (!name.trim()) {
			formError = 'Please enter a puzzle name';
			return;
		}

		if (!imageFile) {
			formError = 'Please select an image';
			return;
		}

		creating = true;

		try {
			await createPuzzle(name.trim(), pieceCount, imageFile, category || undefined);
			successMessage = 'Puzzle creation started! It will appear below once processing begins.';
			clearForm();
			await loadPuzzles();
			startPollingIfNeeded();

			if (successTimeout !== null) clearTimeout(successTimeout);
			successTimeout = setTimeout(() => {
				successMessage = null;
				successTimeout = null;
			}, 3000);
		} catch (e) {
			if (e instanceof ApiError) {
				formError = e.message;
			} else {
				formError = 'Failed to create puzzle';
			}
		} finally {
			creating = false;
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
			clearProgress(puzzleId);
			if (deleteResult && 'partialSuccess' in deleteResult && deleteResult.partialSuccess) {
				successMessage = deleteResult.warning;
				if (successTimeout !== null) clearTimeout(successTimeout);
				successTimeout = setTimeout(() => {
					successMessage = null;
					successTimeout = null;
				}, 5000);
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
					href={resolve('/')}
					class="text-[0.58rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)"
				>
					VIEW ARCADE
				</a>
				<button
					onclick={handleLogout}
					disabled={loggingOut}
					class="border border-(--hot-dim) px-[0.875rem] py-[0.4rem] text-[0.58rem]
font-(--font-display) font-semibold tracking-[0.15em] text-(--hot)
transition-all duration-200 hover:border-(--hot) hover:bg-(--hot-glow)
disabled:cursor-not-allowed disabled:opacity-50"
				>
					{loggingOut ? 'LOGGING OUT...' : 'LOGOUT'}
				</button>
			</div>
		</header>

		<div
			class="mb-8 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] opacity-30"
		></div>

		{#if logoutError}
			<div
				class="mb-4 border border-(--hot-dim) bg-[rgba(255,0,102,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) tracking-[0.05em] text-(--hot)"
				role="alert"
			>
				{logoutError}
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
						CREATE MISSION
					</span>
				</div>

				{#if successMessage}
					<div
						class="m-4 mb-0 border border-[rgba(0,255,136,0.4)] bg-[rgba(0,255,136,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) tracking-[0.05em] text-(--green)"
						role="status"
					>
						{successMessage}
					</div>
				{/if}

				{#if formError}
					<div
						class="m-4 mb-0 border border-(--hot-dim) bg-[rgba(255,0,102,0.06)] px-4 py-3
text-[0.72rem] font-(--font-mono) tracking-[0.05em] text-(--hot)"
						role="alert"
					>
						{formError}
					</div>
				{/if}

				<form onsubmit={handleSubmit} class="flex flex-col gap-5 p-5">
					<div class="flex flex-col gap-1.5">
						<label
							for="name"
							class="text-[0.55rem] font-(--font-display) font-semibold tracking-[0.2em]
text-(--text-2)"
						>
							PUZZLE NAME
						</label>
						<input
							id="name"
							type="text"
							bind:value={name}
							class="w-full border border-(--border) bg-(--bg-0) px-3.5 py-2.5
text-[0.8rem] font-(--font-mono) text-(--text-0)
transition-[border-color,box-shadow] duration-150 placeholder:text-(--text-2)
focus:border-(--accent) focus:[box-shadow:0_0_12px_var(--accent-glow)]
focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
							placeholder="Enter puzzle name"
							disabled={creating}
						/>
					</div>

					<div class="flex flex-col gap-1.5">
						<span
							class="text-[0.55rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
						>
							PIECE COUNT
						</span>
						<div
							class="border border-(--border) bg-(--bg-0) px-3.5 py-2.5 text-[0.75rem] font-(--font-mono) text-(--text-2)"
						>
							{ALLOWED_PIECE_COUNT} pieces (15×15 grid)
						</div>
					</div>

					<div class="flex flex-col gap-1.5">
						<label
							for="category"
							class="text-[0.55rem] font-(--font-display) font-semibold tracking-[0.2em]
text-(--text-2)"
						>
							CATEGORY
							<span class="font-normal opacity-60">(OPTIONAL)</span>
						</label>
						<select
							id="category"
							bind:value={category}
							disabled={creating}
							class="w-full appearance-none border border-(--border) bg-(--bg-0) px-3.5 py-2.5
text-[0.8rem] font-(--font-mono) text-(--text-0)
transition-[border-color,box-shadow] duration-150 focus:border-(--accent)
focus:[box-shadow:0_0_12px_var(--accent-glow)] focus:outline-none
disabled:cursor-not-allowed disabled:opacity-50"
						>
							<option value="">No category</option>
							{#each PUZZLE_CATEGORIES as cat (cat)}
								<option value={cat}>{cat}</option>
							{/each}
						</select>
					</div>

					<div class="flex flex-col gap-1.5">
						<span
							id="image-label"
							class="text-[0.55rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
						>
							IMAGE
						</span>
						<div
							class="border border-dashed border-(--border-bright) bg-(--bg-0) p-6 transition-colors duration-150 hover:border-(--accent-dim)"
						>
							{#if imagePreview}
								<div class="relative flex justify-center">
									<img src={imagePreview} alt="Preview" class="max-h-48 object-contain" />
									<button
										type="button"
										onclick={clearSelectedImage}
										class="absolute top-0 right-0 flex items-center justify-center bg-(--hot) p-1
transition-opacity duration-150 hover:opacity-80"
										aria-label="Remove image"
									>
										<svg
											class="h-4 w-4 text-white"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
									</button>
								</div>
							{:else}
								<label
									for="image-upload"
									class="flex cursor-pointer flex-col items-center gap-2
focus-within:[outline:2px_solid_var(--accent)]
focus-within:[outline-offset:4px]"
								>
									<svg
										class="h-10 w-10 text-(--text-2)"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
										aria-hidden="true"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="1.5"
											d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
										/>
									</svg>
									<span
										class="text-[0.6rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--accent)"
									>
										CLICK TO UPLOAD
									</span>
									<span class="text-[0.62rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
										JPEG, PNG, WebP — max 10MB
									</span>
									<input
										id="image-upload"
										bind:this={imageInput}
										type="file"
										accept="image/jpeg,image/png,image/webp"
										class="sr-only"
										onchange={handleImageSelect}
										disabled={creating}
									/>
								</label>
							{/if}
						</div>
					</div>

					<button
						type="submit"
						disabled={creating || !name.trim() || !imageFile}
						class="w-full border border-(--accent) px-4 py-3 text-[0.65rem]
font-(--font-display) font-bold tracking-[0.2em] text-(--accent)
transition-all duration-200 hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] disabled:cursor-not-allowed
disabled:opacity-40"
					>
						{#if creating}
							<span class="flex items-center justify-center gap-2">
								<span
									class="h-3.5 w-3.5 rounded-full border-2 border-(--accent-dim)
border-t-(--accent) motion-safe:animate-[spin-cw_0.75s_linear_infinite]
motion-reduce:animate-none"
								></span>
								INITIALIZING...
							</span>
						{:else}
							CREATE MISSION
						{/if}
					</button>
				</form>
			</div>

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
						<p>No missions found. Create your first mission.</p>
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
											<svg
												class="h-5 w-5 text-(--hot)"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
												aria-hidden="true"
											>
												<path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M6 18L18 6M6 6l12 12"
												/>
											</svg>
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
		</div>
	</div>
</main>
