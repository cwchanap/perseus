<script lang="ts">
	import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
	import type { ResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';
	import type { Rotation } from '$lib/types/gameplay';
	import type { PlacedPiece, Puzzle, PuzzlePiece as PuzzlePieceModel } from '$lib/types/puzzle';

	interface Props {
		puzzle: Puzzle;
		boardMetrics: ResponsivePuzzleBoardMetrics | null;
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
		boardMetrics,
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
</script>

<div class="inventory-panel">
	<div class="panel-header">
		<span class="panel-tag">INVENTORY</span>
		<span class="inv-count">{puzzle.pieceCount - placedPieces.length} LEFT</span>
	</div>
	<div class="pieces-grid">
		{#each orderedPieces as piece (piece.id)}
			{#if !placedPieceIds.has(piece.id)}
				<div
					class={`piece-slot aspect-square border border-(--border) p-[0.2rem] transition-[border-color,box-shadow] duration-150 ${
						activeHintPieceId === piece.id
							? 'hinted border-(--accent) shadow-[0_0_14px_var(--accent-glow)]'
							: ''
					} ${
						rejectedPieceId === piece.id
							? 'rejected animate-shake border-(--hot) shadow-[0_0_12px_var(--hot-glow)]'
							: ''
					}`}
					style={boardMetrics ? `--piece-slot-size: ${boardMetrics.pieceSlotSize}px;` : ''}
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

<style>
	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-2);
	}

	.panel-tag {
		font-family: var(--font-display);
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.inventory-panel {
		background: var(--bg-1);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}

	.inv-count {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.15em;
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
		overflow-y: auto;
		flex: 1;
	}

	@media (min-width: 640px) and (max-width: 1023px) {
		.pieces-grid {
			grid-template-columns: repeat(
				auto-fill,
				minmax(var(--piece-slot-size), var(--piece-slot-size))
			);
		}
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
	}

	.complete-icon {
		font-size: 0.5rem;
		text-shadow: 0 0 8px var(--green);
	}

	@media (prefers-reduced-motion: reduce) {
		.piece-slot.rejected {
			box-shadow: none;
		}
	}
</style>
