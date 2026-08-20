<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import { resolve } from '$app/paths';
	import type { GalleryProgress } from '$lib/services/gameplay/galleryProgress';

	interface Props {
		progress: readonly GalleryProgress[];
		loading: boolean;
		onClose: () => void;
	}

	let { progress, loading, onClose }: Props = $props();
</script>

<div
	class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
	style="
		padding-top: max(1rem, env(safe-area-inset-top));
		padding-right: max(1rem, env(safe-area-inset-right));
		padding-bottom: max(1rem, env(safe-area-inset-bottom));
		padding-left: max(1rem, env(safe-area-inset-left));
	"
>
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Saved progress"
		tabindex="-1"
		use:modalFocus
		onkeydown={(event) => event.key === 'Escape' && onClose()}
		class="flex max-h-[min(80dvh,42rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
	>
		<header class="flex items-center justify-between gap-4 border-b border-gray-200 p-5">
			<h2 class="text-lg font-semibold text-gray-900">Saved progress</h2>
			<button type="button" aria-label="Close saved progress" onclick={onClose}>CLOSE</button>
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			{#if loading}
				<p>LOADING SAVED PROGRESS...</p>
			{:else if progress.length === 0}
				<p>NO SAVED PROGRESS</p>
			{:else}
				<ul class="flex flex-col gap-3">
					{#each progress as item (item.puzzleId)}
						<li
							data-testid={`saved-progress-row-${item.puzzleId}`}
							class="flex items-center justify-between gap-4"
						>
							<div class="min-w-0">
								<p>{item.name}</p>
								<p>{item.placedCount}/{item.pieceCount} PLACED</p>
							</div>
							<a href={resolve(`/puzzle/${item.puzzleId}`)} aria-label={`Continue ${item.name}`}>
								CONTINUE
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
