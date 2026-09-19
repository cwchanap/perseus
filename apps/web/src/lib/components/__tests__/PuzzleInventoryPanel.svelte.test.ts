import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleInventoryPanel from '../PuzzleInventoryPanel.svelte';
import type { Puzzle } from '$lib/types/puzzle';

const image = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
let drawerDisplayAtScroll = '';

const scrollIntoView = vi.fn(function (this: HTMLElement) {
	const body = this.closest<HTMLElement>('.inventory-body');
	drawerDisplayAtScroll = body ? getComputedStyle(body).display : '';
});

beforeEach(() => {
	// Standalone renders inherit no layout vars; pin the same values the
	// route's .game-layout provides so slot-size math resolves in tests.
	document.documentElement.style.setProperty('--piece-slot-size', '4rem');
	document.documentElement.style.setProperty('--inventory-gap', '0.375rem');
	drawerDisplayAtScroll = '';
	scrollIntoView.mockClear();
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

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
		onShuffle: vi.fn(),
		onAnnouncement: vi.fn()
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

		await expect.element(page.getByText('1 piece left')).toBeVisible();
		expect(document.querySelector('[data-testid="piece-slot-0"]')).toBeNull();
		const slot = document.querySelector('[data-testid="piece-slot-1"]');
		expect(slot).not.toBeNull();
		expect(slot?.className).toContain('hinted');
		expect(slot?.className).not.toContain('rejected');
		expect(slot?.getAttribute('data-hinted')).toBe('true');
		await expect.element(page.getByText('HINT')).toBeVisible();
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

	it('forwards select and cancel selection', async () => {
		const input = baseProps();
		const view = render(PuzzleInventoryPanel, input);

		const piece = await page.getByLabelText('Puzzle piece 1').element();
		piece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(input.onSelect).toHaveBeenCalledWith(1);

		await view.rerender({ ...input, selectedPieceId: 1 });
		const selectedPiece = await page.getByLabelText('Puzzle piece 1').element();
		selectedPiece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(input.onCancelSelection).toHaveBeenCalledOnce();
	});

	it('shows disabled header Rotate while rotation mode is enabled without a selection', async () => {
		render(PuzzleInventoryPanel, baseProps());
		await expect
			.element(page.getByRole('button', { name: 'Rotate selected piece' }))
			.toBeDisabled();
	});

	it('rotates the selected piece from the header', async () => {
		const input = baseProps();
		render(PuzzleInventoryPanel, { ...input, selectedPieceId: 1 });
		await page.getByRole('button', { name: 'Rotate selected piece' }).click();
		expect(input.onRotate).toHaveBeenCalledWith(1);
	});

	it('guards against a synthetic click on the disabled Rotate button', async () => {
		// The ROTATE button is disabled when no piece is selected, so a real
		// click never reaches rotateSelectedPiece. A programmatically
		// dispatched click event bypasses the disabled gate, so the handler's
		// null-selection guard must short-circuit without invoking onRotate.
		const input = baseProps();
		render(PuzzleInventoryPanel, { ...input, selectedPieceId: null });
		const rotate = (await page
			.getByRole('button', { name: 'Rotate selected piece' })
			.element()) as HTMLButtonElement;
		expect(rotate.disabled).toBe(true);
		rotate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();
		expect(input.onRotate).not.toHaveBeenCalled();
	});

	it('does not show header Rotate when rotation mode is disabled', async () => {
		render(PuzzleInventoryPanel, { ...baseProps(), rotationEnabled: false });
		expect(page.getByRole('button', { name: 'Rotate selected piece' }).query()).toBeNull();
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

	it('starts half-open and cycles the tri-state sheet without changing tray contents', async () => {
		const input = baseProps();
		render(PuzzleInventoryPanel, input);
		const toggle = (await page
			.getByTestId('inventory-drawer-toggle')
			.element()) as HTMLButtonElement;

		expect(
			page.getByTestId('puzzle-inventory-panel').query()?.getAttribute('data-sheet-state')
		).toBe('half');
		expect(toggle.getAttribute('aria-expanded')).toBeNull();
		expect(toggle.getAttribute('aria-label')).toBe('Expand piece tray to full');
		expect(toggle.getAttribute('aria-controls')).toBe('puzzle-inventory-body');
		expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);

		toggle.click();
		await expect
			.element(page.getByTestId('puzzle-inventory-panel'))
			.toHaveAttribute('data-sheet-state', 'full');
		await expect.element(toggle).toHaveAttribute('aria-label', 'Collapse piece tray to peek');
		expect(input.onAnnouncement).toHaveBeenCalledWith('Piece tray: full.');
		expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);

		toggle.click();
		await expect
			.element(page.getByTestId('puzzle-inventory-panel'))
			.toHaveAttribute('data-sheet-state', 'peek');
		await expect.element(toggle).toHaveAttribute('aria-label', 'Expand piece tray to half');
		expect(input.onAnnouncement).toHaveBeenCalledWith('Piece tray: peek.');

		toggle.click();
		await expect
			.element(page.getByTestId('puzzle-inventory-panel'))
			.toHaveAttribute('data-sheet-state', 'half');
		await expect.element(toggle).toHaveAttribute('aria-label', 'Expand piece tray to full');
		expect(input.onAnnouncement).toHaveBeenCalledWith('Piece tray: half.');
		expect(document.querySelectorAll('[data-testid^="piece-slot-"]')).toHaveLength(2);
	});

	it('keeps Cancel and an enabled Rotate in the header while peeked', async () => {
		render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });
		const toggle = (await page
			.getByTestId('inventory-drawer-toggle')
			.element()) as HTMLButtonElement;
		toggle.click();
		toggle.click();
		await expect
			.element(page.getByTestId('puzzle-inventory-panel'))
			.toHaveAttribute('data-sheet-state', 'peek');

		await expect
			.element(page.getByRole('button', { name: 'Cancel selected piece' }))
			.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Rotate selected piece' })).toBeEnabled();
	});

	it('opens the drawer before scrolling the hinted piece into view', async () => {
		const input = baseProps();
		const view = render(PuzzleInventoryPanel, input);

		await page.getByRole('button', { name: 'Expand piece tray to full' }).click();
		await page.getByRole('button', { name: 'Collapse piece tray to peek' }).click();
		await view.rerender({ ...input, activeHintPieceId: 1 });

		await expect
			.element(page.getByTestId('inventory-drawer-toggle'))
			.toHaveAttribute('aria-label', 'Expand piece tray to full');
		await expect
			.element(page.getByTestId('puzzle-inventory-panel'))
			.toHaveAttribute('data-sheet-state', 'half');
		await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

		expect(drawerDisplayAtScroll).not.toBe('none');
		expect(input.onSelect).not.toHaveBeenCalled();
		expect(input.onRotate).not.toHaveBeenCalled();

		const focusedBefore = document.activeElement;
		await view.rerender({ ...input, activeHintPieceId: 0 });
		const hinted = await page.getByLabelText('Puzzle piece 0').element();

		await expect.poll(() => hinted.tabIndex).toBe(0);
		expect(document.activeElement).toBe(focusedBefore);
	});

	it('renders only unplaced pieces matching the controlled filter while keeping total LEFT', async () => {
		render(PuzzleInventoryPanel, {
			...baseProps(),
			puzzle: filterPuzzle,
			trayOrder: filterPuzzle.pieces.map((piece) => piece.id),
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			activeFilter: 'corners'
		});

		await expect.element(page.getByText('8 pieces left')).toBeVisible();
		expect(page.getByTestId('piece-slot-0').query()).toBeNull();
		await expect.element(page.getByTestId('piece-slot-2')).toBeVisible();
		await expect.element(page.getByTestId('piece-slot-6')).toBeVisible();
		await expect.element(page.getByTestId('piece-slot-8')).toBeVisible();
		expect(page.getByTestId('piece-slot-4').query()).toBeNull();
	});

	it('forwards all four filter values and exposes pressed state', async () => {
		const input = baseProps();
		render(PuzzleInventoryPanel, input);

		// Filter buttons expose their remaining count in the accessible name.
		await page.getByRole('button', { name: 'All pieces, 2 remaining' }).click();
		await page.getByRole('button', { name: 'Corner pieces, 2 remaining' }).click();
		await page.getByRole('button', { name: 'Edge pieces, 0 remaining' }).click();
		await page.getByRole('button', { name: 'Center pieces, 0 remaining' }).click();

		expect(input.onFilterChange.mock.calls.map(([filter]) => filter)).toEqual([
			'all',
			'corners',
			'edges',
			'center'
		]);
		await expect
			.element(page.getByRole('button', { name: 'All pieces, 2 remaining' }))
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
		// The 2x1 puzzle has no center pieces at all (totalCount is 0), so the
		// factual NO PIECES MATCH copy is kept and a recovery action is offered.
		await expect.element(page.getByText('NO PIECES MATCH')).toBeVisible();
		await expect.element(page.getByText('SHOW ALL REMAINING')).toBeVisible();
		expect(page.getByText('ALL PIECES PLACED').query()).toBeNull();
	});

	describe('selected slot expansion', () => {
		it('marks the selected slot as an expanded 2x2 grid area', async () => {
			render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });
			const slot = await page.getByTestId('piece-slot-1').element();
			const style = getComputedStyle(slot);
			// The span is carried on the start side; end resolves to 'auto'.
			expect(style.gridColumnStart).toBe('span 2');
			expect(style.gridRowStart).toBe('span 2');
		});

		it('renders the selected slot materially larger than an unselected slot', async () => {
			render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });
			const selected = await page.getByTestId('piece-slot-1').element();
			const unselected = await page.getByTestId('piece-slot-0').element();
			const selectedBox = selected.getBoundingClientRect();
			const unselectedBox = unselected.getBoundingClientRect();
			// 2x2 math: two slot tracks plus the existing grid gap, so the box is
			// roughly twice a single slot (1.8x floor tolerates content-box
			// padding/border rounding in the standalone render).
			expect(selectedBox.width).toBeGreaterThan(unselectedBox.width * 1.8);
			expect(selectedBox.height).toBeCloseTo(selectedBox.width, 1);
		});

		it('keeps the same PuzzlePiece interaction path inside the expanded slot', async () => {
			const input = baseProps();
			render(PuzzleInventoryPanel, { ...input, selectedPieceId: 1 });
			const piece = document.querySelector<HTMLElement>(
				'[data-testid="piece-slot-1"] [data-testid="puzzle-piece"]'
			);
			expect(piece?.getAttribute('data-piece-id')).toBe('1');
			piece?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			expect(input.onCancelSelection).toHaveBeenCalledOnce();
		});

		it('rotates the selected enlarged piece and reflects the new angle', async () => {
			const input = baseProps();
			const view = render(PuzzleInventoryPanel, { ...input, selectedPieceId: 1 });
			await page.getByRole('button', { name: 'Rotate selected piece' }).click();
			expect(input.onRotate).toHaveBeenCalledWith(1);
			await view.rerender({ ...input, selectedPieceId: 1, pieceRotations: { 1: 90 as const } });
			const slot = await page.getByTestId('piece-slot-1').element();
			const visual = slot.querySelector('[data-testid="puzzle-piece-visual"]');
			expect(visual?.getAttribute('style') ?? '').toContain('rotate(90deg)');
			expect(getComputedStyle(slot).gridColumnStart).toBe('span 2');
		});

		it('removes the expanded state when the selection is cleared', async () => {
			const input = baseProps();
			const view = render(PuzzleInventoryPanel, { ...input, selectedPieceId: 1 });
			const slot = await page.getByTestId('piece-slot-1').element();
			expect(getComputedStyle(slot).gridColumnStart).toBe('span 2');
			await view.rerender({ ...input, selectedPieceId: null });
			expect(getComputedStyle(slot).gridColumnStart).not.toBe('span 2');
			const unselected = await page.getByTestId('piece-slot-0').element();
			expect(slot.getBoundingClientRect().width).toBeCloseTo(
				unselected.getBoundingClientRect().width,
				0
			);
		});

		it('still hides the tray body and grid when peeked with an expanded selection', async () => {
			render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });
			const toggle = (await page
				.getByTestId('inventory-drawer-toggle')
				.element()) as HTMLButtonElement;
			toggle.click();
			toggle.click();
			await expect
				.element(page.getByTestId('puzzle-inventory-panel'))
				.toHaveAttribute('data-sheet-state', 'peek');
			const body = document.querySelector<HTMLElement>('#puzzle-inventory-body')!;
			await expect.poll(() => getComputedStyle(body).display).toBe('none');
		});
	});

	describe('filter count badges', () => {
		function filterProps() {
			return {
				puzzle: filterPuzzle,
				trayOrder: filterPuzzle.pieces.map((piece) => piece.id)
			};
		}

		function badgeText(filter: string): string {
			return (
				document
					.querySelector<HTMLElement>(`[data-testid="filter-count-${filter}"]`)
					?.textContent?.trim() ?? ''
			);
		}

		it('shows a remaining-count badge on every filter button', async () => {
			render(PuzzleInventoryPanel, { ...baseProps(), ...filterProps() });
			expect(badgeText('all')).toBe('9');
			expect(badgeText('corners')).toBe('4');
			expect(badgeText('edges')).toBe('4');
			expect(badgeText('center')).toBe('1');
			await expect.element(page.getByTestId('filter-count-all')).toBeVisible();
			await expect.element(page.getByTestId('filter-count-corners')).toBeVisible();
			await expect.element(page.getByTestId('filter-count-edges')).toBeVisible();
			await expect.element(page.getByTestId('filter-count-center')).toBeVisible();
		});

		it('renders a visible zero badge when a kind has nothing remaining', async () => {
			render(PuzzleInventoryPanel, baseProps());
			expect(badgeText('edges')).toBe('0');
			expect(badgeText('center')).toBe('0');
			await expect.element(page.getByTestId('filter-count-edges')).toBeVisible();
			await expect.element(page.getByTestId('filter-count-center')).toBeVisible();
		});

		it('retains each label prefix and appends the remaining count', async () => {
			render(PuzzleInventoryPanel, { ...baseProps(), ...filterProps() });
			expect(page.getByRole('button', { name: 'All pieces, 9 remaining' }).query()).not.toBeNull();
			expect(
				page.getByRole('button', { name: 'Corner pieces, 4 remaining' }).query()
			).not.toBeNull();
			expect(page.getByRole('button', { name: 'Edge pieces, 4 remaining' }).query()).not.toBeNull();
			expect(
				page.getByRole('button', { name: 'Center pieces, 1 remaining' }).query()
			).not.toBeNull();
		});

		it('updates badges after placedPieces changes', async () => {
			const input = { ...baseProps(), ...filterProps() };
			const view = render(PuzzleInventoryPanel, input);
			expect(badgeText('center')).toBe('1');
			expect(badgeText('all')).toBe('9');
			await view.rerender({ ...input, placedPieces: [{ pieceId: 4, x: 1, y: 1 }] });
			expect(badgeText('center')).toBe('0');
			expect(badgeText('all')).toBe('8');
			expect(badgeText('corners')).toBe('4');
		});

		it('surfaces non-All counts in the filter popup at 1024-1279 when opened', async () => {
			const originalWidth = window.innerWidth;
			const originalHeight = window.innerHeight;
			await page.viewport(1200, 800);
			try {
				render(PuzzleInventoryPanel, { ...baseProps(), ...filterProps() });
				const corners = page.getByTestId('filter-count-corners');
				await expect.element(corners).not.toBeVisible();
				await page.getByTestId('inventory-filter-toggle').click();
				await expect.element(corners).toBeVisible();
				await expect.element(page.getByTestId('filter-count-edges')).toBeVisible();
				await expect.element(page.getByTestId('filter-count-center')).toBeVisible();
			} finally {
				await page.viewport(originalWidth, originalHeight);
			}
		});
	});

	describe('truthful empty-filter copy', () => {
		function allCornersPlacedProps() {
			return {
				...baseProps(),
				puzzle: filterPuzzle,
				trayOrder: filterPuzzle.pieces.map((piece) => piece.id),
				placedPieces: [0, 2, 6, 8].map((pieceId) => ({ pieceId, x: 0, y: 0 })),
				activeFilter: 'corners' as const
			};
		}

		it('keeps factual NO PIECES MATCH for the 2x1 edge kind', async () => {
			render(PuzzleInventoryPanel, { ...baseProps(), activeFilter: 'edges' });
			await expect.element(page.getByText('NO PIECES MATCH')).toBeVisible();
		});

		it('shows ALL CORNERS PLACED when the kind exists but every one is placed', async () => {
			render(PuzzleInventoryPanel, allCornersPlacedProps());
			await expect.element(page.getByText('ALL CORNERS PLACED')).toBeVisible();
			expect(page.getByText('NO PIECES MATCH').query()).toBeNull();
		});

		it('shows SHOW ALL REMAINING in both empty branches and recovers on activation', async () => {
			const emptyKind = baseProps();
			const view = render(PuzzleInventoryPanel, { ...emptyKind, activeFilter: 'center' });
			await expect.element(page.getByText('SHOW ALL REMAINING')).toBeVisible();
			expect(emptyKind.onFilterChange).not.toHaveBeenCalled();
			await page.getByTestId('inventory-filter-recovery').click();
			expect(emptyKind.onFilterChange).toHaveBeenCalledTimes(1);
			expect(emptyKind.onFilterChange).toHaveBeenCalledWith('all');

			const exhaustedKind = allCornersPlacedProps();
			await view.rerender(exhaustedKind);
			await expect.element(page.getByText('SHOW ALL REMAINING')).toBeVisible();
			expect(exhaustedKind.onFilterChange).not.toHaveBeenCalled();
			await page.getByTestId('inventory-filter-recovery').click();
			expect(exhaustedKind.onFilterChange).toHaveBeenCalledTimes(1);
			expect(exhaustedKind.onFilterChange).toHaveBeenCalledWith('all');
		});

		it('does not auto-switch the filter when the empty state renders', async () => {
			const input = baseProps();
			render(PuzzleInventoryPanel, { ...input, activeFilter: 'edges' });
			await expect.element(page.getByText('NO PIECES MATCH')).toBeVisible();
			expect(input.onFilterChange).not.toHaveBeenCalled();
		});
	});

	it('keeps the tools in the header on one non-wrapping row', async () => {
		render(PuzzleInventoryPanel, baseProps());
		const tools = document.querySelector<HTMLElement>('.panel-header .inventory-tools');
		expect(tools).not.toBeNull();
		const style = getComputedStyle(tools!);
		expect(style.flexWrap).toBe('nowrap');
		expect(style.overflowX).toBe('auto');

		await page.getByRole('button', { name: 'Expand piece tray to full' }).click();
		await page.getByRole('button', { name: 'Collapse piece tray to peek' }).click();
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
