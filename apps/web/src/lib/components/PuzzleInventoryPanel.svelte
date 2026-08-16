<script lang="ts">
	import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
	import { matchesInventoryFilter } from '$lib/services/gameplay/inventory';
	import type { InventoryFilter } from '$lib/services/gameplay/session/types';
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
		activeFilter: InventoryFilter;
		onFilterChange: (filter: InventoryFilter) => void;
		onShuffle: () => void;
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
		onCancelSelection,
		activeFilter,
		onFilterChange,
		onShuffle
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

	const unplacedPieces = $derived(orderedPieces.filter((piece) => !placedPieceIds.has(piece.id)));

	const visiblePieces = $derived(
		unplacedPieces.filter((piece) => matchesInventoryFilter(piece, puzzle, activeFilter))
	);

	function displayedRotation(pieceId: number): Rotation {
		return rotationEnabled ? (pieceRotations[pieceId] ?? 0) : 0;
	}

	// Binary drawer state. Kept private to this panel: the route owns canonical
	// session state (selectedPieceId, tray order); the drawer's open/collapsed
	// presentation is a purely local UI concern and is never serialized.
	let drawerOpen = $state(true);

	// Roving tab stop: exactly one unplaced piece is sequentially tabbable,
	// and Left/Right move the active piece through the visible tray. The
	// active piece's Rotate button shares the roving tabIndex so it stays
	// keyboard-discoverable; R remains an additional shortcut on the piece
	// root. The id is panel-local presentation state — the session's
	// selection is untouched.
	let piecesGridElement = $state<HTMLElement | null>(null);
	let activePieceId = $state<number | null>(null);

	// Keep the roving id on a visible piece: prefer the current active id,
	// then the selected piece, then the first visible piece. Filters and
	// placements that remove the active piece therefore restore exactly one
	// tab stop.
	$effect(() => {
		const ids = visiblePieces.map((piece) => piece.id);
		if (activePieceId !== null && ids.includes(activePieceId)) return;
		activePieceId =
			selectedPieceId !== null && ids.includes(selectedPieceId)
				? selectedPieceId
				: (ids[0] ?? null);
	});

	// Follow direct focus (click/tap/Tab) so the roving tab stop moves to the
	// piece the user actually reached. Resolving via the slot lets focus on
	// either the active root or its sibling Rotate button keep the same piece.
	function handlePiecesFocusIn(event: FocusEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const slot = target.closest<HTMLElement>('.piece-slot');
		const piece = slot?.querySelector<HTMLElement>('[data-testid="puzzle-piece"]');
		const id = Number(piece?.dataset.pieceId);
		if (Number.isInteger(id)) activePieceId = id;
	}

	// Native (non-delegated) listener so traversal fires exactly once per
	// keydown regardless of re-renders. Left/Right-only: no Up/Down, no
	// geometry — the tray is a single linear list of visible pieces.
	function handlePiecesKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		// The Rotate button is a leaf control inside the piece slot. Arrow
		// traversal is owned by the piece roots; when focus is on the Rotate
		// button, let the browser handle the key (e.g. native Tab order) so
		// the visible Rotate control stays an independent focusable element.
		// This check is here rather than relying on the Rotate button's
		// delegated stopPropagation, which fires after this native ancestor
		// listener and cannot prevent it.
		if (target.closest('[data-testid="rotate-piece-button"]')) return;
		const slot = target.closest<HTMLElement>('.piece-slot');
		const current = slot?.querySelector<HTMLElement>('[data-testid="puzzle-piece"]');
		const currentId = Number(current?.dataset.pieceId);
		if (!Number.isInteger(currentId)) return;

		const index = visiblePieces.findIndex((piece) => piece.id === currentId);
		if (index < 0) return;
		event.preventDefault();
		const nextIndex = event.key === 'ArrowRight' ? index + 1 : index - 1;
		const nextPiece = visiblePieces[nextIndex];
		if (!nextPiece) return;

		activePieceId = nextPiece.id;
		piecesGridElement
			?.querySelector<HTMLElement>(`[data-testid="puzzle-piece"][data-piece-id="${nextPiece.id}"]`)
			?.focus();
	}

	function piecesGridKeyboardAction(node: HTMLElement) {
		node.addEventListener('keydown', handlePiecesKeyDown);
		return {
			destroy() {
				node.removeEventListener('keydown', handlePiecesKeyDown);
			}
		};
	}
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
		<div class="inventory-tools" data-testid="inventory-tools">
			<button
				type="button"
				class="panel-action"
				aria-label="All pieces"
				aria-pressed={activeFilter === 'all'}
				onclick={() => onFilterChange('all')}>ALL</button
			>
			<button
				type="button"
				class="panel-action"
				aria-label="Corner pieces"
				aria-pressed={activeFilter === 'corners'}
				onclick={() => onFilterChange('corners')}>CORNERS</button
			>
			<button
				type="button"
				class="panel-action"
				aria-label="Edge pieces"
				aria-pressed={activeFilter === 'edges'}
				onclick={() => onFilterChange('edges')}>EDGES</button
			>
			<button
				type="button"
				class="panel-action"
				aria-label="Center pieces"
				aria-pressed={activeFilter === 'center'}
				onclick={() => onFilterChange('center')}>CENTER</button
			>
			<button
				type="button"
				class="panel-action"
				aria-label="Shuffle pieces"
				disabled={unplacedPieces.length <= 1}
				onclick={onShuffle}>SHUFFLE</button
			>
		</div>
		<div
			bind:this={piecesGridElement}
			use:piecesGridKeyboardAction
			class="pieces-grid"
			role="group"
			aria-label="Available puzzle pieces"
			onfocusin={handlePiecesFocusIn}
		>
			{#each visiblePieces as piece (piece.id)}
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
						tabIndex={activePieceId === piece.id ? 0 : -1}
					/>
				</div>
			{/each}
		</div>
		{#if unplacedPieces.length > 0 && visiblePieces.length === 0}
			<div class="filter-empty-msg" data-testid="inventory-filter-empty">NO PIECES MATCH</div>
		{/if}
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

	/* Active inventory filter: aria-pressed alone is invisible to sighted
	   users, so mirror PuzzleToolbar's pressed Rotation button and give the
	   active filter a distinct accent border/fill. Scoped to the tools row so
	   the CANCEL and drawer-toggle actions (no aria-pressed) are unaffected. */
	.inventory-tools .panel-action[aria-pressed='true'] {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--accent-glow);
		box-shadow: 0 0 10px var(--accent-glow);
	}

	.inventory-tools .panel-action[aria-pressed='true']:hover {
		background: var(--accent-glow);
	}

	/* Coarse-pointer (mobile) controls must meet the same 44px touch target as
	   .puzzle-piece and .drop-zone (see routes/layout.css). Desktop pointers are
	   unaffected: the buttons keep their compact sizing for mouse/trackpad use. */
	@media (pointer: coarse) {
		.panel-action {
			min-height: 44px;
		}
	}

	.inventory-tools {
		display: flex;
		flex-wrap: nowrap;
		flex-shrink: 0;
		gap: 0.5rem;
		overflow-x: auto;
		padding: 0.5rem 0.875rem;
		border-bottom: 1px solid var(--border);
	}

	.inventory-tools .panel-action {
		flex: 0 0 auto;
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

	.filter-empty-msg {
		flex-shrink: 0;
		padding: 0.75rem;
		border-top: 1px solid var(--border);
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.15em;
		text-align: center;
		color: var(--text-2);
	}

	/* Mobile-only tray preview size. Below 1024px the tray decouples from the
	   board-derived slot size and uses a viewport-fluid preview. Desktop
	   inherits --piece-slot-size from .game-layout (never reset to initial). */
	@media (max-width: 1023px) {
		.inventory-panel {
			--piece-slot-size: clamp(3rem, 16vw, 4.5rem);
			max-height: 20rem;
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
