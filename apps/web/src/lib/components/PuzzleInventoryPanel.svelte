<script lang="ts">
	import { tick } from 'svelte';
	import PuzzlePiece from '$lib/components/PuzzlePiece.svelte';
	import {
		matchesInventoryFilter,
		type InventoryFilter,
		type PlacedPiece,
		type Rotation
	} from '@perseus/game-core';
	import type { Puzzle, PuzzlePiece as PuzzlePieceModel } from '$lib/types/puzzle';
	import { MOBILE_SHEET_HEIGHT } from '$lib/services/puzzleLayout';

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
		onAnnouncement?: (message: string) => void;
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
		onShuffle,
		onAnnouncement
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

	function rotateSelectedPiece(): void {
		const pieceId = selectedPieceId;
		if (pieceId !== null) onRotate(pieceId);
	}

	function pieceSlotClass(piece: PuzzlePieceModel): string {
		const base =
			'piece-slot relative aspect-square border border-(--border) p-[0.2rem] ' +
			'transition-[border-color,box-shadow] duration-150';
		if (activeHintPieceId === piece.id) {
			return `${base} hinted border-(--gold) shadow-[0_0_14px_var(--gold-glow)]`;
		}
		if (rejectedPieceId === piece.id) {
			return `${base} rejected animate-shake border-(--hot) shadow-[0_0_12px_var(--hot-glow)]`;
		}
		return base;
	}

	type MobileSheetState = 'peek' | 'half' | 'full';
	let sheetState = $state<MobileSheetState>('half');
	const sheetHeight = $derived(MOBILE_SHEET_HEIGHT[sheetState]);
	const sheetActionLabel = $derived(
		sheetState === 'peek'
			? 'Expand piece tray to half'
			: sheetState === 'half'
				? 'Expand piece tray to full'
				: 'Collapse piece tray to peek'
	);

	function nextSheetState(): MobileSheetState {
		if (sheetState === 'peek') return 'half';
		if (sheetState === 'half') return 'full';
		return 'peek';
	}

	function cycleSheet(): void {
		sheetState = nextSheetState();
		onAnnouncement?.(`Piece tray: ${sheetState}.`);
	}

	let filterDisclosureOpen = $state(false);

	function usesDirectFilterLayout(width: number): boolean {
		return width < 1024 || width >= 1280;
	}

	function syncFilterDisclosure(): void {
		filterDisclosureOpen = usesDirectFilterLayout(window.innerWidth);
	}

	function handleFilterDisclosureToggle(event: Event): void {
		filterDisclosureOpen = (event.currentTarget as HTMLDetailsElement).open;
	}

	$effect(() => {
		syncFilterDisclosure();
		window.addEventListener('resize', syncFilterDisclosure);
		return () => window.removeEventListener('resize', syncFilterDisclosure);
	});

	// Roving tab stop: exactly one unplaced piece is sequentially tabbable,
	// and Left/Right move the active piece through the visible tray. R
	// remains a rotation shortcut on the piece root; pointer rotation lives
	// in the header ROTATE action. The id is panel-local presentation
	// state — the session's selection is untouched.
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

	async function revealHintedPiece(pieceId: number): Promise<void> {
		if (sheetState === 'peek') {
			sheetState = 'half';
			onAnnouncement?.('Piece tray: half.');
		}
		// PuzzleSession.doUseHint resets the canonical organization filter to
		// 'all' before emitting hint_target and notifying subscribers, so the
		// route observes activeFilter='all' atomically with activeHintPieceId.
		// The hinted piece is therefore always in visiblePieces by the time
		// this effect runs; the inventory owns only drawer open -> tick ->
		// roving candidate -> tick -> scrollIntoView.
		await tick();

		if (activeHintPieceId !== pieceId) return;

		activePieceId = pieceId;
		await tick();

		piecesGridElement
			?.querySelector<HTMLElement>(`[data-testid="piece-slot-${pieceId}"]`)
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	$effect(() => {
		const pieceId = activeHintPieceId;
		if (pieceId !== null) void revealHintedPiece(pieceId);
	});

	// Follow direct focus (click/tap/Tab) so the roving tab stop moves to the
	// piece the user actually reached. Resolving via the slot keeps the piece
	// resolution independent of which piece-root descendant received focus.
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

<div
	class="inventory-panel"
	data-testid="puzzle-inventory-panel"
	data-sheet-state={sheetState}
	style={`--mobile-sheet-height: ${sheetHeight}px`}
>
	<div class="panel-header">
		<span class="sheet-handle" aria-hidden="true"></span>
		<div class="panel-heading">
			<span class="panel-tag">INVENTORY</span>
			<span
				class="inv-count"
				role="status"
				aria-label={`${puzzle.pieceCount - placedPieces.length} pieces left`}
			>
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<circle cx="7" cy="7" r="2.2" /><circle cx="17" cy="7" r="2.2" /><circle
						cx="7"
						cy="17"
						r="2.2"
					/><circle cx="17" cy="17" r="2.2" />
				</svg>
				<span aria-hidden="true">{puzzle.pieceCount - placedPieces.length}</span>
			</span>
		</div>

		<div class="inventory-tools" data-testid="inventory-tools">
			<button
				type="button"
				class="panel-action"
				aria-label="All pieces"
				aria-pressed={activeFilter === 'all'}
				onclick={() => onFilterChange('all')}
			>
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<circle cx="7" cy="7" r="2.2" /><circle cx="17" cy="7" r="2.2" /><circle
						cx="7"
						cy="17"
						r="2.2"
					/><circle cx="17" cy="17" r="2.2" />
				</svg>
				<span class="panel-action-label">ALL</span>
			</button>
			<details
				class="inventory-filter-disclosure"
				data-testid="inventory-filter-disclosure"
				open={filterDisclosureOpen}
				ontoggle={handleFilterDisclosureToggle}
			>
				<summary
					class="panel-action filter-disclosure-toggle"
					aria-label="More piece filters"
					aria-controls="inventory-filter-menu"
					data-testid="inventory-filter-toggle"
					data-active={activeFilter !== 'all' ? 'true' : undefined}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-width="2" d="M4 6h16M7 12h10m-7 6h4" />
					</svg>
					<span class="panel-action-label">MORE FILTERS</span>
				</summary>
				<div
					id="inventory-filter-menu"
					class="inventory-filter-menu"
					role="group"
					aria-label="Piece filters"
				>
					<button
						type="button"
						class="panel-action"
						aria-label="Corner pieces"
						aria-pressed={activeFilter === 'corners'}
						onclick={() => onFilterChange('corners')}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 19V5h14M5 19h14" />
						</svg>
						<span class="panel-action-label">CORNERS</span>
					</button>
					<button
						type="button"
						class="panel-action"
						aria-label="Edge pieces"
						aria-pressed={activeFilter === 'edges'}
						onclick={() => onFilterChange('edges')}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path stroke-linecap="round" d="M5 19h14M5 5v14" />
						</svg>
						<span class="panel-action-label">EDGES</span>
					</button>
					<button
						type="button"
						class="panel-action"
						aria-label="Center pieces"
						aria-pressed={activeFilter === 'center'}
						onclick={() => onFilterChange('center')}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<rect x="6" y="6" width="12" height="12" rx="1.5" /><path
								stroke-linecap="round"
								d="M12 9v6m-3-3h6"
							/>
						</svg>
						<span class="panel-action-label">CENTER</span>
					</button>
					<button
						type="button"
						class="panel-action"
						aria-label="Shuffle pieces"
						disabled={unplacedPieces.length <= 1}
						onclick={onShuffle}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M4 7h2c3 0 4 2 6 5s3 5 6 5h2m-3-3l3 3-3 3M4 17h2c1.5 0 2.5-.6 3.4-1.8M15 8c1-1 1.8-1 3-1h2m-3-3l3 3-3 3"
							/>
						</svg>
						<span class="panel-action-label">SHUFFLE</span>
					</button>
				</div>
			</details>
		</div>

		<div class="panel-actions">
			{#if rotationEnabled}
				<button
					type="button"
					class="panel-action"
					aria-label="Rotate selected piece"
					disabled={selectedPieceId === null}
					onclick={rotateSelectedPiece}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M20 11a8 8 0 00-14.6-4.4L4 8m0 0V4m0 4h4M4 13a8 8 0 0014.6 4.4L20 16m0 0v4m0-4h-4"
						/>
					</svg>
					<span class="panel-action-label">ROTATE</span>
				</button>
			{/if}
			{#if selectedPieceId !== null}
				<button
					type="button"
					class="panel-action"
					aria-label="Cancel selected piece"
					onclick={onCancelSelection}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.2"
						aria-hidden="true"
					>
						<path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
					</svg>
					<span class="panel-action-label">CANCEL</span>
				</button>
			{/if}
			<button
				type="button"
				class="panel-action drawer-toggle"
				data-testid="inventory-drawer-toggle"
				aria-label={sheetActionLabel}
				aria-controls="puzzle-inventory-body"
				onclick={cycleSheet}
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M4 7h16M6 7l1 12h10l1-12M9 7V4h6v3"
					/>
				</svg>
				<span class="panel-action-label">TRAY</span>
			</button>
		</div>
	</div>

	<div class="inventory-body" id="puzzle-inventory-body">
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
					class={pieceSlotClass(piece)}
					data-testid={`piece-slot-${piece.id}`}
					data-hinted={activeHintPieceId === piece.id ? 'true' : undefined}
				>
					{#if activeHintPieceId === piece.id}
						<span class="hint-badge pointer-events-none" aria-hidden="true">HINT</span>
					{/if}
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
		position: relative;
		box-sizing: border-box;
		max-height: none;
		padding-bottom: env(safe-area-inset-bottom);
		overflow: hidden;
		background: var(--bg-1);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
	}

	.panel-header {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 0.5rem;
		padding: 0.625rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-2);
		flex-shrink: 0;
	}

	.panel-heading {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: max-content;
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

	/* Mirrors PuzzleToolbar's disabled toolbar buttons: dim + not-allowed
	   cursor, and no hover accent while disabled (ROTATE without a selection,
	   SHUFFLE with <= 1 unplaced piece). */
	.panel-action:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.panel-action:disabled:hover {
		color: var(--text-2);
		border-color: var(--border);
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
		position: static;
		grid-column: 2;
		width: 100%;
		min-width: 0;
		z-index: 2;
		display: flex;
		flex-wrap: nowrap;
		flex-shrink: 0;
		gap: 0.5rem;
		justify-content: flex-end;
		overflow-x: auto;
		overflow-y: hidden;
		padding: 0;
		border-bottom: 0;
		background: transparent;
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

	.inventory-panel[data-sheet-state='peek'] .inventory-body {
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

	.hint-badge {
		position: absolute;
		top: 0.25rem;
		left: 0.25rem;
		z-index: 20;
		padding: 0.15rem 0.3rem;
		font-family: var(--font-display);
		font-size: 0.5rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		color: var(--gold);
		background: var(--gold-glow);
		border: 1px solid var(--gold);
		box-shadow: 0 0 8px var(--gold-glow);
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
			height: var(--mobile-sheet-height);
			max-height: var(--mobile-sheet-height);
		}
	}

	/* Desktop: the drawer is a desktop sidebar, not a collapsible tray. The
	   toggle is hidden, the panel is unconstrained, and the body stays open
	   regardless of local drawer state. */
	@media (min-width: 1024px) {
		.inventory-panel {
			padding-bottom: 0;
			overflow: visible;
		}

		.pieces-grid {
			grid-template-columns: repeat(var(--tray-columns, 3), minmax(0, var(--piece-slot-size)));
			justify-content: start;
		}

		.inventory-body,
		.inventory-panel[data-sheet-state='peek'] .inventory-body {
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

	/* Arcade parity: the tray reads as a dark glass deck with an explicit
	   mobile sheet handle and icon-led controls. */
	.inventory-panel {
		background: rgba(21, 13, 51, 0.92);
		border: 1px solid var(--border-bright);
		border-radius: 1.25rem 1.25rem 0 0;
		box-shadow: 0 -12px 36px rgb(0 0 0 / 28%);
	}

	.panel-header {
		position: relative;
		min-height: 3.5rem;
		padding: 0.75rem 1rem;
		background: rgba(28, 20, 64, 0.78);
		border-bottom-color: var(--border-bright);
	}

	.sheet-handle {
		display: none;
		position: absolute;
		top: 0.45rem;
		left: 50%;
		width: 2.875rem;
		height: 0.3rem;
		transform: translateX(-50%);
		border-radius: 999px;
		background: var(--text-2);
		opacity: 0.8;
	}

	.panel-tag {
		display: none;
		font-family: var(--font-display), Orbitron, monospace;
		color: var(--text-1);
	}

	.panel-action-label {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.inv-count {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		white-space: nowrap;
		padding: 0.2rem 0.45rem;
		border: 1px solid rgb(58 255 255 / 42%);
		border-radius: 999px;
		background: var(--accent);
		font-family: var(--font-display), Orbitron, monospace;
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		font-weight: 700;
		color: #03202a;
	}

	.inv-count svg {
		width: 0.8rem;
		height: 0.8rem;
		flex: 0 0 auto;
	}

	.panel-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		min-height: 2.25rem;
		border-color: var(--border-bright);
		border-radius: 0.75rem;
		background: rgba(28, 20, 64, 0.75);
		font-family: var(--font-display), Orbitron, monospace;
	}

	.panel-action svg {
		width: 1rem;
		height: 1rem;
		flex: 0 0 auto;
		pointer-events: none;
	}

	.panel-action:hover:not(:disabled) {
		background: rgb(58 255 255 / 8%);
	}

	.inventory-tools {
		gap: 0.5rem;
		background: transparent;
	}

	.inventory-filter-disclosure {
		position: relative;
		flex: 0 0 auto;
	}

	.inventory-filter-disclosure > summary {
		display: inline-flex;
		list-style: none;
		cursor: pointer;
	}

	.inventory-filter-disclosure > summary::-webkit-details-marker {
		display: none;
	}

	.inventory-filter-disclosure > summary[data-active='true'] {
		color: var(--accent);
		border-color: var(--accent);
		background: rgb(58 255 255 / 10%);
		box-shadow: 0 0 12px rgb(58 255 255 / 14%);
	}

	.inventory-filter-disclosure:not([open]) > .inventory-filter-menu {
		display: none;
	}

	.inventory-filter-menu {
		position: absolute;
		top: calc(100% + 0.5rem);
		left: 0;
		z-index: 8;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
		min-width: 9.5rem;
		padding: 0.5rem;
		border: 1px solid var(--border-bright);
		border-radius: 1rem;
		background: rgba(21, 13, 51, 0.98);
		box-shadow: 0 12px 28px rgb(0 0 0 / 40%);
	}

	.inventory-tools .panel-action[aria-pressed='true'] {
		color: var(--accent);
		background: rgb(58 255 255 / 10%);
		border-color: var(--accent);
		box-shadow: 0 0 12px rgb(58 255 255 / 14%);
	}

	.piece-slot {
		padding: 0.25rem;
		border-color: var(--border-bright);
		border-radius: 0.875rem;
		background: rgba(10, 6, 32, 0.72);
		box-shadow: inset 0 0 14px rgb(58 255 255 / 4%);
	}

	.piece-slot:hover,
	.piece-slot:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 14px rgb(58 255 255 / 16%);
	}

	@media (max-width: 1023px) {
		.inventory-panel {
			border-radius: 1.25rem 1.25rem 0 0;
		}

		.sheet-handle {
			display: block;
		}

		.panel-header {
			padding-top: 1.1rem;
		}

		.inventory-tools {
			gap: 0.25rem;
			overflow-x: auto;
			overflow-y: hidden;
		}

		.panel-heading {
			padding-left: 0.25rem;
		}

		.panel-actions .panel-action,
		.inventory-tools .panel-action {
			width: 2.75rem;
			min-width: 2.75rem;
			min-height: 2.75rem;
			padding: 0;
		}

		.inventory-tools {
			justify-content: flex-start;
		}

		.inventory-tools .panel-action svg {
			width: 1.15rem;
			height: 1.15rem;
		}

		.inventory-filter-disclosure {
			display: contents;
		}

		.inventory-filter-disclosure > summary {
			display: none;
		}

		.inventory-filter-disclosure > .inventory-filter-menu {
			position: static;
			display: contents;
			padding: 0;
			border: 0;
			background: transparent;
			box-shadow: none;
		}

		.inventory-filter-disclosure:not([open]) > .inventory-filter-menu {
			display: contents;
		}
	}

	@media (min-width: 1024px) and (max-width: 1279px) {
		.inventory-panel {
			overflow: visible;
		}

		.panel-header {
			grid-template-columns: minmax(3.5rem, max-content) minmax(0, 1fr) auto;
			column-gap: 0.25rem;
		}

		.inventory-tools {
			gap: 0.25rem;
			justify-content: flex-start;
			overflow: visible;
		}

		.panel-actions {
			gap: 0.25rem;
		}

		.panel-actions .panel-action,
		.inventory-tools .panel-action {
			width: 2.75rem;
			min-width: 2.75rem;
			min-height: 2.75rem;
			padding: 0;
		}

		.inventory-tools .panel-action svg {
			width: 1.15rem;
			height: 1.15rem;
		}
	}

	@media (min-width: 1280px) {
		.inventory-filter-disclosure {
			display: contents;
		}

		.inventory-filter-disclosure > summary {
			display: none;
		}

		.inventory-filter-disclosure > .inventory-filter-menu {
			position: static;
			display: contents;
			padding: 0;
			border: 0;
			background: transparent;
			box-shadow: none;
		}

		.inventory-filter-disclosure:not([open]) > .inventory-filter-menu {
			display: contents;
		}
	}
</style>
