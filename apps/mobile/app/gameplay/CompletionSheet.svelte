<script lang="ts">
	import type { SealedCompletion } from '@perseus/game-core';
	import type { PuzzleDifficulty } from '@perseus/types';
	import { getDifficultyLabel } from '../library/familyGallery';

	export let puzzleName: string;
	export let difficulty: PuzzleDifficulty;
	export let seal: SealedCompletion;
	export let onBackToLibrary: () => void;

	// Read-only projection of the immutable seal; nothing here writes back.
	function formatElapsed(seconds: number): string {
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	}
</script>

<stackLayout class="sheet">
	<label text="PUZZLE COMPLETE" class="sheet-title" />
	<label text={puzzleName} class="sheet-text" textWrap="true" />
	<label
		text={`${getDifficultyLabel(difficulty)} · ${seal.resultClass === 'relaxed' ? 'RELAXED' : 'TIMED'}`}
		class="sheet-text"
	/>
	{#if seal.elapsedActiveSeconds !== null}
		<label text={`TIME ${formatElapsed(seal.elapsedActiveSeconds)}`} class="sheet-stat" />
	{/if}
	<label text={`HINTS USED ${seal.hintsUsed}`} class="sheet-stat" />
	<label text={`INCORRECT ATTEMPTS ${seal.incorrectAttempts}`} class="sheet-stat" />
	<label
		text={`ROTATION ${seal.rotationEnabled ? 'ON' : 'OFF'}${seal.rotationUsed ? ' · USED' : ''}`}
		class="sheet-stat"
	/>
	<button text="BACK TO LIBRARY" class="sheet-primary" on:tap={onBackToLibrary} />
</stackLayout>
