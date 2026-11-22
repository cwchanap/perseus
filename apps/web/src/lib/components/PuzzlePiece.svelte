<script lang="ts">
	import type { PuzzlePiece } from '$lib/types/puzzle';
	import type { Rotation } from '@perseus/game-core';
	import { EXPANSION_FACTOR, TAB_RATIO } from '$lib/constants/puzzle';
	import { imageStatus } from '$lib/actions/imageStatus';
	import type { ImageStatusState } from '$lib/actions/imageStatus';

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
		// Presentation-only: the inventory roves a single tab stop among its
		// pieces and hands the active piece's index down. Placed pieces always
		// drop out of the tab order regardless of the supplied value.
		tabIndex?: 0 | -1;
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
		onCancelSelection,
		tabIndex = 0
	}: Props = $props();

	// Tray image status lives on this 100%-of-slot wrapper — never inside the
	// 140% jigsaw wrapper, whose overhang would spill a decoration over
	// neighboring slots.
	let imageState = $state<ImageStatusState>('pending');

	// Expose the current rotation angle in the piece name so keyboard/screen
	// reader users know the orientation before rotating or placing.
	const accessibleName = $derived(
		rotationEnabled && !isPlaced
			? rotation === 0
				? `Puzzle piece ${piece.id}, upright`
				: `Puzzle piece ${piece.id}, rotated ${rotation} degrees`
			: `Puzzle piece ${piece.id}`
	);

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
</script>

<div class="puzzle-piece-wrapper relative h-full w-full">
	{#if imageState !== 'loaded'}
		<!-- Translucent and confined to the 100% slot bounds; the piece image
			     is hidden (opacity) whenever this shows, so overlaying it never
			     clips the jigsaw shape. Rotated pieces keep this axis-aligned: the
			     rotation applies to .piece-visual, not this wrapper. -->
		<div
			class="piece-image-status pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
			class:piece-image-error={imageState === 'error'}
			data-testid="piece-image-status"
			data-status={imageState}
			aria-hidden="true"
		>
			{#if imageState === 'error'}!{/if}
		</div>
	{/if}
	<div
		class="puzzle-piece h-full w-full cursor-grab transition-transform select-none hover:scale-105 focus:outline-hidden"
		class:opacity-50={isPlaced}
		class:cursor-not-allowed={isPlaced}
		class:ring-2={selected}
		class:ring-blue-400={selected}
		draggable={!isPlaced}
		ondragstart={handleDragStart}
		use:interactionAction
		role="button"
		tabindex={isPlaced ? -1 : tabIndex}
		aria-label={accessibleName}
		aria-keyshortcuts={rotationEnabled && !isPlaced ? 'R' : undefined}
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
						class:opacity-0={imageState !== 'loaded'}
						draggable="false"
						use:imageStatus={{
							src: resolveImage(piece),
							onStatus: (state) => (imageState = state)
						}}
					/>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.puzzle-piece {
		/* Proportional inset: shrinking the content box to ~71% makes the
		   140% pre-masked jigsaw wrapper (EXPANSION_FACTOR, offset -20%)
		   land at ~99.4% of the piece footprint, so unhovered tab tips stay
		   inside the slot. border-box keeps the full-size hit target —
		   the padding is dead space inside the same button bounds, not a
		   smaller button. 14.5%, not 16%: the extra shrink would only
		   budget hover, and the slot's own padding plus half the grid gap
		   already covers the retained scale-105. */
		box-sizing: border-box;
		padding: 14.5%;
		overflow: visible;
	}

	.puzzle-piece:not(.cursor-not-allowed):active {
		cursor: grabbing;
	}

	/* The selected preview already fills its expanded 2x2 slot: at large
	   slot sizes the extra hover:scale-105 would push the 140% jigsaw
	   envelope past the slot's half-gap allowance. The unselected slot has
	   enough clearance, so only the selected preview drops the zoom. */
	.puzzle-piece[data-selected='true']:hover {
		scale: none;
	}

	/* Pending: a small pulsing dot in the otherwise dark slot. Error: a small
	   hot marker so the slot is not mistaken for an empty one. */
	.piece-image-status {
		background: rgb(58 255 255 / 6%);
	}

	.piece-image-status:not(.piece-image-error)::before {
		content: '';
		width: 10px;
		height: 10px;
		border-radius: 9999px;
		background: var(--accent);
		animation: piece-image-pulse 1.6s ease-in-out infinite;
	}

	.piece-image-error {
		color: var(--hot);
		font-family: var(--font-mono);
		font-size: 0.7rem;
		font-weight: 700;
	}

	@keyframes piece-image-pulse {
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.piece-image-status:not(.piece-image-error)::before {
			animation: none;
		}
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
