<script lang="ts">
	import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
	import type { Rotation } from '$lib/types/gameplay';
	import type { PlacedPiece, Puzzle, PuzzlePiece as PuzzlePieceModel } from '$lib/types/puzzle';

	interface Props {
		puzzle: Puzzle;
		trayOrder: number[];
		placedPieces: PlacedPiece[];
		rotationEnabled: boolean;
		pieceRotations: Record<number, Rotation>;
		selectedPieceId: number | null;
		activeHintPieceId: number | null;
		rejectedPieceId: number | null;
		resolveImage: (piece: Pick<PuzzlePieceModel, 'id'>) => string;
		onRotate: (pieceId: number) => void;
		onSelect: (pieceId: number) => void;
		onCancelSelection: () => void;
	}

	let {
		puzzle,
		trayOrder,
		placedPieces,
		rotationEnabled,
		pieceRotations,
		selectedPieceId,
		activeHintPieceId,
		rejectedPieceId,
		resolveImage,
		onRotate,
		onSelect,
		onCancelSelection
	}: Props = $props();

	const placedPieceIds = $derived.by(
		() => new Set(placedPieces.map((placement) => placement.pieceId))
	);

	const piecesById = $derived.by(
		() => new Map(puzzle.pieces.map((piece) => [piece.id, piece] as const))
	);

	const orderedPieces = $derived(
		trayOrder
			.map((id) => piecesById.get(id))
			.filter((piece): piece is PuzzlePieceModel => piece !== undefined)
	);

	function displayedRotation(pieceId: number): Rotation {
		return rotationEnabled ? (pieceRotations[pieceId] ?? 0) : 0;
	}

	// Binary drawer state. Kept private to this panel: the route owns canonical
	// session state (selectedPieceId, tray order); the drawer's open/collapsed
	// presentation is a purely local UI concern and is never serialized.
	let drawerOpen = $state(true);
</script>

<div class="inventory-panel" class:drawer-open={drawerOpen} data-testid="puzzle-inventory-panel">
	<div class="panel-header">
		<div class="panel-heading">
			<span class="panel-tag">INVENTORY</span>
			<span class="inv-count">{puzzle.pieceCount - placedPieces.length} LEFT</span>
		</div>

		<div class="panel-actions">
			{#if selectedPieceId !== null}
				<button
					type="button"
					class="panel-action"
					aria-label="Cancel selected piece"
					onclick={onCancelSelection}
				>
					CANCEL
				</button>
			{/if}
			<button
				type="button"
				class="panel-action drawer-toggle"
				data-testid="inventory-drawer-toggle"
				aria-label={drawerOpen ? 'Collapse inventory' : 'Open inventory'}
				aria-expanded={drawerOpen}
				aria-controls="puzzle-inventory-body"
				onclick={() => (drawerOpen = !drawerOpen)}
			>
				{drawerOpen ? 'COLLAPSE' : 'OPEN'}
			</button>
		</div>
	</div>

	<div class="inventory-body" id="puzzle-inventory-body">
		<div class="pieces-grid">
			{#each orderedPieces as piece (piece.id)}
				{#if !placedPieceIds.has(piece.id)}
					<div
						class={`piece-slot aspect-square border border-(--border) p-[0.2rem] transition-[border-color,box-shadow] duration-150 ${
							activeHintPieceId === piece.id
								? 'hinted border-(--accent) shadow-[0_0_14px_var(--accent-glow)]'
								: rejectedPieceId === piece.id
									? 'rejected animate-shake border-(--hot) shadow-[0_0_12px_var(--hot-glow)]'
									: ''
						}`}
						data-testid={`piece-slot-${piece.id}`}
					>
						<PuzzlePiece
							{piece}
							isPlaced={false}
							{rotationEnabled}
							rotation={displayedRotation(piece.id)}
							{onRotate}
							{resolveImage}
							selected={selectedPieceId === piece.id}
							{onSelect}
							{onCancelSelection}
						/>
					</div>
				{/if}
			{/each}
		</div>
		{#if placedPieces.length === puzzle.pieceCount}
			<div class="complete-msg">
				<span class="complete-icon">◆</span>
				ALL PIECES PLACED
			</div>
		{/if}
	</div>
</div>

<style>
	.inventory-panel {
		box-sizing: border-box;
		max-height: 16rem;
		padding-bottom: env(safe-area-inset-bottom);
		overflow: hidden;
		background: var(--bg-1);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.625rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-2);
		flex-shrink: 0;
	}

	.panel-heading {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.panel-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.panel-action {
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		color: var(--text-2);
		background: transparent;
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}

	.panel-action:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	/* Coarse-pointer (mobile) controls must meet the same 44px touch target as
	   .puzzle-piece and .drop-zone (see routes/layout.css). Desktop pointers are
	   unaffected: the buttons keep their compact sizing for mouse/trackpad use. */
	@media (pointer: coarse) {
		.panel-action {
			min-height: 44px;
		}
	}

	.panel-tag {
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.inv-count {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.15em;
	}

	.inventory-body {
		min-height: 0;
		display: flex;
		flex: 1;
		flex-direction: column;
		overflow: hidden;
	}

	.inventory-panel:not(.drawer-open) .inventory-body {
		display: none;
	}

	.pieces-grid {
		display: grid;
		grid-template-columns: repeat(
			auto-fill,
			minmax(var(--piece-slot-size), var(--piece-slot-size))
		);
		justify-content: center;
		align-content: start;
		gap: var(--inventory-gap);
		padding: var(--inventory-pad);
		min-height: 0;
		overflow-y: auto;
		overflow-x: clip;
		flex: 1;
	}

	.piece-slot {
		width: var(--piece-slot-size);
		height: var(--piece-slot-size);
	}

	.complete-msg {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.875rem;
		font-family: var(--font-display);
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.2em;
		color: var(--green);
		text-shadow: 0 0 12px var(--green);
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}

	.complete-icon {
		font-size: 0.5rem;
		text-shadow: 0 0 8px var(--green);
	}

	/* Mobile-only tray preview size. Below 1024px the tray decouples from the
	   board-derived slot size and uses a viewport-fluid preview. Desktop
	   inherits --piece-slot-size from .game-layout (never reset to initial). */
	@media (max-width: 1023px) {
		.inventory-panel {
			--piece-slot-size: clamp(3rem, 16vw, 4.5rem);
		}
	}

	/* Desktop: the drawer is a desktop sidebar, not a collapsible tray. The
	   toggle is hidden, the panel is unconstrained, and the body stays open
	   regardless of local drawer state. */
	@media (min-width: 1024px) {
		.inventory-panel {
			max-height: none;
			padding-bottom: 0;
			overflow: visible;
		}

		.inventory-body,
		.inventory-panel:not(.drawer-open) .inventory-body {
			display: flex;
		}

		.drawer-toggle {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.piece-slot.rejected {
			animation: none;
			box-shadow: none;
		}
	}
</style>
