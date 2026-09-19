// Component test for PuzzleBoard (controlled selection)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { tick } from 'svelte';
import PuzzleBoard from '../PuzzleBoard.svelte';
import type { Puzzle, PuzzlePiece } from '$lib/types/puzzle';
import type { PlacedPiece } from '@perseus/game-core';
import { BASE_OFFSET, EXPANSION_FACTOR, TAB_RATIO } from '$lib/constants/puzzle';

const resolveImage = (piece: { id: number }) => `/test/${piece.id}.png`;
const PIXEL_PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0v8AAAAASUVORK5CYII=';
const resolveImageData = (_piece: { id: number }) => PIXEL_PNG;

function createMockPuzzle(gridSize: number = 3): Puzzle {
	const pieces: PuzzlePiece[] = [];
	for (let y = 0; y < gridSize; y++) {
		for (let x = 0; x < gridSize; x++) {
			const id = y * gridSize + x;
			pieces.push({
				id,
				puzzleId: 'test-puzzle',
				correctX: x,
				correctY: y,
				edges: {
					top: y === 0 ? 'flat' : 'tab',
					right: x === gridSize - 1 ? 'flat' : 'blank',
					bottom: y === gridSize - 1 ? 'flat' : 'blank',
					left: x === 0 ? 'flat' : 'tab'
				},
				imagePath: `pieces/${id}.png`
			});
		}
	}

	return {
		id: 'test-puzzle',
		name: 'Test Puzzle',
		pieceCount: gridSize * gridSize,
		gridCols: gridSize,
		gridRows: gridSize,
		imageWidth: 300,
		imageHeight: 300,
		pieces,
		createdAt: Date.now()
	};
}

