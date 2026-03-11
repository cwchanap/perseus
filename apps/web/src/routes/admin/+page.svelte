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

<main class="admin-main">
	<div class="admin-wrap">
		<!-- Header -->
		<header class="admin-header">
			<div class="admin-header-left">
				<div class="admin-sys-tag">// PERSEUS ADMIN</div>
				<h1 class="admin-title">CONTROL PANEL</h1>
			</div>
			<div class="admin-header-right">
				<a href={resolve('/')} class="admin-link">VIEW ARCADE</a>
				<button onclick={handleLogout} disabled={loggingOut} class="admin-btn-danger">
					{loggingOut ? 'LOGGING OUT...' : 'LOGOUT'}
				</button>
			</div>
		</header>

		<div class="admin-line"></div>

		{#if logoutError}
			<div class="admin-alert admin-alert--error">{logoutError}</div>
		{/if}

		<div class="admin-grid">
			<!-- Create Puzzle Form -->
			<div class="admin-panel">
				<div class="admin-panel-header">
					<span class="panel-tag">CREATE MISSION</span>
				</div>

				{#if successMessage}
					<div class="admin-alert admin-alert--success">{successMessage}</div>
				{/if}

				{#if formError}
					<div class="admin-alert admin-alert--error">{formError}</div>
				{/if}

				<form onsubmit={handleSubmit} class="admin-form">
					<!-- Puzzle Name -->
					<div class="field-group">
						<label for="name" class="field-label">PUZZLE NAME</label>
						<input
							id="name"
							type="text"
							bind:value={name}
							class="field-input"
							placeholder="Enter puzzle name"
							disabled={creating}
						/>
					</div>

					<!-- Piece Count (fixed at 225) -->
					<div class="field-group">
						<span class="field-label">PIECE COUNT</span>
						<div class="field-static">{ALLOWED_PIECE_COUNT} pieces (15×15 grid)</div>
					</div>

					<!-- Category -->
					<div class="field-group">
						<label for="category" class="field-label"
							>CATEGORY <span class="optional">(OPTIONAL)</span></label
						>
						<select id="category" bind:value={category} disabled={creating} class="field-select">
							<option value="">No category</option>
							{#each PUZZLE_CATEGORIES as cat (cat)}
								<option value={cat}>{cat}</option>
							{/each}
						</select>
					</div>

					<!-- Image Upload -->
					<div class="field-group">
						<span id="image-label" class="field-label">IMAGE</span>
						<div class="upload-zone">
							{#if imagePreview}
								<div class="preview-wrap">
									<img src={imagePreview} alt="Preview" class="preview-img" />
									<button
										type="button"
										onclick={clearSelectedImage}
										class="preview-remove"
										aria-label="Remove image"
									>
										<svg class="remove-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
								<label class="upload-label">
									<svg
										class="upload-icon"
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
									<span class="upload-text">CLICK TO UPLOAD</span>
									<span class="upload-sub">JPEG, PNG, WebP — max 10MB</span>
									<input
										bind:this={imageInput}
										type="file"
										accept="image/jpeg,image/png,image/webp"
										class="hidden"
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
						class="submit-btn"
					>
						{#if creating}
							<span class="btn-inner">
								<span class="btn-spinner"></span>
								INITIALIZING...
							</span>
						{:else}
							CREATE MISSION
						{/if}
					</button>
				</form>
			</div>

			<!-- Existing Puzzles -->
			<div class="admin-panel">
				<div class="admin-panel-header">
					<span class="panel-tag">MISSION DATABASE</span>
					<span class="panel-count">{puzzles.length} TOTAL</span>
				</div>

				{#if loadingPuzzles}
					<div class="panel-loading">
						<div class="panel-spinner"></div>
					</div>
				{:else if puzzlesError}
					<div class="admin-alert admin-alert--error">{puzzlesError}</div>
				{:else if puzzles.length === 0}
					<div class="panel-empty">
						<p>No missions found. Create your first mission.</p>
					</div>
				{:else}
					<div class="puzzle-list">
						{#each puzzles as puzzle (puzzle.id)}
							<div class="puzzle-row">
								<div class="puzzle-row-left">
									{#if puzzle.status === 'processing'}
										<div class="thumb-processing" role="status" aria-label="Processing puzzle">
											<div class="thumb-spinner"></div>
										</div>
									{:else if puzzle.status === 'failed'}
										<div class="thumb-failed" aria-label="Puzzle failed" role="img">
											<svg
												class="fail-icon"
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
										<img src={getThumbnailUrl(puzzle.id)} alt={puzzle.name} class="puzzle-thumb" />
									{/if}

									<div class="puzzle-info">
										<div class="puzzle-name-row">
											<span class="puzzle-name">{puzzle.name}</span>
											{#if puzzle.status === 'processing'}
												<span class="status-badge status-processing">PROCESSING</span>
											{:else if puzzle.status === 'failed'}
												<span class="status-badge status-failed">FAILED</span>
											{:else}
												<span class="status-badge status-ready">READY</span>
											{/if}
										</div>
										<span class="puzzle-meta">
											{puzzle.pieceCount} pieces
											{#if puzzle.status === 'processing' && puzzle.progress}
												<span class="progress-detail"
													>({puzzle.progress.generatedPieces}/{puzzle.progress.totalPieces})</span
												>
											{/if}
										</span>
									</div>
								</div>

								<button
									onclick={() => handleDelete(puzzle.id, puzzle.status === 'processing')}
									disabled={deletingId === puzzle.id}
									class="delete-btn"
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

<style>
	.admin-main {
		min-height: 100vh;
		background-color: var(--bg-0);
		background-image:
			linear-gradient(rgba(0, 240, 255, 0.02) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0, 240, 255, 0.02) 1px, transparent 1px);
		background-size: 40px 40px;
	}

	.admin-wrap {
		max-width: 80rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	/* Header */
	.admin-header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		padding: 1rem 0;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.admin-sys-tag {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		opacity: 0.6;
		margin-bottom: 0.25rem;
	}

	.admin-title {
		font-family: var(--font-display);
		font-size: clamp(1.25rem, 4vw, 2rem);
		font-weight: 900;
		letter-spacing: 0.1em;
		color: var(--text-0);
	}

	.admin-header-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.admin-link {
		font-family: var(--font-display);
		font-size: 0.58rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
		text-decoration: none;
		transition: color 0.15s;
	}

	.admin-link:hover {
		color: var(--accent);
	}

	.admin-btn-danger {
		font-family: var(--font-display);
		font-size: 0.58rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		border: 1px solid var(--hot-dim);
		color: var(--hot);
		background: transparent;
		padding: 0.4rem 0.875rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.admin-btn-danger:hover:not(:disabled) {
		background: var(--hot-glow);
		border-color: var(--hot);
	}

	.admin-btn-danger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.admin-line {
		height: 1px;
		background: linear-gradient(90deg, transparent, var(--accent), transparent);
		opacity: 0.3;
		margin-bottom: 2rem;
	}

	/* Alerts */
	.admin-alert {
		padding: 0.75rem 1rem;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.05em;
		margin-bottom: 1rem;
		border: 1px solid;
	}

	.admin-alert--error {
		background: rgba(255, 0, 102, 0.06);
		border-color: var(--hot-dim);
		color: var(--hot);
	}

	.admin-alert--success {
		background: rgba(0, 255, 136, 0.06);
		border-color: rgba(0, 255, 136, 0.4);
		color: var(--green);
	}

	/* Grid */
	.admin-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1.5rem;
	}

	@media (min-width: 1024px) {
		.admin-grid {
			grid-template-columns: 1fr 1fr;
		}
	}

	/* Panel */
	.admin-panel {
		background: var(--bg-1);
		border: 1px solid var(--border);
	}

	.admin-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-2);
	}

	.panel-tag {
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.panel-count {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.1em;
	}

	/* Form */
	.admin-form {
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.field-group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.field-label {
		font-family: var(--font-display);
		font-size: 0.55rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.optional {
		color: var(--text-2);
		font-weight: 400;
		opacity: 0.6;
	}

	.field-input,
	.field-select {
		width: 100%;
		background: var(--bg-0);
		border: 1px solid var(--border);
		color: var(--text-0);
		padding: 0.625rem 0.875rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		outline: none;
		transition:
			border-color 0.15s,
			box-shadow 0.15s;
		appearance: none;
		-webkit-appearance: none;
	}

	.field-input:focus,
	.field-select:focus {
		border-color: var(--accent);
		box-shadow: 0 0 12px var(--accent-glow);
	}

	.field-input:disabled,
	.field-select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.field-input::placeholder {
		color: var(--text-2);
	}

	.field-static {
		background: var(--bg-0);
		border: 1px solid var(--border);
		color: var(--text-2);
		padding: 0.625rem 0.875rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
	}

	/* Upload */
	.upload-zone {
		border: 1px dashed var(--border-bright);
		padding: 1.5rem;
		background: var(--bg-0);
		transition: border-color 0.15s;
	}

	.upload-zone:hover {
		border-color: var(--accent-dim);
	}

	.upload-label {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.upload-icon {
		width: 2.5rem;
		height: 2.5rem;
		color: var(--text-2);
	}

	.upload-text {
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--accent);
	}

	.upload-sub {
		font-family: var(--font-mono);
		font-size: 0.62rem;
		color: var(--text-2);
		letter-spacing: 0.05em;
	}

	.preview-wrap {
		position: relative;
		display: flex;
		justify-content: center;
	}

	.preview-img {
		max-height: 12rem;
		object-fit: contain;
	}

	.preview-remove {
		position: absolute;
		top: 0;
		right: 0;
		background: var(--hot);
		border: none;
		padding: 0.25rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: opacity 0.15s;
	}

	.preview-remove:hover {
		opacity: 0.8;
	}

	.remove-icon {
		width: 1rem;
		height: 1rem;
		color: white;
	}

	.submit-btn {
		font-family: var(--font-display);
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.2em;
		border: 1px solid var(--accent);
		color: var(--accent);
		background: transparent;
		padding: 0.75rem 1rem;
		cursor: pointer;
		transition: all 0.2s;
		width: 100%;
	}

	.submit-btn:hover:not(:disabled) {
		background: var(--accent-glow);
		box-shadow: 0 0 25px var(--accent-glow-strong);
		text-shadow: 0 0 10px var(--accent);
	}

	.submit-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.btn-inner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.btn-spinner {
		width: 0.875rem;
		height: 0.875rem;
		border: 2px solid var(--accent-dim);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
	}

	/* Puzzle list */
	.panel-loading {
		display: flex;
		justify-content: center;
		padding: 2.5rem;
	}

	.panel-spinner {
		width: 1.75rem;
		height: 1.75rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
	}

	.panel-empty {
		padding: 2.5rem 1rem;
		text-align: center;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--text-2);
		letter-spacing: 0.08em;
	}

	.puzzle-list {
		display: flex;
		flex-direction: column;
	}

	.puzzle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		gap: 0.75rem;
		transition: background 0.15s;
	}

	.puzzle-row:hover {
		background: var(--bg-2);
	}

	.puzzle-row:last-child {
		border-bottom: none;
	}

	.puzzle-row-left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.puzzle-thumb {
		width: 3rem;
		height: 3rem;
		object-fit: cover;
		flex-shrink: 0;
	}

	.thumb-processing,
	.thumb-failed {
		width: 3rem;
		height: 3rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-2);
		border: 1px solid var(--border);
		flex-shrink: 0;
	}

	.thumb-spinner {
		width: 1.25rem;
		height: 1.25rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
	}

	.fail-icon {
		width: 1.25rem;
		height: 1.25rem;
		color: var(--hot);
	}

	.puzzle-info {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.puzzle-name-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.puzzle-name {
		font-family: var(--font-body);
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-0);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 10rem;
	}

	.status-badge {
		font-family: var(--font-mono);
		font-size: 0.55rem;
		letter-spacing: 0.15em;
		padding: 0.15rem 0.45rem;
		flex-shrink: 0;
	}

	.status-ready {
		border: 1px solid rgba(0, 255, 136, 0.4);
		color: var(--green);
		background: rgba(0, 255, 136, 0.06);
	}

	.status-processing {
		border: 1px solid var(--accent-dim);
		color: var(--accent);
		background: var(--accent-glow);
	}

	.status-failed {
		border: 1px solid var(--hot-dim);
		color: var(--hot);
		background: var(--hot-glow);
	}

	.puzzle-meta {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--text-2);
		letter-spacing: 0.05em;
	}

	.progress-detail {
		color: var(--accent);
	}

	.delete-btn {
		font-family: var(--font-display);
		font-size: 0.55rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		border: 1px solid var(--hot-dim);
		color: var(--hot);
		background: transparent;
		padding: 0.35rem 0.625rem;
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.15s;
	}

	.delete-btn:hover:not(:disabled) {
		background: var(--hot-glow);
		border-color: var(--hot);
	}

	.delete-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
