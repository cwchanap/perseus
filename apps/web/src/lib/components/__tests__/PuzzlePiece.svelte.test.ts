// Component tests for PuzzlePiece (controlled selection)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import PuzzlePiece from '../PuzzlePiece.svelte';
import type { PuzzlePiece as PuzzlePieceType } from '$lib/types/puzzle';
import { BASE_OFFSET, EXPANSION_FACTOR, TAB_RATIO } from '$lib/constants/puzzle';

const resolveImage = (piece: { id: number }) => `/test/${piece.id}.png`;

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
		vi.clearAllMocks();
	});

	describe('rendering', () => {
		it('renders with data-testid and data-piece-id attributes', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			const el = page.getByTestId('puzzle-piece');
			await expect.element(el).toBeInTheDocument();
			await expect.element(el).toHaveAttribute('data-piece-id', '7');
		});

		it('renders with correct aria-label', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-label', 'Puzzle piece 7');
		});

		it('renders the piece image with correct src', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect.element(page.getByRole('img')).toHaveAttribute('src', '/test/7.png');
		});

		it('renders the piece image with correct alt text', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect.element(page.getByRole('img')).toHaveAttribute('alt', 'Piece 7');
		});

		it('image is not draggable (prevents default browser drag)', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect.element(page.getByRole('img')).toHaveAttribute('draggable', 'false');
		});

		it('aligns the piece base image bounds with its slot', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			const image = await page.getByRole('img').element();
			const imageWrapper = image.parentElement;
			expect(imageWrapper).not.toBeNull();

			const expandedWidth = parseFloat(imageWrapper!.style.width) / 100;
			const expandedHeight = parseFloat(imageWrapper!.style.height) / 100;
			const leftOffset = parseFloat(imageWrapper!.style.left) / 100;
			const topOffset = parseFloat(imageWrapper!.style.top) / 100;

			expect(expandedWidth).toBeCloseTo(EXPANSION_FACTOR);
			expect(expandedHeight).toBeCloseTo(EXPANSION_FACTOR);
			expect(leftOffset).toBeCloseTo(-TAB_RATIO);
			expect(topOffset).toBeCloseTo(-TAB_RATIO);
			expect(leftOffset + BASE_OFFSET * expandedWidth).toBeCloseTo(0);
			expect(topOffset + BASE_OFFSET * expandedHeight).toBeCloseTo(0);
		});
	});

	describe('when not placed', () => {
		it('is draggable', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('draggable', 'true');
		});

		it('has tabindex 0 for keyboard accessibility', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '0');
		});

		it('is not marked aria-disabled', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-disabled', 'false');
		});

		it('has button role', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('role', 'button');
		});
	});

	describe('when placed', () => {
		it('is not draggable', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('draggable', 'false');
		});

		it('has tabindex -1 (removed from tab order)', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage });

			await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('tabindex', '-1');
		});

		it('is marked aria-disabled', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-disabled', 'true');
		});
	});

	describe('selection state', () => {
		it('shows data-selected=false when the selected prop is false', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: false
			});

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'false');
		});

		it('shows data-selected=true when the selected prop is true', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: true
			});

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'true');
		});

		it('shows aria-grabbed=true when selected', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: true
			});

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-grabbed', 'true');
		});

		it('shows aria-grabbed=false when not selected', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: false
			});

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-grabbed', 'false');
		});
	});

	describe('pointer interaction', () => {
		it('calls onSelect exactly once on native click', async () => {
			const onSelect = vi.fn();
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				onSelect
			});

			await page.getByTestId('puzzle-piece').click();

			expect(onSelect).toHaveBeenCalledTimes(1);
			expect(onSelect).toHaveBeenCalledWith(7);
		});

		it('reselects an already-selected piece instead of pointer-cancelling it', async () => {
			const onSelect = vi.fn();
			const onCancelSelection = vi.fn();
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: true,
				onSelect,
				onCancelSelection
			});

			await page.getByTestId('puzzle-piece').click();

			expect(onSelect).toHaveBeenCalledTimes(1);
			expect(onSelect).toHaveBeenCalledWith(7);
			expect(onCancelSelection).not.toHaveBeenCalled();
		});

		it('does not select a placed piece on click', async () => {
			const onSelect = vi.fn();
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: true,
				resolveImage,
				onSelect
			});

			await page.getByTestId('puzzle-piece').click({ force: true });

			expect(onSelect).not.toHaveBeenCalled();
		});
	});

	describe('rotation support', () => {
		it('does not render a rotate control when rotation is disabled', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			const rotateButton = page.getByRole('button', { name: 'Rotate piece 7' });
			await expect.poll(() => rotateButton.query()).toBeNull();
		});

		it('renders a rotate control when rotation is enabled for an unplaced piece', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				rotationEnabled: true
			});

			await expect.element(page.getByRole('button', { name: 'Rotate piece 7' })).toBeVisible();
		});

		it('calls onRotate when the rotate control is clicked', async () => {
			const onRotate = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				rotationEnabled: true,
				onRotate
			});

			await userEvent.click(page.getByRole('button', { name: 'Rotate piece 7' }));
			expect(onRotate).toHaveBeenCalledTimes(1);
			expect(onRotate).toHaveBeenCalledWith(7);
		});

		it('keeps the rotate control outside the piece interactive element', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				rotationEnabled: true
			});

			const pieceElement = await page.getByTestId('puzzle-piece').element();
			const rotateButton = await page.getByRole('button', { name: 'Rotate piece 7' }).element();

			expect(pieceElement.contains(rotateButton)).toBe(false);
		});

		it('rotates without selecting the piece', async () => {
			const onRotate = vi.fn();
			const onSelect = vi.fn();
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				rotationEnabled: true,
				onRotate,
				onSelect
			});

			await page.getByRole('button', { name: 'Rotate piece 7' }).click();

			expect(onRotate).toHaveBeenCalledWith(7);
			expect(onSelect).not.toHaveBeenCalled();
		});

		it('calls onRotate when r and R are pressed while the piece is focused', async () => {
			const onRotate = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				rotationEnabled: true,
				onRotate
			});

			const element = await page.getByTestId('puzzle-piece').element();
			element.focus();
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', bubbles: true }));

			expect(onRotate).toHaveBeenCalledTimes(2);
			expect(onRotate).toHaveBeenNthCalledWith(1, 7);
			expect(onRotate).toHaveBeenNthCalledWith(2, 7);
		});

		it('applies the current rotation to the piece visual', async () => {
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				rotation: 90
			});

			await expect
				.element(page.getByTestId('puzzle-piece-visual'))
				.toHaveAttribute('style', 'transform: rotate(90deg);');
		});
	});

	describe('keyboard interaction', () => {
		it('calls onSelect on Enter when not selected', async () => {
			const onSelect = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: false,
				onSelect
			});

			const element = await page.getByTestId('puzzle-piece').element();
			element.focus();
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

			expect(onSelect).toHaveBeenCalledWith(7);
		});

		it('calls onCancelSelection on Enter when this piece is already selected', async () => {
			const onCancelSelection = vi.fn();
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: true,
				onCancelSelection
			});

			const element = await page.getByTestId('puzzle-piece').element();
			element.focus();
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

			expect(onCancelSelection).toHaveBeenCalled();
		});

		it('placed pieces have tabindex=-1 so they receive no keyboard focus', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage });

			const el = page.getByTestId('puzzle-piece');
			await expect.element(el).toHaveAttribute('tabindex', '-1');
			await expect.element(el).toHaveAttribute('aria-disabled', 'true');
		});

		it('responds to Space key the same as Enter', async () => {
			const onSelect = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				selected: false,
				onSelect
			});

			const element = await page.getByTestId('puzzle-piece').element();
			element.focus();
			element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

			expect(onSelect).toHaveBeenCalledWith(7);
		});

		it('ignores other key presses', async () => {
			const onSelect = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				onSelect
			});

			const element = await page.getByTestId('puzzle-piece').element();
			element.focus();
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

			expect(onSelect).not.toHaveBeenCalled();
		});

		it('does not select a placed piece via keyboard', async () => {
			const onSelect = vi.fn();
			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: true,
				resolveImage,
				onSelect
			});

			const el = await page.getByTestId('puzzle-piece').element();
			el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

			expect(onSelect).not.toHaveBeenCalled();
		});
	});

	describe('drag interaction', () => {
		it('starts a desktop drag with the piece id in the payload', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });
			const dataTransfer = new DataTransfer();
			// Headless Chromium gates `DataTransfer.effectAllowed` to trusted
			// drag operations only, so the setter is a no-op for synthetic
			// DragEvents and a post-dispatch read always yields "none". Shadow
			// it with an own property to capture the assignment the component
			// makes during dragstart, while leaving `getData`/`setData` intact.
			let assignedEffectAllowed: string | undefined;
			Object.defineProperty(dataTransfer, 'effectAllowed', {
				configurable: true,
				get: () => assignedEffectAllowed ?? 'uninitialized',
				set: (value: string) => {
					assignedEffectAllowed = value;
				}
			});
			const piece = await page.getByTestId('puzzle-piece').element();

			piece.dispatchEvent(
				new DragEvent('dragstart', {
					bubbles: true,
					cancelable: true,
					dataTransfer
				})
			);

			expect(dataTransfer.getData('text/plain')).toBe('7');
			expect(assignedEffectAllowed).toBe('move');
		});

		it('does not start a desktop drag for a placed piece', async () => {
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage });

			const dataTransfer = new DataTransfer();
			const piece = await page.getByTestId('puzzle-piece').element();
			piece.dispatchEvent(
				new DragEvent('dragstart', {
					bubbles: true,
					cancelable: true,
					dataTransfer
				})
			);

			expect(dataTransfer.getData('text/plain')).toBe('');
		});
	});
});

describe('coarse pointer (mobile)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// Emulates a coarse (touch) pointer so the coarsePointer store reports
	// `matches: true` for `(pointer: coarse)` without relying on the host
	// browser's actual pointer type (headless Chromium defaults to fine).
	function stubPointerCoarse(coarse: boolean): void {
		const matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: query === '(pointer: coarse)' ? coarse : false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn()
		}));
		vi.stubGlobal('matchMedia', matchMedia);
	}

	it('disables native dragging for an unplaced piece on a coarse pointer', async () => {
		stubPointerCoarse(true);
		render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

		await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('draggable', 'false');
	});

	it('preserves native dragging for an unplaced piece on a fine pointer', async () => {
		stubPointerCoarse(false);
		render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

		await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('draggable', 'true');
	});

	it('stays non-draggable for a placed piece on a coarse pointer', async () => {
		stubPointerCoarse(true);
		render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage });

		await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('draggable', 'false');
	});
});
