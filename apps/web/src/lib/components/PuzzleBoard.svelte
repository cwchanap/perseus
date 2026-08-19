<script lang="ts">
	import type { Puzzle, PuzzlePiece, PlacedPiece } from '$lib/types/puzzle';
	import { EXPANSION_FACTOR, TAB_RATIO } from '$lib/constants/puzzle';

	interface Props {
		puzzle: Puzzle;
		placedPieces: PlacedPiece[];
		onPiecePlaced: (pieceId: number, x: number, y: number) => void;
		activeHintTarget?: { x: number; y: number } | null;
		onBoardPointerDown?: (event: PointerEvent) => void;
		resolveImage: (piece: PuzzlePiece) => string;
		selectedPieceId?: number | null;
	}

	let {
		puzzle,
		placedPieces,
		onPiecePlaced,
		activeHintTarget = null,
		onBoardPointerDown,
		resolveImage,
		selectedPieceId = null
	}: Props = $props();

	let dragOverCell: { x: number; y: number } | null = $state(null);
	let boardElement = $state<HTMLElement | null>(null);
	let activeCell = $state({ x: 0, y: 0 });
	const puzzleIdentity = $derived(puzzle.id);

	// Reset the roving position whenever a different puzzle mounts.
	$effect(() => {
		void puzzleIdentity;
		activeCell = { x: 0, y: 0 };
	});

	function isPiecePlaced(x: number, y: number, excludePieceId?: number): PlacedPiece | undefined {
		return placedPieces.find((p) => p.x === x && p.y === y && p.pieceId !== excludePieceId);
	}

	function getPieceAtPosition(x: number, y: number): PuzzlePiece | undefined {
		const placed = isPiecePlaced(x, y);
		if (!placed) return undefined;
		return puzzle.pieces.find((p) => p.id === placed.pieceId);
	}

	function handleDragOver(event: DragEvent, x: number, y: number) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		dragOverCell = { x, y };
	}

	function handleDragLeave() {
		dragOverCell = null;
	}

	function placePiece(pieceId: number, x: number, y: number): void {
		const piece = puzzle.pieces.find((p) => p.id === pieceId);
		if (!piece) return;

		// Route every valid piece/coordinate to the session via onPiecePlaced.
		// The session engine determines accept vs. reject and emits
		// placement_rejected for rejected attempts; the route drives the shake
		// animation from that event. Filtering here would bypass the session's
		// canonical counter/timer/rejection logic.
		onPiecePlaced(pieceId, x, y);
	}

	function handleDrop(event: DragEvent, x: number, y: number) {
		event.preventDefault();
		dragOverCell = null;

		if (!event.dataTransfer) return;

		const pieceIdStr = event.dataTransfer.getData('text/plain');
		if (!pieceIdStr) return;

		const pieceId = parseInt(pieceIdStr, 10);
		if (Number.isNaN(pieceId)) return;

		placePiece(pieceId, x, y);
	}

	function handleKeyDown(event: KeyboardEvent, x: number, y: number) {
		if (moveCellFocus(event, x, y)) return;
		if (event.key !== 'Enter' && event.key !== ' ') return;
		if (selectedPieceId === null) return;
		event.preventDefault();
		// The session engine clears selectedPieceId on accepted placements;
		// on rejected placements the selection is retained so the user can
		// try another cell. placePiece routes the attempt to the session.
		placePiece(selectedPieceId, x, y);
	}

	// Spatial roving: arrow keys move the single tab stop to a neighbor cell,
	// clamped at the board edges (non-wrapping). Returns true when the event
	// was an arrow key so placement handling is skipped for it.
	function moveCellFocus(event: KeyboardEvent, x: number, y: number): boolean {
		const delta = {
			ArrowLeft: { dx: -1, dy: 0 },
			ArrowRight: { dx: 1, dy: 0 },
			ArrowUp: { dx: 0, dy: -1 },
			ArrowDown: { dx: 0, dy: 1 }
		}[event.key];
		if (!delta) return false;

		event.preventDefault();
		const nextX = Math.max(0, Math.min(puzzle.gridCols - 1, x + delta.dx));
		const nextY = Math.max(0, Math.min(puzzle.gridRows - 1, y + delta.dy));
		activeCell = { x: nextX, y: nextY };
		boardElement
			?.querySelector<HTMLElement>(
				`[data-testid="drop-zone"][data-x="${nextX}"][data-y="${nextY}"]`
			)
			?.focus();
		return true;
	}

	// Track the cell that received focus so the roving tab stop follows any
	// direct focus (click/tap/Tab into a cell).
	function handleBoardFocusIn(event: FocusEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const cell = target.closest<HTMLElement>('[data-testid="drop-zone"]');
		if (!cell) return;
		const x = Number(cell.dataset.x);
		const y = Number(cell.dataset.y);
		if (Number.isInteger(x) && Number.isInteger(y)) activeCell = { x, y };
	}

	// Native (non-delegated) action for tap/click placement. It carries no
	// parameter and reads its coordinates from the node's existing dataset,
	// keeping placePiece()/handleKeyDown() correctness-free: every selected
	// click is routed to the session, which owns accept/reject.
	function dropZoneInteraction(node: HTMLElement) {
		function coordinates(): { x: number; y: number } | null {
			const x = Number(node.dataset.x);
			const y = Number(node.dataset.y);
			if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
			return { x, y };
		}

		function handleClick() {
			if (selectedPieceId === null) return;
			const cell = coordinates();
			if (!cell) return;
			placePiece(selectedPieceId, cell.x, cell.y);
		}

		function handleNativeKeyDown(event: KeyboardEvent) {
			const cell = coordinates();
			if (!cell) return;
			handleKeyDown(event, cell.x, cell.y);
		}

		node.addEventListener('click', handleClick);
		node.addEventListener('keydown', handleNativeKeyDown);
		return {
			destroy() {
				node.removeEventListener('click', handleClick);
				node.removeEventListener('keydown', handleNativeKeyDown);
			}
		};
	}

	function getCellStyle(x: number, y: number): string {
		const isOver = dragOverCell?.x === x && dragOverCell?.y === y;
		const hasPlaced = isPiecePlaced(x, y);

		if (hasPlaced) return 'bg-transparent';
		if (isOver) return 'bg-blue-100 border-blue-400';
		return 'bg-gray-100 border-gray-300';
	}

	function isHintTarget(x: number, y: number): boolean {
		return activeHintTarget?.x === x && activeHintTarget?.y === y;
	}

	function handleBoardPointerDown(event: PointerEvent) {
		onBoardPointerDown?.(event);
	}
