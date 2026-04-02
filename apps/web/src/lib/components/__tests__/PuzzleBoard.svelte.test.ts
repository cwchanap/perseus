// Component test for PuzzleBoard
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleBoard from '../PuzzleBoard.svelte';
import type { Puzzle, PlacedPiece, PuzzlePiece } from '$lib/types/puzzle';

let mockSelectedId: number | null = null;

// Mock the stores
vi.mock('$lib/stores/pieceSelection', () => ({
	selectedPieceId: {
		subscribe: vi.fn((callback: (value: number | null) => void) => {
			callback(mockSelectedId);
			return () => {};
		})
	},
	clearSelectedPiece: vi.fn()
}));

// Mock the API
vi.mock('$lib/services/api', () => ({
	getPieceImageUrl: vi.fn(
		(puzzleId: string, pieceId: number) => `/api/puzzles/${puzzleId}/pieces/${pieceId}/image`
	),
	getReferenceImageUrl: vi.fn((puzzleId: string) => `/api/puzzles/${puzzleId}/reference`)
}));

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
		mockSelectedId = null;
		vi.clearAllMocks();
	});

	it('should render the puzzle board container', async () => {
		const puzzle = createMockPuzzle(3);
		const placedPieces: PlacedPiece[] = [];
		const onPiecePlaced = vi.fn();
		const onIncorrectPlacement = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces,
			onPiecePlaced,
			onIncorrectPlacement
		});

		await expect.element(page.getByTestId('puzzle-board')).toBeVisible();
	});

	it('should render placed piece images', async () => {
		const puzzle = createMockPuzzle(3);
		const placedPieces: PlacedPiece[] = [{ pieceId: 0, x: 0, y: 0 }];
		const onPiecePlaced = vi.fn();
		const onIncorrectPlacement = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces,
			onPiecePlaced,
			onIncorrectPlacement
		});

		// Check that image is rendered for placed piece
		await expect.element(page.getByRole('img').first()).toBeVisible();
	});

	it('should render a hint marker for the active hint target', async () => {
		const puzzle = createMockPuzzle(3);

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			onIncorrectPlacement: vi.fn(),
			activeHintTarget: { x: 1, y: 2 }
		});

		await expect.element(page.getByTestId('hint-target')).toBeInTheDocument();
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-y', '2');
	});

	it('should render the reference overlay when enabled', async () => {
		const puzzle = createMockPuzzle(3);

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			onIncorrectPlacement: vi.fn(),
			showReferenceOverlay: true
		});

		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();
		await expect
			.element(page.getByRole('img', { name: 'Puzzle reference' }))
			.toHaveAttribute('src', '/api/puzzles/test-puzzle/reference');
	});

	it('should reject placement when canPlacePiece returns false', async () => {
		const puzzle = createMockPuzzle(3);
		const onPiecePlaced = vi.fn();
		const onIncorrectPlacement = vi.fn();
		const canPlacePiece = vi.fn(() => false);
		mockSelectedId = 0;

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced,
			onIncorrectPlacement,
			canPlacePiece
		});

		const dropZone = await page
			.getByRole('button', { name: 'Drop zone at position 0, 0' })
			.element();
		dropZone.focus();
		dropZone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

		expect(canPlacePiece).toHaveBeenCalledWith(0);
		expect(onIncorrectPlacement).toHaveBeenCalledWith(0);
		expect(onPiecePlaced).not.toHaveBeenCalled();
	});

	it('should call onBoardPointerDown when the board receives a pointerdown event', async () => {
		const puzzle = createMockPuzzle(3);
		const onBoardPointerDown = vi.fn();

		render(PuzzleBoard, {
			puzzle,
			placedPieces: [],
			onPiecePlaced: vi.fn(),
			onIncorrectPlacement: vi.fn(),
			onBoardPointerDown
		});

		await page
			.getByTestId('puzzle-board')
			.element()
			.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		expect(onBoardPointerDown).toHaveBeenCalledOnce();
		expect(onBoardPointerDown.mock.calls[0][0]).toBeInstanceOf(PointerEvent);
	});
});
