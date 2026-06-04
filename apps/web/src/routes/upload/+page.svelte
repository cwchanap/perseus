<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { ApiError, createPlayerPuzzle, getGoogleLoginUrl } from '$lib/services/api';
	import { playerAuth } from '$lib/stores/playerAuth';
	import { PUZZLE_CATEGORIES, type PuzzleCategory } from '$lib/constants/categories';
	import { normalizePuzzleImageFile } from '$lib/services/puzzleImage';
	import {
		DEFAULT_PUZZLE_ASPECT_RATIO,
		MAX_IMAGE_DIMENSION,
		getAllowedPieceCountsForAspectRatio,
		isPuzzleAspectRatio,
		type PuzzleAspectRatio
	} from '@perseus/types';

	const MIN_UPLOAD_PIECES = 4;
	const MAX_UPLOAD_PIECES = 250;
	const DEFAULT_PIECES_BY_ASPECT: Record<PuzzleAspectRatio, number> = {
		'1:1': 225,
		'4:3': 192,
		'3:4': 192
	};
	const ASPECT_LABELS: Record<PuzzleAspectRatio, string> = {
		'1:1': '1:1 Square',
		'4:3': '4:3 Landscape',
		'3:4': '3:4 Portrait'
	};
	const ASPECT_STYLE: Record<PuzzleAspectRatio, string> = {
		'1:1': 'aspect-ratio: 1 / 1;',
		'4:3': 'aspect-ratio: 4 / 3;',
		'3:4': 'aspect-ratio: 3 / 4;'
	};

	let name = $state('');
	let category: PuzzleCategory | '' = $state('');
	let aspectRatio = $state<PuzzleAspectRatio>(DEFAULT_PUZZLE_ASPECT_RATIO);
	let pieceCount = $state(DEFAULT_PIECES_BY_ASPECT[DEFAULT_PUZZLE_ASPECT_RATIO]);
	let imageFile: File | null = $state(null);
	let imagePreview: string | null = $state(null);
	let imageInput: HTMLInputElement | null = $state(null);
	let uploading = $state(false);
	let formError: string | null = $state(null);
	let successMessage: string | null = $state(null);
	let successTimeout: ReturnType<typeof setTimeout> | null = null;

	const allowedPieceCounts = $derived(
		getAllowedPieceCountsForAspectRatio(aspectRatio, MIN_UPLOAD_PIECES, MAX_UPLOAD_PIECES)
	);
	const previewAspectStyle = $derived(ASPECT_STYLE[aspectRatio]);
	const googleLoginUrl = $derived(getGoogleLoginUrl('/upload'));

	onMount(() => {
		void playerAuth.refresh();
	});

	onDestroy(() => {
		if (successTimeout !== null) {
			clearTimeout(successTimeout);
			successTimeout = null;
		}
	});

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

	function handleAspectChange(event: Event) {
		const input = event.target as HTMLSelectElement;
		if (!isPuzzleAspectRatio(input.value)) return;

		aspectRatio = input.value;
		const nextAllowed = getAllowedPieceCountsForAspectRatio(
			aspectRatio,
			MIN_UPLOAD_PIECES,
			MAX_UPLOAD_PIECES
		);
		if (!nextAllowed.includes(pieceCount)) {
			pieceCount = DEFAULT_PIECES_BY_ASPECT[aspectRatio] ?? nextAllowed[0] ?? 0;
		}
	}

	function handlePieceCountChange(event: Event) {
		const input = event.target as HTMLSelectElement;
		const parsed = Number.parseInt(input.value, 10);
		pieceCount = Number.isFinite(parsed) ? parsed : 0;
	}

	function clearForm() {
		name = '';
		category = '';
		aspectRatio = DEFAULT_PUZZLE_ASPECT_RATIO;
		pieceCount = DEFAULT_PIECES_BY_ASPECT[DEFAULT_PUZZLE_ASPECT_RATIO];
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

		if (!allowedPieceCounts.includes(pieceCount)) {
			formError = `Choose a valid ${aspectRatio} piece count`;
			return;
		}

		uploading = true;

		try {
			const normalizedImage = await normalizePuzzleImageFile(imageFile, {
				aspectRatio,
				pieceCount,
				maxDimension: MAX_IMAGE_DIMENSION,
				type: 'image/jpeg',
				quality: 0.88
			});
			await createPlayerPuzzle(
				name.trim(),
				pieceCount,
				normalizedImage,
				category || undefined,
				aspectRatio
			);
			successMessage =
				'Puzzle upload started! It will appear in the gallery once processing begins.';
			clearForm();

			if (successTimeout !== null) clearTimeout(successTimeout);
			successTimeout = setTimeout(() => {
				successMessage = null;
				successTimeout = null;
			}, 3000);
		} catch (e) {
			if (e instanceof ApiError) {
				formError = e.message;
			} else if (e instanceof Error) {
				formError = e.message;
			} else {
				formError = 'Failed to upload puzzle';
			}
		} finally {
			uploading = false;
		}
	}
</script>

<svelte:head>
	<title>Upload Puzzle | Perseus</title>
</svelte:head>

<main
	class="min-h-screen bg-(--bg-0)
