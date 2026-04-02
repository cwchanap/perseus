// Component tests for PuzzlePiece
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import PuzzlePiece from '../PuzzlePiece.svelte';
import type { PuzzlePiece as PuzzlePieceType } from '$lib/types/puzzle';

// Track which piece id is "selected" in the store mock
let mockSelectedId: number | null = null;

vi.mock('$lib/stores/pieceSelection', () => {
	const setSelectedPiece = vi.fn();
	const clearSelectedPiece = vi.fn();
	return {
		selectedPieceId: {
			// Captures mockSelectedId by reference so tests can set it before render
			subscribe: vi.fn((callback: (v: number | null) => void) => {
				callback(mockSelectedId);
				return () => {};
			})
		},
		setSelectedPiece,
		clearSelectedPiece
	};
});

vi.mock('$lib/services/api', () => ({
	getPieceImageUrl: vi.fn(
		(puzzleId: string, pieceId: number) => `/api/puzzles/${puzzleId}/pieces/${pieceId}/image`
	)
}));

// Import the mocked modules so we can inspect calls in tests
import { setSelectedPiece, clearSelectedPiece } from '$lib/stores/pieceSelection';

const mockPiece: PuzzlePieceType = {
	id: 7,
	puzzleId: 'puzzle-abc',
	correctX: 2,
	correctY: 1,
	edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' },
	imagePath: 'pieces/7.png'
};

describe('PuzzlePiece', () => {
	beforeEach(() => {
		mockSelectedId = null;
		vi.clearAllMocks();
	});

	describe('rendering', () => {
		it('renders with data-testid and data-piece-id attributes', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			const el = page.getByTestId('puzzle-piece');
			await expect.element(el).toBeInTheDocument();
			await expect.element(el).toHaveAttribute('data-piece-id', '7');
		});

		it('renders with correct aria-label', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-label', 'Puzzle piece 7');
		});

		it('renders the piece image with correct src', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByRole('img'))
				.toHaveAttribute('src', '/api/puzzles/puzzle-abc/pieces/7/image');
		});

		it('renders the piece image with correct alt text', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect.element(page.getByRole('img')).toHaveAttribute('alt', 'Piece 7');
		});

		it('image is not draggable (prevents default browser drag)', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect.element(page.getByRole('img')).toHaveAttribute('draggable', 'false');
		});
	});

	describe('when not placed', () => {
		it('is draggable', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('draggable', 'true');
		});

		it('has tabindex 0 for keyboard accessibility', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '0');
		});

		it('is not marked aria-disabled', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-disabled', 'false');
		});

		it('has button role', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('role', 'button');
		});
	});

	describe('when placed', () => {
		it('is not draggable', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('draggable', 'false');
		});

		it('has tabindex -1 (removed from tab order)', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '-1');
		});

		it('is marked aria-disabled', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-disabled', 'true');
		});
	});

	describe('selection state', () => {
		it('shows data-selected=false when no piece is selected', async () => {
			mockSelectedId = null;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'false');
		});

		it('shows data-selected=false when a different piece is selected', async () => {
			mockSelectedId = 99;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'false');
		});

		it('shows data-selected=true when this piece is selected', async () => {
			mockSelectedId = 7;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'true');
		});

		it('shows aria-grabbed=true when this piece is selected', async () => {
			mockSelectedId = 7;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-grabbed', 'true');
		});

		it('shows aria-grabbed=false when not selected', async () => {
			mockSelectedId = null;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-grabbed', 'false');
		});
	});

	describe('rotation support', () => {
		it('does not render a rotate control when rotation is disabled', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			const rotateButton = page.getByRole('button', { name: 'Rotate piece 7' });
			await expect.poll(() => rotateButton.query()).toBeNull();
		});

		it('renders a rotate control when rotation is enabled for an unplaced piece', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				rotationEnabled: true
			});

			await expect.element(page.getByRole('button', { name: 'Rotate piece 7' })).toBeVisible();
		});

		it('calls onRotate when the rotate control is clicked', async () => {
			const onRotate = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				rotationEnabled: true,
				onRotate
			});

			await userEvent.click(page.getByRole('button', { name: 'Rotate piece 7' }));
			expect(onRotate).toHaveBeenCalledWith(7);
		});

		it('keeps the rotate control outside the piece interactive element', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				rotationEnabled: true
			});

			const pieceElement = await page.getByTestId('puzzle-piece').element();
			const rotateButton = await page.getByRole('button', { name: 'Rotate piece 7' }).element();

			expect(pieceElement.contains(rotateButton)).toBe(false);
		});

		it('calls onRotate when r and R are pressed while the piece is focused', async () => {
			const onRotate = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				rotationEnabled: true,
				onRotate
			});

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('r');
			await userEvent.keyboard('R');

			expect(onRotate).toHaveBeenNthCalledWith(1, 7);
			expect(onRotate).toHaveBeenNthCalledWith(2, 7);
		});

		it('applies the current rotation to the piece visual', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				rotation: 90
			});

			await expect
				.element(page.getByTestId('puzzle-piece-visual'))
				.toHaveAttribute('style', 'transform: rotate(90deg);');
		});
	});

	describe('keyboard interaction', () => {
		it('calls setSelectedPiece and onDragStart on Enter when not selected', async () => {
			mockSelectedId = null;
			const onDragStart = vi.fn();

			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, onDragStart });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('{Enter}');

			expect(vi.mocked(setSelectedPiece)).toHaveBeenCalledWith(7);
			expect(onDragStart).toHaveBeenCalledWith(mockPiece);
		});

		it('calls clearSelectedPiece on Enter when this piece is already selected', async () => {
			mockSelectedId = 7;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('{Enter}');

			expect(vi.mocked(clearSelectedPiece)).toHaveBeenCalled();
		});

		it('placed pieces have tabindex=-1 so they receive no keyboard focus', async () => {
			// When isPlaced=true the component sets tabindex=-1 and aria-disabled=true,
			// removing the piece from the tab order so users cannot keyboard-activate it.
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true });

			const el = page.getByTestId('puzzle-piece');
			await expect.element(el).toHaveAttribute('tabindex', '-1');
			await expect.element(el).toHaveAttribute('aria-disabled', 'true');
		});

		it('responds to Space key the same as Enter', async () => {
			mockSelectedId = null;
			const onDragStart = vi.fn();

			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, onDragStart });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard(' ');

			expect(vi.mocked(setSelectedPiece)).toHaveBeenCalledWith(7);
			expect(onDragStart).toHaveBeenCalledWith(mockPiece);
		});

		it('ignores other key presses', async () => {
			const onDragStart = vi.fn();

			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, onDragStart });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('a');

			expect(vi.mocked(setSelectedPiece)).not.toHaveBeenCalled();
			expect(onDragStart).not.toHaveBeenCalled();
		});
	});
});
