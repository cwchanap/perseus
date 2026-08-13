import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleInventoryPanel from '../PuzzleInventoryPanel.svelte';
import type { Puzzle } from '$lib/types/puzzle';

const image = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const puzzle: Puzzle = {
	id: 'inventory-test',
	name: 'Inventory Test',
	pieceCount: 2,
	gridCols: 2,
	gridRows: 1,
	imageWidth: 200,
	imageHeight: 100,
	createdAt: 1704067200000,
	pieces: [
		{
			id: 0,
			puzzleId: 'inventory-test',
			correctX: 0,
			correctY: 0,
			imagePath: 'pieces/0.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 1,
			puzzleId: 'inventory-test',
			correctX: 1,
			correctY: 0,
			imagePath: 'pieces/1.png',
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'tab' }
		}
	]
};

function baseProps() {
	return {
		puzzle,
		trayOrder: [1, 0],
		placedPieces: [],
		rotationEnabled: true,
		pieceRotations: { 0: 0 as const, 1: 90 as const },
		selectedPieceId: null,
		activeHintPieceId: null,
		rejectedPieceId: null,
		resolveImage: () => image,
		onRotate: vi.fn(),
		onSelect: vi.fn(),
		onCancelSelection: vi.fn()
	};
}

describe('PuzzleInventoryPanel', () => {
	it('filters placed pieces and preserves hinted precedence', async () => {
		render(PuzzleInventoryPanel, {
			...baseProps(),
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			selectedPieceId: 1,
			activeHintPieceId: 1,
			rejectedPieceId: 1
		});

		await expect.element(page.getByText('1 LEFT')).toBeVisible();
		expect(document.querySelector('[data-testid="piece-slot-0"]')).toBeNull();
		const slot = document.querySelector('[data-testid="piece-slot-1"]');
		expect(slot).not.toBeNull();
		expect(slot?.className).toContain('hinted');
		expect(slot?.className).not.toContain('rejected');
	});

	it('preserves rejected presentation when no hint is active', async () => {
		render(PuzzleInventoryPanel, {
			...baseProps(),
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			rejectedPieceId: 1
		});

		const slot = document.querySelector('[data-testid="piece-slot-1"]');
		expect(slot).not.toBeNull();
		expect(slot?.className).toContain('rejected');
		expect(slot?.className).not.toContain('hinted');
	});

	it('renders unplaced pieces in tray order', async () => {
		render(PuzzleInventoryPanel, baseProps());
		const slots = Array.from(
			document.querySelectorAll<HTMLElement>('[data-testid^="piece-slot-"]')
		);
		expect(slots.map((slot) => slot.dataset.testid)).toEqual(['piece-slot-1', 'piece-slot-0']);
	});

	it('forwards select, rotate, and cancel selection', async () => {
		const input = baseProps();
		const view = render(PuzzleInventoryPanel, input);

		const piece = await page.getByLabelText('Puzzle piece 1').element();
		piece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(input.onSelect).toHaveBeenCalledWith(1);

		await page.getByLabelText('Rotate piece 1').click();
		expect(input.onRotate).toHaveBeenCalledWith(1);

		await view.rerender({ ...input, selectedPieceId: 1 });
		const selectedPiece = await page.getByLabelText('Puzzle piece 1').element();
		selectedPiece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(input.onCancelSelection).toHaveBeenCalledOnce();
	});

	it('renders pieces with zero rotation when rotation is disabled', async () => {
		render(PuzzleInventoryPanel, { ...baseProps(), rotationEnabled: false });
		// Piece 1 has a stored rotation of 90, but with rotationEnabled=false
		// the displayed rotation should be 0.
		const slot1 = await page.getByTestId('piece-slot-1').element();
		const visual = slot1.querySelector('[data-testid="puzzle-piece-visual"]');
		expect(visual?.getAttribute('style') ?? '').not.toContain('rotate(90deg)');
	});

	it('defaults to zero rotation when a piece has no stored rotation entry', async () => {
		render(PuzzleInventoryPanel, {
			...baseProps(),
			pieceRotations: { 1: 90 }
		});
		// Piece 0 has no entry in pieceRotations; the ?? 0 fallback should apply.
		const slot0 = await page.getByTestId('piece-slot-0').element();
		const visual = slot0.querySelector('[data-testid="puzzle-piece-visual"]');
		expect(visual?.getAttribute('style') ?? '').toContain('rotate(0deg)');
	});

	it('shows the all-pieces-placed message when every piece is placed', async () => {
		render(PuzzleInventoryPanel, {
			...baseProps(),
			placedPieces: [
				{ pieceId: 0, x: 0, y: 0 },
				{ pieceId: 1, x: 1, y: 0 }
			]
		});
		await expect.element(page.getByText('ALL PIECES PLACED')).toBeVisible();
		expect(page.getByTestId('piece-slot-0').query()).toBeNull();
		expect(page.getByTestId('piece-slot-1').query()).toBeNull();
	});

	it('shows Cancel only while a piece is selected and forwards it', async () => {
		const input = baseProps();
		const view = render(PuzzleInventoryPanel, input);

		expect(page.getByRole('button', { name: 'Cancel selected piece' }).query()).toBeNull();

		await view.rerender({ ...input, selectedPieceId: 1 });
		await page.getByRole('button', { name: 'Cancel selected piece' }).click();
		expect(input.onCancelSelection).toHaveBeenCalledOnce();
	});

	it('starts open and toggles binary state without changing tray contents', async () => {
		render(PuzzleInventoryPanel, baseProps());
		const toggle = (await page
			.getByTestId('inventory-drawer-toggle')
			.element()) as HTMLButtonElement;

		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(toggle.getAttribute('aria-controls')).toBe('puzzle-inventory-body');
		expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);

		toggle.click();
		await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false');
		expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);

		toggle.click();
		await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true');
		expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);
	});

	it('keeps Cancel in the header while collapsed', async () => {
		render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });
		const toggle = (await page
			.getByTestId('inventory-drawer-toggle')
			.element()) as HTMLButtonElement;
		toggle.click();
		await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false');

		await expect
			.element(page.getByRole('button', { name: 'Cancel selected piece' }))
			.toBeInTheDocument();
	});
});
