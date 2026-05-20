// Component tests for PuzzlePiece
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import PuzzlePiece from '../PuzzlePiece.svelte';
import type { PuzzlePiece as PuzzlePieceType } from '$lib/types/puzzle';
import { BASE_OFFSET, EXPANSION_FACTOR, TAB_RATIO } from '$lib/constants/puzzle';

const resolveImage = (piece: { id: number }) => `/test/${piece.id}.png`;

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

function makeTouch(identifier: number, clientX: number, clientY: number): Touch {
	return {
		identifier,
		clientX,
		clientY
	} as Touch;
}

function makeTouchList(...touches: Touch[]): TouchList {
	return Object.assign(touches, {
		item: (index: number) => touches[index] ?? null
	}) as unknown as TouchList;
}

function dispatchTouch(
	target: EventTarget,
	type: string,
	options: { touches?: Touch[]; changedTouches?: Touch[] }
): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		touches: { value: makeTouchList(...(options.touches ?? [])) },
		changedTouches: { value: makeTouchList(...(options.changedTouches ?? [])) }
	});
	target.dispatchEvent(event);
	return event;
}

function appendDropZone(id: string): HTMLElement {
	const dropZone = document.createElement('div');
	dropZone.className = 'drop-zone';
	dropZone.dataset.testDropZone = id;
	document.body.appendChild(dropZone);
	return dropZone;
}

