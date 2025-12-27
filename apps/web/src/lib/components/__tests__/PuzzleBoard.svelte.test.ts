// Component test for PuzzleBoard
import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import PuzzleBoard from '../PuzzleBoard.svelte';
import type { Puzzle, PlacedPiece, PuzzlePiece } from '$lib/types/puzzle';

// Mock the stores
vi.mock('$lib/stores/pieceSelection', () => ({
	selectedPieceId: {
		subscribe: vi.fn((callback) => {
			callback(null);
			return () => {};
		})
	},
	clearSelectedPiece: vi.fn()
}));

// Mock the API
vi.mock('$lib/services/api', () => ({
	getPieceImageUrl: vi.fn(
		(puzzleId: string, pieceId: number) => `/api/puzzles/${puzzleId}/pieces/${pieceId}/image`
	)
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
});
