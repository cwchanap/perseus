<script lang="ts">
	import {
		getAllowedPieceCountsForAspectRatio,
		isPuzzleAspectRatio,
		type PuzzleAspectRatio
	} from '@perseus/types';
	import {
		QUICK_PUZZLE_ALLOWED_MIMES,
		QUICK_PUZZLE_DEFAULT_ASPECT_RATIO,
		QUICK_PUZZLE_DEFAULT_PIECES,
		QUICK_PUZZLE_MAX_PIECES,
		QUICK_PUZZLE_MAX_UPLOAD_BYTES,
		QUICK_PUZZLE_MIN_PIECES
	} from '$lib/services/quickPuzzle/types';

	interface SubmitArgs {
		file: File;
		aspectRatio: PuzzleAspectRatio;
		pieceCount: number;
		name: string;
	}

	interface Props {
		onSubmit: (args: SubmitArgs) => void;
		busy?: boolean;
		progress?: { done: number; total: number } | null;
	}

	let { onSubmit, busy = false, progress = null }: Props = $props();

	let file: File | null = $state(null);
	let name = $state('');
	let aspectRatio = $state<PuzzleAspectRatio>(QUICK_PUZZLE_DEFAULT_ASPECT_RATIO);
	let pieceCount = $state(QUICK_PUZZLE_DEFAULT_PIECES);
	let error = $state<string | null>(null);
	const defaultPiecesByAspect: Record<PuzzleAspectRatio, number> = {
		'1:1': QUICK_PUZZLE_DEFAULT_PIECES,
		'4:3': 48,
		'3:4': 48
	};
	const aspectLabels: Record<PuzzleAspectRatio, string> = {
		'1:1': '1:1 Square',
		'4:3': '4:3 Landscape',
		'3:4': '3:4 Portrait'
	};
	const allowedPieceCounts = $derived(
		getAllowedPieceCountsForAspectRatio(
			aspectRatio,
			QUICK_PUZZLE_MIN_PIECES,
			QUICK_PUZZLE_MAX_PIECES
		)
	);
	const pieceRangeMessage = $derived(`Choose a valid ${aspectRatio} piece count.`);

	function deriveName(filename: string): string {
		const dot = filename.lastIndexOf('.');
		const stem = dot > 0 ? filename.slice(0, dot) : filename;
		return stem.slice(0, 80);
	}

	function handleFileChange(event: Event) {
		error = null;
		const target = event.target as HTMLInputElement;
		const next = target.files?.item(0) ?? null;
		if (!next) {
			file = null;
			return;
		}

		const mime = next.type.toLowerCase();
		if (!(QUICK_PUZZLE_ALLOWED_MIMES as readonly string[]).includes(mime)) {
			file = null;
			error = 'Please choose a JPEG, PNG, or WebP image.';
			return;
		}
		if (next.size > QUICK_PUZZLE_MAX_UPLOAD_BYTES) {
			file = null;
			error = 'Image too large (max 20 MB).';
			return;
		}

		file = next;
		if (!name) name = deriveName(next.name);
	}

	function handlePieceInput(event: Event) {
		const target = event.target as HTMLSelectElement;
		const raw = target.value;
		const parsed = Number.parseInt(raw, 10);
		pieceCount = Number.isFinite(parsed) ? parsed : 0;
	}

	function handleAspectChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		if (!isPuzzleAspectRatio(target.value)) return;

		aspectRatio = target.value;
		const nextAllowed = getAllowedPieceCountsForAspectRatio(
			aspectRatio,
			QUICK_PUZZLE_MIN_PIECES,
			QUICK_PUZZLE_MAX_PIECES
		);
		if (!nextAllowed.includes(pieceCount)) {
			pieceCount = defaultPiecesByAspect[aspectRatio] ?? nextAllowed[0] ?? 0;
		}
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		error = null;

		if (!file) {
			error = 'Please choose an image.';
			return;
		}
		if (
			!Number.isInteger(pieceCount) ||
			pieceCount < QUICK_PUZZLE_MIN_PIECES ||
			pieceCount > QUICK_PUZZLE_MAX_PIECES ||
			!allowedPieceCounts.includes(pieceCount)
		) {
			error = pieceRangeMessage;
			return;
		}

		onSubmit({ file, aspectRatio, pieceCount, name: name.trim() || deriveName(file.name) });
	}

	const progressPct = $derived(
		progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
	);
	let widthStyle = $derived(`width: ${progressPct}%;`);
</script>

<form
	class="quick-uploader space-y-4"
	onsubmit={handleSubmit}
	novalidate
	data-testid="quick-uploader"
>
	<label class="block text-sm">
		<span class="mb-1 block text-(--text-2)">Image</span>
		<input
			type="file"
			accept="image/jpeg,image/png,image/webp"
			onchange={handleFileChange}
			disabled={busy}
			data-testid="quick-uploader-file"
		/>
	</label>

	<label class="block text-sm">
		<span class="mb-1 block text-(--text-2)">Name</span>
		<input
			type="text"
			class="w-full rounded border border-(--border) bg-(--bg-1) p-2 text-(--text-0)"
			bind:value={name}
			maxlength="80"
			disabled={busy}
			data-testid="quick-uploader-name"
		/>
	</label>

	<label class="block text-sm">
		<span class="mb-1 block text-(--text-2)">Aspect Ratio</span>
		<select
			class="w-full rounded border border-(--border) bg-(--bg-1) p-2 text-(--text-0)"
			value={aspectRatio}
			onchange={handleAspectChange}
			disabled={busy}
			data-testid="quick-uploader-aspect"
		>
			{#each Object.entries(aspectLabels) as [value, label] (value)}
				<option {value}>{label}</option>
			{/each}
		</select>
	</label>

	<label class="block text-sm">
		<span class="mb-1 block text-(--text-2)">Pieces</span>
		<select
			class="w-full rounded border border-(--border) bg-(--bg-1) p-2 text-(--text-0)"
			value={pieceCount}
			onchange={handlePieceInput}
			disabled={busy}
			data-testid="quick-uploader-pieces"
		>
			{#each allowedPieceCounts as count (count)}
				<option value={count}>{count}</option>
			{/each}
		</select>
	</label>

	{#if error}
		<p class="text-sm text-(--hot)" data-testid="quick-uploader-error">{error}</p>
	{/if}

	{#if busy && progress}
		<div class="space-y-1" data-testid="quick-uploader-progress">
			<div class="h-1 w-full overflow-hidden rounded bg-(--bg-3)">
				<div class="h-full bg-(--accent) transition-[width]" style={widthStyle}></div>
			</div>
			<p class="text-xs text-(--text-2)">
				Generating piece {progress.done}/{progress.total}…
			</p>
		</div>
	{/if}

	<button
		type="submit"
		class="arcade-btn w-full"
		disabled={busy || !file}
		data-testid="quick-uploader-submit"
	>
		{busy ? 'Generating…' : 'Create Puzzle'}
	</button>
</form>
