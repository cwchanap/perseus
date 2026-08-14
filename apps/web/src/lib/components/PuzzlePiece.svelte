<script lang="ts">
	import type { PuzzlePiece } from '$lib/types/puzzle';
	import type { Rotation } from '$lib/types/gameplay';
	import { EXPANSION_FACTOR, TAB_RATIO } from '$lib/constants/puzzle';
	import { coarsePointer } from '$lib/stores/pointer';

	interface Props {
		piece: PuzzlePiece;
		isPlaced: boolean;
		resolveImage: (piece: PuzzlePiece) => string;
		rotationEnabled?: boolean;
		rotation?: Rotation;
		onRotate?: (pieceId: number) => void;
		selected?: boolean;
		onSelect?: (pieceId: number) => void;
		onCancelSelection?: () => void;
	}

	let {
		piece,
		isPlaced,
		resolveImage,
		rotationEnabled = false,
		rotation = 0,
		onRotate,
		selected = false,
		onSelect,
		onCancelSelection
	}: Props = $props();

	function handleDragStart(event: DragEvent) {
		if (isPlaced || !event.dataTransfer) return;
		event.dataTransfer.setData('text/plain', piece.id.toString());
		event.dataTransfer.effectAllowed = 'move';
	}

	// Click selection and keyboard selection/deselection are wired with
	// non-delegated listeners (via the `interactionAction` Svelte action below)
	// instead of `onclick={}`/`onkeydown={}`. Svelte 5 event delegation can
	// re-invoke a delegated handler after a mid-event re-render (e.g. a click or
	// Enter toggles the `selected` prop), which for this toggle means select→cancel
	// fires synchronously and the selection is immediately undone. A latched
	// boolean guard against that double-fire would stay set when the double-fire
	// does not occur and swallow the next genuine click/Enter/Space, forcing users
	// to press twice to deselect. A non-delegated listener fires exactly once per
	// native event regardless of re-renders, so no guard is needed and a single
	// click/press behaves correctly.
	function handleKeyDown(event: KeyboardEvent) {
		if (isPlaced) return;
		if (rotationEnabled && (event.key === 'r' || event.key === 'R')) {
			event.preventDefault();
			onRotate?.(piece.id);
			return;
		}
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();

		if (selected) onCancelSelection?.();
		else onSelect?.(piece.id);
	}

	function handleClick() {
		if (isPlaced) return;
		onSelect?.(piece.id);
	}

	function interactionAction(node: HTMLElement) {
		node.addEventListener('click', handleClick);
		node.addEventListener('keydown', handleKeyDown);
		return {
			destroy() {
				node.removeEventListener('click', handleClick);
				node.removeEventListener('keydown', handleKeyDown);
			}
		};
	}

	function handleRotateClick(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		onRotate?.(piece.id);
	}

	function stopRotateEventPropagation(event: Event) {
		event.stopPropagation();
	}
</script>

<div class="puzzle-piece-wrapper relative h-full w-full">
	{#if rotationEnabled && !isPlaced}
		<button
			type="button"
			class="absolute top-1 right-1 z-10 rounded-full bg-white/90 px-2 py-1 text-xs font-medium text-gray-800 shadow-sm ring-1 ring-gray-300 transition hover:bg-white focus:ring-2 focus:ring-blue-400 focus:outline-hidden"
			aria-label="Rotate piece {piece.id}"
			data-testid="rotate-piece-button"
			onclick={handleRotateClick}
			onkeydown={stopRotateEventPropagation}
			onpointerdown={stopRotateEventPropagation}
		>
			↻
		</button>
	{/if}

	<div
		class="puzzle-piece h-full w-full cursor-grab transition-transform select-none hover:scale-105 focus:outline-hidden"
		class:opacity-50={isPlaced}
		class:cursor-not-allowed={isPlaced}
		class:ring-2={selected}
		class:ring-blue-400={selected}
		draggable={!isPlaced && !$coarsePointer}
		ondragstart={handleDragStart}
		use:interactionAction
		role="button"
		tabindex={isPlaced ? -1 : 0}
		aria-label="Puzzle piece {piece.id}"
		aria-grabbed={selected}
		aria-pressed={selected}
		aria-disabled={isPlaced}
		data-testid="puzzle-piece"
		data-piece-id={piece.id}
		data-selected={selected}
	>
		<!-- Shadow wrapper: drop-shadow respects PNG transparency -->
		<div
			class="piece-visual h-full w-full transition-transform"
			data-testid="puzzle-piece-visual"
			style="transform: rotate({rotation}deg);"
		>
			<div class="piece-shadow-wrapper h-full w-full" class:placed={isPlaced}>
				<!-- Pre-masked jigsaw piece from server (140% size, offset to show tabs) -->
				<div
					class="pointer-events-none relative"
					style="
						width: {EXPANSION_FACTOR * 100}%;
						height: {EXPANSION_FACTOR * 100}%;
						left: -{TAB_RATIO * 100}%;
						top: -{TAB_RATIO * 100}%;
					"
				>
					<img
						src={resolveImage(piece)}
						alt="Piece {piece.id}"
						class="h-full w-full"
						draggable="false"
					/>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.puzzle-piece {
		overflow: visible;
	}

	.puzzle-piece:not(.cursor-not-allowed):active {
		cursor: grabbing;
	}

	.piece-visual {
		transform-origin: center;
	}

	/* Drop shadow that respects clip-path shape */
	.piece-shadow-wrapper {
		filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.25));
	}

	/* Placed piece - subtle shadow */
	.piece-shadow-wrapper.placed {
		filter: drop-shadow(1px 2px 3px rgba(0, 0, 0, 0.15));
	}
</style>
