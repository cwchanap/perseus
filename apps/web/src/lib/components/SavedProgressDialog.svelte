<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import { resolve } from '$app/paths';
	import type { GalleryProgress } from '$lib/services/gameplay/galleryProgress';

	interface Props {
		progress: readonly GalleryProgress[];
		loading: boolean;
		// true when saved-progress discovery ran to completion (no transient
		// 5xx/network failures). false means rows may be empty because a
		// detail fetch failed mid-discovery — the dialog should signal a
		// retryable outage rather than claiming progress is gone.
		complete?: boolean;
		onClose: () => void;
	}

	let { progress, loading, complete = true, onClose }: Props = $props();
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
		class="flex max-h-[min(80dvh,42rem)] w-full max-w-xl flex-col overflow-hidden border border-(--accent)
		bg-(--bg-1) [box-shadow:0_0_40px_var(--accent-glow)]"
	>
		<header class="flex items-center justify-between gap-4 border-b border-(--border) p-5">
			<h2
				class="text-[0.95rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-0) uppercase"
			>
				Saved progress
			</h2>
			<button
				type="button"
				aria-label="Close saved progress"
				onclick={onClose}
				class="arcade-btn-ghost"
			>
				CLOSE
			</button>
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			{#if loading || progress.length === 0}
				<!-- Polite live region so screen readers hear discovery settle:
				     LOADING mutates to NO SAVED PROGRESS (discovery complete,
				     nothing found) or UNABLE TO LOAD SAVED PROGRESS (discovery
				     was interrupted by a transient outage — retry by reopening).
				     Result rows render outside the region and are not announced. -->
				<div aria-live="polite">
					<p
						class="text-[0.75rem] font-(--font-mono) tracking-[0.2em] uppercase {loading
							? 'text-(--accent)'
							: complete
								? 'text-(--text-1)'
								: 'text-(--hot)'}"
					>
						{loading
							? 'LOADING SAVED PROGRESS...'
							: complete
								? 'NO SAVED PROGRESS'
								: 'UNABLE TO LOAD SAVED PROGRESS — TRY AGAIN'}
					</p>
				</div>
			{:else}
				<ul class="flex flex-col gap-3">
					{#each progress as item (item.puzzleId)}
						<li
							data-testid={`saved-progress-row-${item.puzzleId}`}
							class="flex items-center justify-between gap-4 border border-(--border) px-4 py-3"
						>
							<div class="min-w-0">
								<p class="truncate text-[0.9rem] font-(--font-display) font-bold text-(--text-0)">
									{item.name}
								</p>
								<p class="text-[0.7rem] font-(--font-mono) tracking-[0.12em] text-(--text-1)">
									{item.placedCount}/{item.pieceCount} PLACED
								</p>
							</div>
							<a
								href={resolve(`/puzzle/${item.puzzleId}`)}
								aria-label={`Continue ${item.name}`}
								class="arcade-btn"
							>
								CONTINUE
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
