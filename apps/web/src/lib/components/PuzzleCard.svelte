<script lang="ts">
  import type { PuzzleSummary } from '$lib/types/puzzle';
  import { getThumbnailUrl } from '$lib/services/api';

  interface Props {
    puzzle: PuzzleSummary;
  }

  let { puzzle }: Props = $props();
</script>

<a
  href="/puzzle/{puzzle.id}"
  class="group block overflow-hidden rounded-lg bg-white shadow-md transition-all hover:shadow-lg"
  data-testid="puzzle-card"
>
  <div class="aspect-square overflow-hidden bg-gray-100">
    <img
      src={getThumbnailUrl(puzzle.id)}
      alt={puzzle.name}
      class="h-full w-full object-cover transition-transform group-hover:scale-105"
      loading="lazy"
    />
  </div>
  <div class="p-4">
    <h3 class="truncate text-lg font-semibold text-gray-900">{puzzle.name}</h3>
    <p class="mt-1 text-sm text-gray-500">{puzzle.pieceCount} pieces</p>
  </div>
</a>
