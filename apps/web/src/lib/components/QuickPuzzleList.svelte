<script lang="ts">
	import { resolve } from '$app/paths';
	import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';

	interface Props {
		puzzles: StoredQuickPuzzle[];
		onDelete: (id: string) => void;
	}

	let { puzzles, onDelete }: Props = $props();

	const relativeFormatter =
		typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl
			? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
			: null;

	function formatAge(createdAt: number): string {
		const ms = Date.now() - createdAt;
		const minutes = Math.round(ms / 60_000);
		const hours = Math.round(ms / 3_600_000);
		const days = Math.round(ms / 86_400_000);

		if (!relativeFormatter) {
			if (days >= 1) return `${days}d ago`;
			if (hours >= 1) return `${hours}h ago`;
			return `${Math.max(1, minutes)}m ago`;
		}

		if (days >= 1) return relativeFormatter.format(-days, 'day');
		if (hours >= 1) return relativeFormatter.format(-hours, 'hour');
		return relativeFormatter.format(-Math.max(1, minutes), 'minute');
	}
</script>

{#if puzzles.length === 0}
	<p
		class="rounded border border-(--border) p-6 text-center text-sm text-(--text-2)"
		data-testid="quick-list-empty"
	>
		Upload an image to create your first quick puzzle. Stays on your device for 7 days, max 5.
	</p>
{:else}
	<ul class="space-y-2" data-testid="quick-list">
		{#each puzzles as puzzle (puzzle.id)}
			<li
				class="flex items-center gap-3 rounded border border-(--border) bg-(--bg-1) p-3"
				data-testid={`quick-list-row-${puzzle.id}`}
			>
				<a
					href={resolve(`/puzzle/${puzzle.id}`)}
					class="flex flex-1 items-center gap-3"
					data-testid={`quick-list-link-${puzzle.id}`}
				>
					<img
						src={puzzle.imageDataUrl}
						alt=""
						class="h-12 w-12 rounded object-cover"
						data-testid={`quick-list-thumb-${puzzle.id}`}
					/>
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium text-(--text-0)">{puzzle.name}</div>
						<div class="text-xs text-(--text-2)">
							{puzzle.pieceCount} pieces · {formatAge(puzzle.createdAt)}
						</div>
					</div>
				</a>
				<button
					type="button"
					class="rounded border border-(--border) px-2 py-1 text-xs text-(--text-2) hover:text-(--hot)"
					onclick={() => onDelete(puzzle.id)}
					aria-label={`Delete ${puzzle.name}`}
					data-testid={`quick-list-delete-${puzzle.id}`}
				>
					Delete
				</button>
			</li>
		{/each}
	</ul>
{/if}
