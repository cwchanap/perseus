<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import QuickPuzzleUploader from '$lib/components/QuickPuzzleUploader.svelte';
	import QuickPuzzleList from '$lib/components/QuickPuzzleList.svelte';
	import { createQuick, listQuick, removeQuick } from '$lib/services/quickPuzzle';
	import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
	import type { PuzzleAspectRatio } from '@perseus/types';

	let puzzles: StoredQuickPuzzle[] = $state([]);
	let busy = $state(false);
	let progress: { done: number; total: number } | null = $state(null);
	let toast: string | null = $state(null);

	function refresh() {
		puzzles = listQuick();
	}

	$effect(() => {
		refresh();
	});

	async function handleSubmit({
		file,
		aspectRatio,
		pieceCount,
		name
	}: {
		file: File;
		aspectRatio: PuzzleAspectRatio;
		pieceCount: number;
		name: string;
	}) {
		busy = true;
		toast = null;
		progress = { done: 0, total: pieceCount };
		try {
			const result = await createQuick(file, pieceCount, name, {
				aspectRatio,
				onProgress: (done, total) => {
					progress = { done, total };
				}
			});
			refresh();
			if (!result.persisted) {
				// Session-only fallback: surface the toast briefly before navigating away,
				// since the /quick page unmounts on goto.
				toast = 'Storage full — this puzzle will only last for this session.';
				await new Promise((r) => setTimeout(r, 1500));
			}
			await goto(resolve(`/puzzle/${result.stored.id}`));
		} catch (err) {
			console.error('Quick puzzle generation failed:', err);
			toast =
				err instanceof Error
					? err.message
					: "Couldn't generate puzzle. Try fewer pieces or a smaller image.";
		} finally {
			busy = false;
			progress = null;
		}
	}

	function handleDelete(id: string) {
		removeQuick(id);
		refresh();
	}
</script>

<svelte:head>
	<title>Quick Puzzle | Perseus Arcade</title>
</svelte:head>

<div class="mx-auto max-w-(--breakpoint-md) px-6 py-10">
	<header class="mb-6">
		<a
			class="text-xs text-(--text-2) hover:text-(--accent)"
			href={resolve('/')}
			data-testid="quick-back-link"
		>
			← Back to arcade
		</a>
		<h1 class="mt-2 text-2xl font-bold text-(--text-0)">Quick Puzzle</h1>
		<p class="mt-1 text-sm text-(--text-2)">
			Upload an image to play it as a jigsaw puzzle. Stays on your device only.
		</p>
	</header>

	<section class="mb-8">
		<QuickPuzzleUploader onSubmit={handleSubmit} {busy} {progress} />
		{#if toast}
			<p class="mt-3 text-sm text-(--accent)" data-testid="quick-toast">{toast}</p>
		{/if}
	</section>

	<section>
		<h2 class="mb-3 text-sm font-semibold tracking-wider text-(--text-2) uppercase">
			My Quick Puzzles
		</h2>
		<QuickPuzzleList {puzzles} onDelete={handleDelete} />
	</section>
</div>
