<script lang="ts">
	import type { PuzzleDifficulty } from '@perseus/types';

	interface Props {
		difficulty: PuzzleDifficulty;
		pieceCount: number;
	}

	interface DifficultyPresentation {
		label: string;
		gems: number;
		accent: string;
	}

	const difficultyPresentation: Record<PuzzleDifficulty, DifficultyPresentation> = {
		easy: { label: 'Easy', gems: 1, accent: 'var(--accent)' },
		normal: { label: 'Normal', gems: 2, accent: 'var(--hot)' },
		hard: { label: 'Hard', gems: 3, accent: 'var(--gold)' }
	};

	let { difficulty, pieceCount }: Props = $props();

	const presentation = $derived(difficultyPresentation[difficulty]);
	const gemIndexes = $derived(Array.from({ length: presentation.gems }, (_, index) => index));
	const accessibleLabel = $derived(`${presentation.label} difficulty, ${pieceCount} pieces`);
</script>

<span
	class="inline-flex items-center gap-1.5 font-(--font-display) font-black tracking-[0.04em] text-(--text-0)"
	role="img"
	aria-label={accessibleLabel}
	data-testid="difficulty-gems"
	data-difficulty={difficulty}
	style={`--gem-color: ${presentation.accent}`}
>
	<span class="inline-flex items-center gap-0.5" aria-hidden="true">
		{#each gemIndexes as index (index)}
			<svg
				class="difficulty-gem h-4 w-4"
				viewBox="0 0 24 24"
				fill="currentColor"
				data-testid="difficulty-gem"
				aria-hidden="true"
			>
				<path d="M12 2l7 5.5-2.6 12.5H7.6L5 7.5z" />
			</svg>
		{/each}
	</span>
	<span aria-hidden="true">{pieceCount}</span>
</span>

<style>
	.difficulty-gem {
		color: var(--gem-foreground, var(--gem-color));
		filter: drop-shadow(0 0 4px var(--gem-foreground, var(--gem-color)));
	}
</style>
