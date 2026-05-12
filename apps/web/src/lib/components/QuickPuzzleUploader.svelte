<script lang="ts">
	import {
		QUICK_PUZZLE_ALLOWED_MIMES,
		QUICK_PUZZLE_DEFAULT_PIECES,
		QUICK_PUZZLE_MAX_PIECES,
		QUICK_PUZZLE_MAX_UPLOAD_BYTES,
		QUICK_PUZZLE_MIN_PIECES
	} from '$lib/services/quickPuzzle/types';

	interface SubmitArgs {
		file: File;
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
	let pieceCount = $state(QUICK_PUZZLE_DEFAULT_PIECES);
	let error = $state<string | null>(null);

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
		const target = event.target as HTMLInputElement;
		const raw = target.value;
		const parsed = Number.parseInt(raw, 10);
		pieceCount = Number.isFinite(parsed) ? parsed : 0;
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
			pieceCount > QUICK_PUZZLE_MAX_PIECES
		) {
			error = `Choose between ${QUICK_PUZZLE_MIN_PIECES} and ${QUICK_PUZZLE_MAX_PIECES} pieces.`;
			return;
		}

		onSubmit({ file, pieceCount, name: name.trim() || deriveName(file.name) });
	}

	const progressPct = $derived(
		progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
	);
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
		<span class="mb-1 block text-(--text-2)">Pieces</span>
		<input
			type="number"
			class="w-full rounded border border-(--border) bg-(--bg-1) p-2 text-(--text-0)"
			min={QUICK_PUZZLE_MIN_PIECES}
			max={QUICK_PUZZLE_MAX_PIECES}
			value={pieceCount}
			oninput={handlePieceInput}
			disabled={busy}
			data-testid="quick-uploader-pieces"
		/>
	</label>

	{#if error}
		<p class="text-sm text-(--hot)" data-testid="quick-uploader-error">{error}</p>
	{/if}

	{#if busy && progress}
		<div class="space-y-1" data-testid="quick-uploader-progress">
			<div class="h-1 w-full overflow-hidden rounded bg-(--bg-3)">
				<div class="h-full bg-(--accent) transition-[width]" style="width: {progressPct}%;"></div>
			</div>
			<p class="text-xs text-(--text-2)">
				Generating piece {progress.done} / {progress.total}…
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