[background-image:linear-gradient(rgba(0,240,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.02)_1px,transparent_1px)]
[background-size:40px_40px]"
>
	<div class="mx-auto max-w-[46rem] px-6 pt-8 pb-16 sm:px-8">
		<header class="flex flex-wrap items-end justify-between gap-4 py-4">
			<div>
				<div
					class="mb-1 text-[0.6rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
				>
					// PERSEUS PLAYER
				</div>
				<h1
					class="text-[clamp(1.25rem,4vw,2rem)] font-(--font-display) font-black tracking-[0.1em] text-(--text-0)"
				>
					UPLOAD PUZZLE
				</h1>
			</div>
			<a
				href={resolve('/')}
				class="text-[0.58rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)
transition-colors duration-150 hover:text-(--accent)"
			>
				VIEW ARCADE
			</a>
		</header>

		<div
			class="mb-8 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] opacity-30"
		></div>

		{#if $playerAuth.status === 'loading'}
			<div class="border border-(--border) bg-(--bg-1) p-10 text-center" role="status">
				<div
					class="mx-auto mb-4 h-7 w-7 rounded-full border-2 border-(--border) border-t-(--accent)
motion-safe:animate-[spin-cw_0.75s_linear_infinite]
motion-reduce:animate-none"
				></div>
				<p class="text-[0.65rem] font-(--font-mono) tracking-[0.18em] text-(--accent)">
					VERIFYING PLAYER...
				</p>
			</div>
		{:else if $playerAuth.status !== 'authenticated'}
			<section class="border border-(--border) bg-(--bg-1) px-6 py-8 text-center">
				<p class="mb-6 text-[0.8rem] font-(--font-mono) tracking-[0.06em] text-(--text-2)">
					Sign in to upload puzzles to the server.
				</p>
				<a
					href={googleLoginUrl}
					class="inline-flex border border-(--accent) px-4 py-3 text-[0.65rem]
font-(--font-display) font-bold tracking-[0.2em] text-(--accent)
transition-all duration-200 hover:bg-(--accent-glow)"
				>
					SIGN IN WITH GOOGLE
				</a>
			</section>
		{:else}
			<section class="border border-(--border) bg-(--bg-1)">
				<div
					class="flex items-center justify-between border-b border-(--border) bg-(--bg-2) px-4 py-3"
				>
					<span
						class="text-[0.6rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
					>
						SERVER UPLOAD
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
							disabled={uploading}
						/>
					</div>

					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div class="flex flex-col gap-1.5">
							<span
								class="text-[0.55rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
							>
								ASPECT RATIO
							</span>
							<select
								value={aspectRatio}
								onchange={handleAspectChange}
								disabled={uploading}
								class="w-full appearance-none border border-(--border) bg-(--bg-0) px-3.5 py-2.5
text-[0.8rem] font-(--font-mono) text-(--text-0)"
							>
								{#each Object.entries(ASPECT_LABELS) as [value, label] (value)}
									<option {value}>{label}</option>
								{/each}
							</select>
						</div>

						<div class="flex flex-col gap-1.5">
							<span
								class="text-[0.55rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--text-2)"
							>
								PIECE COUNT
							</span>
							<select
								value={pieceCount}
								onchange={handlePieceCountChange}
								disabled={uploading}
								class="w-full appearance-none border border-(--border) bg-(--bg-0) px-3.5 py-2.5
text-[0.8rem] font-(--font-mono) text-(--text-0)"
							>
								{#each allowedPieceCounts as count (count)}
									<option value={count}>{count} pieces</option>
								{/each}
							</select>
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
							disabled={uploading}
							class="w-full appearance-none border border-(--border) bg-(--bg-0) px-3.5 py-2.5
text-[0.8rem] font-(--font-mono) text-(--text-0)"
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
								<div class="relative mx-auto w-full max-w-80" style={previewAspectStyle}>
									<img src={imagePreview} alt="Preview" class="h-full w-full object-cover" />
									<button
										type="button"
										onclick={clearSelectedImage}
										class="absolute top-0 right-0 flex items-center justify-center bg-(--hot) p-1
transition-opacity duration-150 hover:opacity-80"
										aria-label="Remove image"
									>
										<span class="text-white">x</span>
									</button>
								</div>
							{:else}
								<label
									for="image-upload"
									class="flex cursor-pointer flex-col items-center gap-2
focus-within:[outline:2px_solid_var(--accent)]
focus-within:[outline-offset:4px]"
								>
									<span
										class="text-[0.6rem] font-(--font-display) font-semibold tracking-[0.2em] text-(--accent)"
									>
										CLICK TO UPLOAD
									</span>
									<span class="text-[0.62rem] font-(--font-mono) tracking-[0.05em] text-(--text-2)">
										JPEG, PNG, WebP - max 10MB
									</span>
									<input
										id="image-upload"
										bind:this={imageInput}
										type="file"
										accept="image/jpeg,image/png,image/webp"
										class="sr-only"
										onchange={handleImageSelect}
										disabled={uploading}
									/>
								</label>
							{/if}
						</div>
					</div>

					<button
						type="submit"
						disabled={uploading || !name.trim() || !imageFile}
						class="w-full border border-(--accent) px-4 py-3 text-[0.65rem]
font-(--font-display) font-bold tracking-[0.2em] text-(--accent)
transition-all duration-200 hover:bg-(--accent-glow)
disabled:cursor-not-allowed disabled:opacity-40"
					>
						{uploading ? 'UPLOADING...' : 'UPLOAD PUZZLE'}
					</button>
				</form>
			</section>
		{/if}
	</div>
</main>
