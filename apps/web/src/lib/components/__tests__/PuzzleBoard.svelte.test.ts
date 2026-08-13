// Component test for PuzzleBoard (controlled selection)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleBoard from '../PuzzleBoard.svelte';
import type { Puzzle, PlacedPiece, PuzzlePiece } from '$lib/types/puzzle';
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

		const dropZone = await page
			.getByRole('button', { name: 'Drop zone at position 1, 0' })
			.element();
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

		const dropZone = await page
			.getByRole('button', { name: 'Drop zone at position 0, 0' })
			.element();
		dropZone.focus();
		dropZone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

		expect(onPiecePlaced).not.toHaveBeenCalled();
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
		const dropZone = await page
			.getByRole('button', { name: 'Drop zone at position 1, 0' })
			.element();
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

		const dropZone = await page
			.getByRole('button', { name: 'Drop zone at position 0, 0' })
			.element();
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

		const dropZone = await page
			.getByRole('button', { name: 'Drop zone at position 0, 0' })
			.element();
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
});