describe('PuzzlePiece', () => {
	beforeEach(() => {
		mockSelectedId = null;
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.querySelectorAll('[data-test-drop-zone]').forEach((element) => element.remove());
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
		it('shows data-selected=false when no piece is selected', async () => {
			mockSelectedId = null;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'false');
		});

		it('shows data-selected=false when a different piece is selected', async () => {
			mockSelectedId = 99;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'false');
		});

		it('shows data-selected=true when this piece is selected', async () => {
			mockSelectedId = 7;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('data-selected', 'true');
		});

		it('shows aria-grabbed=true when this piece is selected', async () => {
			mockSelectedId = 7;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-grabbed', 'true');
		});

		it('shows aria-grabbed=false when not selected', async () => {
			mockSelectedId = null;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			await expect
				.element(page.getByTestId('puzzle-piece'))
				.toHaveAttribute('aria-grabbed', 'false');
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

		it('calls onRotate when r and R are pressed while the piece is focused', async () => {
			const onRotate = vi.fn();

			render(PuzzlePiece, {
				piece: mockPiece,
				isPlaced: false,
				resolveImage,
				rotationEnabled: true,
				onRotate
			});

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('r');
			await userEvent.keyboard('R');

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
		it('calls setSelectedPiece and onDragStart on Enter when not selected', async () => {
			mockSelectedId = null;
			const onDragStart = vi.fn();

			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage, onDragStart });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('{Enter}');

			expect(vi.mocked(setSelectedPiece)).toHaveBeenCalledWith(7);
			expect(onDragStart).toHaveBeenCalledWith(mockPiece);
		});

		it('calls clearSelectedPiece on Enter when this piece is already selected', async () => {
			mockSelectedId = 7;
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('{Enter}');

			expect(vi.mocked(clearSelectedPiece)).toHaveBeenCalled();
		});

		it('placed pieces have tabindex=-1 so they receive no keyboard focus', async () => {
			// When isPlaced=true the component sets tabindex=-1 and aria-disabled=true,
			// removing the piece from the tab order so users cannot keyboard-activate it.
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage });

			const el = page.getByTestId('puzzle-piece');
			await expect.element(el).toHaveAttribute('tabindex', '-1');
			await expect.element(el).toHaveAttribute('aria-disabled', 'true');
		});

		it('responds to Space key the same as Enter', async () => {
			mockSelectedId = null;
			const onDragStart = vi.fn();

			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage, onDragStart });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard(' ');

			expect(vi.mocked(setSelectedPiece)).toHaveBeenCalledWith(7);
			expect(onDragStart).toHaveBeenCalledWith(mockPiece);
		});

		it('ignores other key presses', async () => {
			const onDragStart = vi.fn();

			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage, onDragStart });

			const el = page.getByTestId('puzzle-piece');
			await el.click();
			await userEvent.keyboard('a');

			expect(vi.mocked(setSelectedPiece)).not.toHaveBeenCalled();
			expect(onDragStart).not.toHaveBeenCalled();
		});
	});

	describe('drag interaction', () => {
		it('starts a desktop drag with the piece id in the drag payload', async () => {
			const onDragStart = vi.fn();
			render(PuzzlePiece, { piece: mockPiece, isPlaced: false, resolveImage, onDragStart });

			const dataTransfer = new DataTransfer();
			const pieceElement = await page.getByTestId('puzzle-piece').element();
			pieceElement.dispatchEvent(
				new DragEvent('dragstart', {
					bubbles: true,
					cancelable: true,
					dataTransfer
				})
			);

			expect(dataTransfer.getData('text/plain')).toBe('7');
			expect(onDragStart).toHaveBeenCalledWith(mockPiece);
		});

		it('does not start a desktop drag for a placed piece', async () => {
			const onDragStart = vi.fn();
			render(PuzzlePiece, { piece: mockPiece, isPlaced: true, resolveImage, onDragStart });

			const dataTransfer = new DataTransfer();
			const pieceElement = await page.getByTestId('puzzle-piece').element();
			pieceElement.dispatchEvent(
				new DragEvent('dragstart', {
					bubbles: true,
					cancelable: true,
					dataTransfer
				})
			);

			expect(dataTransfer.getData('text/plain')).toBe('');
			expect(onDragStart).not.toHaveBeenCalled();
		});

		it('moves a touch drag across drop zones and drops with a DataTransfer payload', async () => {
			const onDragStart = vi.fn();
			const onDragMove = vi.fn();
			const onDragEnd = vi.fn();
			const firstDropZone = appendDropZone('first');
			const secondDropZone = appendDropZone('second');
			let elementAtPoint: Element | null = firstDropZone;
			const elementFromPointSpy = vi
				.spyOn(document, 'elementFromPoint')
				.mockImplementation(() => elementAtPoint);
			const firstDragLeave = vi.fn();
			const secondDragOver = vi.fn();
			const dropPayloads: string[] = [];
			firstDropZone.addEventListener('dragleave', firstDragLeave);
			secondDropZone.addEventListener('dragover', secondDragOver);
			secondDropZone.addEventListener('drop', (event) => {
				dropPayloads.push((event as DragEvent).dataTransfer?.getData('text/plain') ?? '');
			});

			try {
				render(PuzzlePiece, {
					piece: mockPiece,
					isPlaced: false,
					resolveImage,
					onDragStart,
					onDragMove,
					onDragEnd
				});

				const pieceElement = await page.getByTestId('puzzle-piece').element();
				dispatchTouch(pieceElement, 'touchstart', {
					changedTouches: [makeTouch(10, 100, 120)]
				});
				const firstMoveEvent = dispatchTouch(window, 'touchmove', {
					touches: [makeTouch(10, 130, 150)]
				});
				elementAtPoint = secondDropZone;
				const moveEvent = dispatchTouch(window, 'touchmove', {
					touches: [makeTouch(10, 140, 160)]
				});
				dispatchTouch(window, 'touchmove', { touches: [makeTouch(10, 150, 170)] });
				dispatchTouch(window, 'touchend', { changedTouches: [makeTouch(10, 150, 170)] });

				expect(firstMoveEvent.defaultPrevented).toBe(true);
				expect(moveEvent.defaultPrevented).toBe(true);
				expect(onDragStart).toHaveBeenCalledWith(mockPiece);
				expect(onDragMove).toHaveBeenCalledWith(mockPiece, 130, 150);
				expect(onDragMove).toHaveBeenCalledWith(mockPiece, 140, 160);
				expect(onDragMove).toHaveBeenCalledWith(mockPiece, 150, 170);
				expect(firstDragLeave).toHaveBeenCalledOnce();
				expect(secondDragOver).toHaveBeenCalledTimes(2);
				expect(dropPayloads).toEqual(['7']);
				expect(onDragEnd).toHaveBeenCalledWith(mockPiece, 150, 170);
			} finally {
				elementFromPointSpy.mockRestore();
			}
		});

		it('uses synthetic drag events and fallback DataTransfer during touch drops when needed', async () => {
			vi.stubGlobal('DataTransfer', undefined);
			vi.stubGlobal('DragEvent', function UnsupportedDragEvent() {
				throw new TypeError('DragEvent unsupported');
			});

			const onDragStart = vi.fn();
			const fallbackDropZone = appendDropZone('fallback');
			const elementFromPointSpy = vi
				.spyOn(document, 'elementFromPoint')
				.mockImplementation(() => fallbackDropZone);
			const dropPayloads: string[] = [];
			fallbackDropZone.addEventListener('drop', (event) => {
				const dataTransfer = (event as DragEvent).dataTransfer!;
				dropPayloads.push(dataTransfer.getData('text/plain'));
				expect(dataTransfer.types).toEqual(['text/plain']);

				const firstItem = dataTransfer.items[0];
				expect(firstItem.kind).toBe('string');
				expect(firstItem.type).toBe('text/plain');
				expect(firstItem.getAsFile()).toBeNull();
				firstItem.getAsString((value) => {
					dropPayloads.push(value);
				});

				dataTransfer.setData('text/plain', 'updated');
				expect(dataTransfer.getData('text/plain')).toBe('updated');
				dataTransfer.setData('text/html', '<b>Piece</b>');
				expect(dataTransfer.types).toEqual(['text/plain', 'text/html']);
				dataTransfer.clearData('text/html');
				expect(dataTransfer.types).toEqual(['text/plain']);
				dataTransfer.clearData();
				expect(dataTransfer.types).toEqual([]);
			});

			try {
				render(PuzzlePiece, {
					piece: mockPiece,
					isPlaced: false,
					resolveImage,
					onDragStart
				});

				const pieceElement = await page.getByTestId('puzzle-piece').element();
				dispatchTouch(pieceElement, 'touchstart', {
					changedTouches: [makeTouch(1, 20, 30)]
				});
				dispatchTouch(pieceElement, 'touchstart', {
					changedTouches: [makeTouch(2, 30, 40)]
				});
				dispatchTouch(window, 'touchend', { changedTouches: [makeTouch(2, 35, 45)] });

				expect(onDragStart).toHaveBeenCalledTimes(2);
				expect(dropPayloads).toEqual(['7', '7']);
			} finally {
				elementFromPointSpy.mockRestore();
			}
		});
	});
});
