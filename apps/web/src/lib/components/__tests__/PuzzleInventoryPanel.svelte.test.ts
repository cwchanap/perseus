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

const filterPuzzle: Puzzle = {
	id: 'filter-test',
	name: 'Filter Test',
	pieceCount: 9,
	gridCols: 3,
	gridRows: 3,
	imageWidth: 300,
	imageHeight: 300,
	createdAt: 1704067200000,
	pieces: [
		{
			id: 0,
			puzzleId: 'filter-test',
			correctX: 0,
			correctY: 0,
			imagePath: 'pieces/0.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 1,
			puzzleId: 'filter-test',
			correctX: 1,
			correctY: 0,
			imagePath: 'pieces/1.png',
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'tab' }
		},
		{
			id: 2,
			puzzleId: 'filter-test',
			correctX: 2,
			correctY: 0,
			imagePath: 'pieces/2.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 3,
			puzzleId: 'filter-test',
			correctX: 0,
			correctY: 1,
			imagePath: 'pieces/3.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 4,
			puzzleId: 'filter-test',
			correctX: 1,
			correctY: 1,
			imagePath: 'pieces/4.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 5,
			puzzleId: 'filter-test',
			correctX: 2,
			correctY: 1,
			imagePath: 'pieces/5.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 6,
			puzzleId: 'filter-test',
			correctX: 0,
			correctY: 2,
			imagePath: 'pieces/6.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 7,
			puzzleId: 'filter-test',
			correctX: 1,
			correctY: 2,
			imagePath: 'pieces/7.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 8,
			puzzleId: 'filter-test',
			correctX: 2,
			correctY: 2,
			imagePath: 'pieces/8.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
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
		onCancelSelection: vi.fn(),
		activeFilter: 'all' as const,
		onFilterChange: vi.fn(),
		onShuffle: vi.fn()
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

	it('renders only unplaced pieces matching the controlled filter while keeping total LEFT', async () => {
		render(PuzzleInventoryPanel, {
			...baseProps(),
			puzzle: filterPuzzle,
			trayOrder: filterPuzzle.pieces.map((piece) => piece.id),
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			activeFilter: 'corners'
		});

		await expect.element(page.getByText('8 LEFT')).toBeVisible();
		expect(page.getByTestId('piece-slot-0').query()).toBeNull();
		await expect.element(page.getByTestId('piece-slot-2')).toBeVisible();
		await expect.element(page.getByTestId('piece-slot-6')).toBeVisible();
		await expect.element(page.getByTestId('piece-slot-8')).toBeVisible();
		expect(page.getByTestId('piece-slot-4').query()).toBeNull();
	});

	it('forwards all four filter values and exposes pressed state', async () => {
		const input = baseProps();
		render(PuzzleInventoryPanel, input);

		await page.getByRole('button', { name: 'All pieces' }).click();
		await page.getByRole('button', { name: 'Corner pieces' }).click();
		await page.getByRole('button', { name: 'Edge pieces' }).click();
		await page.getByRole('button', { name: 'Center pieces' }).click();

		expect(input.onFilterChange.mock.calls.map(([filter]) => filter)).toEqual([
			'all',
			'corners',
			'edges',
			'center'
		]);
		await expect
			.element(page.getByRole('button', { name: 'All pieces' }))
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('forwards Shuffle and disables it with fewer than two unplaced pieces', async () => {
		const input = baseProps();
		const view = render(PuzzleInventoryPanel, input);
		const shuffle = page.getByRole('button', { name: 'Shuffle pieces' });

		await shuffle.click();
		expect(input.onShuffle).toHaveBeenCalledOnce();

		await view.rerender({
			...input,
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }]
		});
		await expect.element(shuffle).toBeDisabled();
	});

	it('shows a clear empty-filter message when unplaced pieces exist but none match', async () => {
		render(PuzzleInventoryPanel, {
			...baseProps(),
			activeFilter: 'center'
		});
		await expect.element(page.getByText('NO PIECES MATCH')).toBeVisible();
		expect(page.getByText('ALL PIECES PLACED').query()).toBeNull();
	});

	it('keeps the tools inside the collapsible drawer body on one non-wrapping row', async () => {
		render(PuzzleInventoryPanel, baseProps());
		const tools = document.querySelector<HTMLElement>('#puzzle-inventory-body .inventory-tools');
		expect(tools).not.toBeNull();
		const style = getComputedStyle(tools!);
		expect(style.flexWrap).toBe('nowrap');
		expect(style.overflowX).toBe('auto');

		await page.getByRole('button', { name: 'Collapse inventory' }).click();
		const body = document.querySelector<HTMLElement>('#puzzle-inventory-body')!;
		await expect.poll(() => getComputedStyle(body).display).toBe('none');
	});

	describe('roving focus', () => {
		it('keeps exactly one unplaced piece root tabbable', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			expect(pieces).toHaveLength(2);
			expect(pieces.filter((piece) => piece.tabIndex === 0)).toHaveLength(1);
		});

		it('keeps exactly one rotate button tabbable (the active piece) when rotation is enabled', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const rotateButtons = Array.from(
				document.querySelectorAll<HTMLButtonElement>('[data-testid="rotate-piece-button"]')
			);
			expect(rotateButtons).toHaveLength(2);
			const tabbableRoots = pieces.filter((piece) => piece.tabIndex === 0);
			expect(tabbableRoots).toHaveLength(1);
			const activePieceId = tabbableRoots[0]?.dataset.pieceId;
			const tabbableRotate = rotateButtons.filter((button) => button.tabIndex === 0);
			expect(tabbableRotate).toHaveLength(1);
			expect(tabbableRotate[0]?.getAttribute('aria-label')).toBe(`Rotate piece ${activePieceId}`);
			expect(rotateButtons.filter((button) => button.tabIndex === -1)).toHaveLength(1);
		});

		it('moves the active piece exactly one slot on ArrowRight', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const first = pieces[0]!;
			const second = pieces[1]!;
			first.focus();
			first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
			expect(document.activeElement).toBe(second);
			await expect.poll(() => second.tabIndex).toBe(0);
			await expect.poll(() => first.tabIndex).toBe(-1);
		});

		it('keeps the first piece active when ArrowLeft is pressed on it', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const first = pieces[0]!;
			first.focus();
			first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
			expect(document.activeElement).toBe(first);
			expect(first.tabIndex).toBe(0);
		});

		it('makes a directly focused non-tabbable piece the active piece', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const second = pieces[1]!;
			expect(second.tabIndex).toBe(-1);
			second.focus();
			expect(document.activeElement).toBe(second);
			await expect.poll(() => second.tabIndex).toBe(0);
			await expect.poll(() => pieces[0]!.tabIndex).toBe(-1);
		});

		it('restores exactly one tabbable root when a filter removes the active piece', async () => {
			const view = render(PuzzleInventoryPanel, {
				...baseProps(),
				puzzle: filterPuzzle,
				trayOrder: filterPuzzle.pieces.map((piece) => piece.id)
			});
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const center = pieces.find((piece) => piece.dataset.pieceId === '4')!;
			center.focus();
			await expect.poll(() => center.tabIndex).toBe(0);

			await view.rerender({
				...baseProps(),
				puzzle: filterPuzzle,
				trayOrder: filterPuzzle.pieces.map((piece) => piece.id),
				activeFilter: 'corners'
			});
			const corners = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			expect(corners).toHaveLength(4);
			const tabbable = corners.filter((piece) => piece.tabIndex === 0);
			expect(tabbable).toHaveLength(1);
			expect(tabbable[0]?.dataset.pieceId).toBe('0');
		});

		it('restores exactly one tabbable root when placement removes the active piece', async () => {
			const view = render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			expect(pieces.filter((piece) => piece.tabIndex === 0)).toHaveLength(1);

			await view.rerender({
				...baseProps(),
				placedPieces: [{ pieceId: 1, x: 1, y: 0 }]
			});
			const remaining = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			expect(remaining).toHaveLength(1);
			const tabbable = remaining.filter((piece) => piece.tabIndex === 0);
			expect(tabbable).toHaveLength(1);
			expect(tabbable[0]?.dataset.pieceId).toBe('0');
		});

		it('does not traverse when ArrowRight fires on a rotate button', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const first = pieces[0]!;
			const second = pieces[1]!;
			first.focus();
			await expect.poll(() => first.tabIndex).toBe(0);

			// The active piece's rotate button shares the roving tab stop. Arrow
			// traversal is owned by the piece roots; an arrow on the rotate button
			// must NOT move the active piece so the rotate control stays an
			// independent focusable leaf.
			const rotateButton = document.querySelector<HTMLButtonElement>(
				'[data-testid="rotate-piece-button"]'
			)!;
			rotateButton.focus();
			rotateButton.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
			);

			expect(document.activeElement).toBe(rotateButton);
			await expect.poll(() => first.tabIndex).toBe(0);
			await expect.poll(() => second.tabIndex).toBe(-1);
		});

		it('ignores focusin that does not originate from a piece slot', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const activeBefore = pieces.find((piece) => piece.tabIndex === 0)!;

			// A focusin bubbling up from the grid container itself (not a piece
			// slot) must not reassign the roving tab stop.
			const grid = document.querySelector<HTMLElement>('.pieces-grid')!;
			grid.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

			const activeAfter = pieces.find((piece) => piece.tabIndex === 0)!;
			expect(activeAfter).toBe(activeBefore);
		});

		it('ignores arrow keydown that does not originate from a piece slot', async () => {
			render(PuzzleInventoryPanel, baseProps());
			const pieces = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="puzzle-piece"]')
			);
			const activeBefore = pieces.find((piece) => piece.tabIndex === 0)!;

			// An arrow key dispatched on the grid container (not a piece slot)
			// has no resolvable piece id and must early-return without moving
			// the roving tab stop.
			const grid = document.querySelector<HTMLElement>('.pieces-grid')!;
			grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

			const activeAfter = pieces.find((piece) => piece.tabIndex === 0)!;
			expect(activeAfter).toBe(activeBefore);
		});
	});
});