</script>

<div
	bind:this={boardElement}
	class="puzzle-board grid gap-0 rounded-lg bg-gray-200 p-1"
	style="
		grid-template-columns: repeat({puzzle.gridCols}, 1fr);
		grid-template-rows: repeat({puzzle.gridRows}, 1fr);
		aspect-ratio: {puzzle.imageWidth} / {puzzle.imageHeight};
	"
	role="group"
	aria-label="Puzzle board"
	data-testid="puzzle-board"
	onpointerdown={handleBoardPointerDown}
	onfocusin={handleBoardFocusIn}
>
	{#each Array(puzzle.gridRows) as _, y (y)}
		{#each Array(puzzle.gridCols) as _, x (x)}
			{@const placedPiece = getPieceAtPosition(x, y)}
			<div
				class="drop-zone relative overflow-visible border border-dashed transition-colors {getCellStyle(
					x,
					y
				)}"
				ondragover={(e) => handleDragOver(e, x, y)}
				ondragleave={handleDragLeave}
				ondrop={(e) => handleDrop(e, x, y)}
				use:dropZoneInteraction
				data-testid="drop-zone"
				data-x={x}
				data-y={y}
				role="button"
				tabindex={activeCell.x === x && activeCell.y === y ? 0 : -1}
				aria-label={`Row ${y + 1}, column ${x + 1}, ${
					placedPiece ? `occupied by puzzle piece ${placedPiece.id}` : 'empty'
				}`}
			>
				{#if isHintTarget(x, y)}
					<div
						class="
							pointer-events-none absolute inset-1 rounded-md border-2 border-(--gold)
							bg-(--gold-glow)
						"
						data-testid="hint-target"
						data-x={x}
						data-y={y}
						aria-hidden="true"
					></div>
				{/if}

				{#if placedPiece}
					<!-- Pre-masked jigsaw piece from server (140% size, offset to align base with cell) -->
					<div
						class="placed-piece-shadow pointer-events-none absolute"
						style="
							z-index: {y * puzzle.gridCols + x + 1};
							width: {EXPANSION_FACTOR * 100}%;
							height: {EXPANSION_FACTOR * 100}%;
							left: -{TAB_RATIO * 100}%;
							top: -{TAB_RATIO * 100}%;
						"
					>
						<img src={resolveImage(placedPiece)} alt="Placed piece" class="h-full w-full" />
					</div>
				{/if}
			</div>
		{/each}
	{/each}
</div>

<style>
	/* Subtle shadow for placed pieces */
	.placed-piece-shadow {
		filter: drop-shadow(1px 2px 3px rgba(0, 0, 0, 0.15));
	}
</style>