describe('PuzzleBoard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should render the puzzle board container', async () => {
		const puzzle = createMockPuzzle(3);
		const placedPieces: PlacedPiece[] = [];
		const onPiecePlaced = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces,
			onPiecePlaced,
			resolveImage
		});

		await expect.element(page.getByTestId('puzzle-board')).toBeVisible();
	});

	it('should render placed piece images', async () => {
		const puzzle = createMockPuzzle(3);
		const placedPieces: PlacedPiece[] = [{ pieceId: 0, x: 0, y: 0 }];
		const onPiecePlaced = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces,
			onPiecePlaced,
			resolveImage: resolveImageData
		});

		const placedImage = page.getByRole('img').first();
		// The component-test environment does not generate Tailwind utilities, so
		// the placed img's `h-full w-full` classes do not apply and the img falls
		// back to its intrinsic dimensions. A 404 src (e.g. `/test/0.png`) yields a
		// 0x0 rect, which makes toBeVisible() fail non-deterministically depending
		// on image-load timing. Use a real 1x1 PNG data URI so the img has stable
		// non-zero intrinsic dimensions and toBeVisible() is deterministic while
		// still catching display:none / visibility:hidden regressions.
		await expect.element(placedImage).toBeVisible();
		await expect.element(placedImage).toHaveAttribute('alt', 'Placed piece');
		await expect.element(placedImage).toHaveAttribute('src', PIXEL_PNG);
	});

	it('should align placed piece base image bounds with the drop zone', async () => {
		const puzzle = createMockPuzzle(3);
		const placedPieces: PlacedPiece[] = [{ pieceId: 0, x: 0, y: 0 }];

		render(PuzzleBoard, {
			puzzle,
			placedPieces,
			onPiecePlaced: vi.fn(),
			resolveImage
		});

		const placedImage = await page.getByRole('img').first().element();
		const placedWrapper = placedImage.parentElement;
		expect(placedWrapper).not.toBeNull();

		const expandedWidth = parseFloat(placedWrapper!.style.width) / 100;
		const expandedHeight = parseFloat(placedWrapper!.style.height) / 100;
		const leftOffset = parseFloat(placedWrapper!.style.left) / 100;
		const topOffset = parseFloat(placedWrapper!.style.top) / 100;

		expect(expandedWidth).toBeCloseTo(EXPANSION_FACTOR);
		expect(expandedHeight).toBeCloseTo(EXPANSION_FACTOR);
		expect(leftOffset).toBeCloseTo(-TAB_RATIO);
		expect(topOffset).toBeCloseTo(-TAB_RATIO);
		expect(leftOffset + BASE_OFFSET * expandedWidth).toBeCloseTo(0);
		expect(topOffset + BASE_OFFSET * expandedHeight).toBeCloseTo(0);
	});

	it('should render a hint marker for the active hint target', async () => {
		const puzzle = createMockPuzzle(3);

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			activeHintTarget: { x: 1, y: 2 },
			resolveImage
		});

		await expect.element(page.getByTestId('hint-target')).toBeInTheDocument();
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-y', '2');
	});

	it('should route every keyboard placement attempt to onPiecePlaced (session decides accept/reject)', async () => {
		const puzzle = createMockPuzzle(3);
		const onPiecePlaced = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced,
			selectedPieceId: 0,
			resolveImage
		});

		const dropZone = await page.getByRole('button', { name: 'Row 1, column 2, empty' }).element();
		dropZone.focus();
		dropZone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

		// Even though piece 0's correct slot is (0,0), the board routes the
		// attempt to the session via onPiecePlaced without filtering.
		expect(onPiecePlaced).toHaveBeenCalledWith(0, 1, 0);
	});

	it('should not act on keyboard placement when no piece is selected', async () => {
		const puzzle = createMockPuzzle(3);
		const onPiecePlaced = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced,
			selectedPieceId: null,
			resolveImage
		});

		const dropZone = await page.getByRole('button', { name: 'Row 1, column 1, empty' }).element();
		dropZone.focus();
		dropZone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

		expect(onPiecePlaced).not.toHaveBeenCalled();
	});

	it('should expose exactly one board-cell tab stop regardless of grid size', async () => {
		const puzzle = createMockPuzzle(10);
		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			resolveImage
		});

		const board = await page.getByTestId('puzzle-board').element();
		const cells = Array.from(board.querySelectorAll<HTMLElement>('[data-testid="drop-zone"]'));
		expect(cells).toHaveLength(100);
		expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
	});

	it('should rove focus Right then Down across board cells without wrapping', async () => {
		const puzzle = createMockPuzzle(3);
		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			resolveImage
		});

		const start = await page.getByRole('button', { name: 'Row 1, column 1, empty' }).element();
		start.focus();
		start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

		const right = await page.getByRole('button', { name: 'Row 1, column 2, empty' }).element();
		expect(document.activeElement).toBe(right);

		right.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

		const down = await page.getByRole('button', { name: 'Row 2, column 2, empty' }).element();
		expect(document.activeElement).toBe(down);
	});

	it('should clamp arrow movement at the board edges (Left/Up on the first cell)', async () => {
		const puzzle = createMockPuzzle(3);
		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			resolveImage
		});

		const start = await page.getByRole('button', { name: 'Row 1, column 1, empty' }).element();
		start.focus();
		start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

		expect(document.activeElement).toBe(start);
	});

	it('should label cells with one-based row/column names and occupancy', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			onPiecePlaced: vi.fn(),
			resolveImage: resolveImageData
		});

		await expect
			.element(page.getByRole('button', { name: 'Row 1, column 1, occupied by puzzle piece 0' }))
			.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Row 1, column 2, empty' }))
			.toBeInTheDocument();
	});

	it('routes selected click exactly once without pre-validating correctness', async () => {
		const puzzle = createMockPuzzle(3);
		const onPiecePlaced = vi.fn();
		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced,
			selectedPieceId: 0,
			resolveImage
		});

		// Grid cells render 0×0 in the component-test environment (no Tailwind
		// `grid` class), so Playwright actionability-based click cannot target
		// them. Dispatch a real `click` event on the node, which exercises the
		// same native click listener a tap/pointer click would trigger.
		const dropZone = await page.getByRole('button', { name: 'Row 1, column 2, empty' }).element();
		dropZone.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(onPiecePlaced).toHaveBeenCalledTimes(1);
		expect(onPiecePlaced).toHaveBeenCalledWith(0, 1, 0);
	});

	it('does nothing on cell click without a selected piece', async () => {
		const onPiecePlaced = vi.fn();
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [],
			onPiecePlaced,
			selectedPieceId: null,
			resolveImage
		});

		const dropZone = await page.getByRole('button', { name: 'Row 1, column 1, empty' }).element();
		dropZone.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(onPiecePlaced).not.toHaveBeenCalled();
	});

	it('should call onBoardPointerDown when the board receives a pointerdown event', async () => {
		const puzzle = createMockPuzzle(3);
		const onBoardPointerDown = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			onBoardPointerDown,
			resolveImage
		});

		await page
			.getByTestId('puzzle-board')
			.element()
			.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		expect(onBoardPointerDown).toHaveBeenCalledOnce();
		expect(onBoardPointerDown.mock.calls[0][0]).toBeInstanceOf(PointerEvent);
	});

	it('should route a desktop drag/drop placement to onPiecePlaced regardless of correctness', async () => {
		const puzzle = createMockPuzzle(3);
		const onPiecePlaced = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced,
			resolveImage
		});

		const dropZone = await page.getByRole('button', { name: 'Row 1, column 1, empty' }).element();
		const dataTransfer = new DataTransfer();
		dataTransfer.setData('text/plain', '0');

		dropZone.dispatchEvent(
			new DragEvent('dragover', {
				bubbles: true,
				cancelable: true,
				dataTransfer
			})
		);
		dropZone.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
		dropZone.dispatchEvent(
			new DragEvent('drop', {
				bubbles: true,
				cancelable: true,
				dataTransfer
			})
		);

		expect(onPiecePlaced).toHaveBeenCalledWith(0, 0, 0);
	});

	it('ignores focusin that does not originate from a drop zone', async () => {
		const puzzle = createMockPuzzle(3);
		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			resolveImage
		});

		const board = await page.getByTestId('puzzle-board').element();
		const cells = Array.from(board.querySelectorAll<HTMLElement>('[data-testid="drop-zone"]'));
		const activeBefore = cells.find((cell) => cell.tabIndex === 0)!;
		expect(activeBefore).toBeDefined();

		// A focusin bubbling up from the board container itself (not a drop
		// zone) must not reassign the roving cell tab stop.
		board.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

		const activeAfter = cells.find((cell) => cell.tabIndex === 0)!;
		expect(activeAfter).toBe(activeBefore);
	});

	it('exposes data-candidate-enabled only while a piece is selected', async () => {
		const puzzle = createMockPuzzle(3);

		const unselected = render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			selectedPieceId: null,
			resolveImage
		});
		const unselectedBoard = await page.getByTestId('puzzle-board').element();
		expect(unselectedBoard.getAttribute('data-candidate-enabled')).toBeNull();
		unselected.unmount();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			selectedPieceId: 0,
			resolveImage
		});
		await expect
			.element(page.getByTestId('puzzle-board'))
			.toHaveAttribute('data-candidate-enabled', 'true');
	});

	it('changes an empty cell baseline styling while selected even without hover', async () => {
		const puzzle = createMockPuzzle(3);

		const unselected = render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			selectedPieceId: null,
			resolveImage
		});
		const unselectedCell = await page
			.getByRole('button', { name: 'Row 1, column 2, empty' })
			.element();
		const unselectedColor = getComputedStyle(unselectedCell).backgroundColor;
		unselected.unmount();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			selectedPieceId: 0,
			resolveImage
		});
		const selectedCell = await page
			.getByRole('button', { name: 'Row 1, column 2, empty' })
			.element();
		const selectedColor = getComputedStyle(selectedCell).backgroundColor;

		expect(selectedColor).not.toBe(unselectedColor);
	});

	it('keeps occupied cells out of the candidate baseline while selected', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			onPiecePlaced: vi.fn(),
			selectedPieceId: 1,
			resolveImage: resolveImageData
		});

		const occupied = await page
			.getByRole('button', { name: 'Row 1, column 1, occupied by puzzle piece 0' })
			.element();
		expect(occupied.className).toContain('cell-occupied');
		expect(occupied.className).not.toContain('cell-empty');
		// The occupied background (#0a0620) must be untouched by candidate styling.
		expect(getComputedStyle(occupied).backgroundColor).toBe('rgb(10, 6, 32)');
	});

	it('still marks the dragged-over cell with cell-drop-over while selected', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			selectedPieceId: 0,
			resolveImage
		});

		const dropZone = await page.getByRole('button', { name: 'Row 1, column 2, empty' }).element();
		dropZone.dispatchEvent(
			new DragEvent('dragover', {
				bubbles: true,
				cancelable: true,
				dataTransfer: new DataTransfer()
			})
		);
		await tick();

		expect(dropZone.className).toContain('cell-drop-over');
	});

	it('renders accepted placement feedback on the exact cell', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			placementFeedback: { x: 1, y: 2, kind: 'accepted' },
			resolveImage
		});

		const feedback = page.getByTestId('placement-feedback');
		await expect.element(feedback).toHaveAttribute('data-kind', 'accepted');
		await expect.element(feedback).toHaveAttribute('data-x', '1');
		await expect.element(feedback).toHaveAttribute('data-y', '2');
		expect(getComputedStyle(await feedback.element()).pointerEvents).toBe('none');
	});

	it('renders rejected placement feedback on the exact cell', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			placementFeedback: { x: 2, y: 0, kind: 'rejected' },
			resolveImage
		});

		const feedback = page.getByTestId('placement-feedback');
		await expect.element(feedback).toHaveAttribute('data-kind', 'rejected');
		await expect.element(feedback).toHaveAttribute('data-x', '2');
		await expect.element(feedback).toHaveAttribute('data-y', '0');
	});

	it('styles accepted and rejected feedback distinctly', async () => {
		const puzzle = createMockPuzzle(3);

		const accepted = render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			placementFeedback: { x: 0, y: 1, kind: 'accepted' },
			resolveImage
		});
		const acceptedStyle = getComputedStyle(await page.getByTestId('placement-feedback').element());
		accepted.unmount();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			placementFeedback: { x: 0, y: 1, kind: 'rejected' },
			resolveImage
		});
		const rejectedStyle = getComputedStyle(await page.getByTestId('placement-feedback').element());

		// Distinguishable without hue perception (color-blind safe): the
		// treatments must differ in shape, not just color.
		expect(rejectedStyle.backgroundColor).not.toBe(acceptedStyle.backgroundColor);
		expect(rejectedStyle.borderStyle).not.toBe(acceptedStyle.borderStyle);
	});

	it('renders accepted feedback even when the target cell is occupied', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [{ pieceId: 4, x: 1, y: 2 }],
			onPiecePlaced: vi.fn(),
			placementFeedback: { x: 1, y: 2, kind: 'accepted' },
			resolveImage: resolveImageData
		});

		const cell = await page
			.getByRole('button', { name: 'Row 3, column 2, occupied by puzzle piece 4' })
			.element();
		expect(cell.className).toContain('cell-occupied');
		await expect
			.element(page.getByTestId('placement-feedback'))
			.toHaveAttribute('data-kind', 'accepted');
	});

	it('renders placement feedback and the hint target together', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			activeHintTarget: { x: 1, y: 2 },
			placementFeedback: { x: 1, y: 2, kind: 'rejected' },
			resolveImage
		});

		await expect.element(page.getByTestId('placement-feedback')).toBeInTheDocument();
		await expect.element(page.getByTestId('hint-target')).toBeInTheDocument();
	});

	it('stacks placement feedback above every placed piece', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			// (2,2) is the highest-z placed slot: y * cols + x + 1 = 9.
			placedPieces: [{ pieceId: 8, x: 2, y: 2 }],
			onPiecePlaced: vi.fn(),
			placementFeedback: { x: 2, y: 2, kind: 'accepted' },
			resolveImage: resolveImageData
		});

		const feedbackZ = parseInt(
			getComputedStyle(await page.getByTestId('placement-feedback').element()).zIndex,
			10
		);
		const placedZ = parseInt(
			getComputedStyle(document.querySelector('.placed-piece-shadow')!).zIndex,
			10
		);
		expect(feedbackZ).toBeGreaterThan(placedZ);
	});

	it('stacks the hint target above placement feedback', async () => {
		render(PuzzleBoard, {
			puzzle: createMockPuzzle(3),
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			activeHintTarget: { x: 0, y: 0 },
			placementFeedback: { x: 0, y: 0, kind: 'accepted' },
			resolveImage
		});

		const feedbackZ = parseInt(
			getComputedStyle(await page.getByTestId('placement-feedback').element()).zIndex,
			10
		);
		const hintZ = parseInt(
			getComputedStyle(await page.getByTestId('hint-target').element()).zIndex,
			10
		);
		expect(hintZ).toBeGreaterThan(feedbackZ);
	});
});
