// Rendered-UI interaction tests for the gameplay page.
//
// Covers correct/rejected mouse placement, Enter/Space keyboard selection and
// placement, tap placement, source scoping through piece-slot-${id},
// and the current completion-dialog role/action/focus behavior.
//
// Uses e2e-square-4 (2x2, 4 pieces) for speed.
//
// Tags:
//   @extended        — mouse drag tests (dragTo unreliable on WebKit; see
//                      webkit-drag-spike.spec.ts — 0/20 pass on webkit-mobile).
//   @webkit-critical — keyboard, tap placement, and dialog tests (reliable on WebKit).
import { test, expect } from './support/test';
import { getFixture } from './gameplay-fixtures/catalog';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const PROJECT = () => test.info().project.name;

/**
 * Device preferences that auto-start fresh sessions. HPA-221 made Mission
 * Setup mandatory on fresh route entry, so tests that interact with the board
 * immediately seed `startImmediately` to skip the dialog.
 */
const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };

test.describe('Gameplay interactions', () => {
	test.describe('mouse @extended', () => {
		test('correct placement places the piece at its target cell', async ({ gameplayPage }) => {
			await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
			await gameplayPage.placeWithMouse(0, 0, 0);
			await gameplayPage.expectPiecePlaced(0, 0, 0);
		});

		test('rejected placement keeps the piece in the tray', async ({ gameplayPage, page }) => {
			await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
			// Piece 0 correct position is (0,0); (1,1) is wrong.
			await gameplayPage.placeWithMouse(0, 1, 1);
			await expect(page.getByTestId('piece-slot-0')).toBeVisible();
		});
	});

	test.describe('keyboard @webkit-critical', () => {
		test('Enter selects a piece and places it', async ({ gameplayPage }) => {
			await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
			await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
			await gameplayPage.expectPiecePlaced(0, 0, 0);
		});

		test('Space selects a piece and places it', async ({ gameplayPage }) => {
			await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
			await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0, 'Space');
			await gameplayPage.expectPiecePlaced(0, 0, 0);
		});
	});

	// The practical keyboard flow for HPA-223: roving Tab stops per logical
	// region (toolbar / board / inventory), exact arrows, selection and
	// rejection announcements, Escape cancel, accepted placement with
	// undo/redo, Hint, and completion from a partially solved fixture.
	// @smoke — automatic Chromium desktop/mobile lane.
	test('keyboard core flow uses logical regions and announcements @smoke', async ({
		gameplayPage,
		page
	}) => {
		const fixture = getFixture('e2e-square-4');
		await gameplayPage.gotoFixture({
			fixtureId: fixture.id,
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START
		});

		const toolbar = page.getByTestId('puzzle-toolbar');
		const board = page.getByTestId('puzzle-board');
		const inventory = page.getByTestId('puzzle-inventory-panel');
		const announcer = page.getByTestId('gameplay-announcer');

		// Each logical region exposes exactly one visible Tab stop: the
		// toolbar's active action, the board's roving cell, the inventory's
		// active piece root.
		await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
		await expect(board.locator('[data-testid="drop-zone"][tabindex="0"]:visible')).toHaveCount(1);
		await expect(
			inventory.locator('[data-testid="puzzle-piece"][tabindex="0"]:visible')
		).toHaveCount(1);

		// Tab lands on the toolbar's single active action, then the board's
		// single active cell — no traversal through every toolbar action/cell.
		await page.getByRole('link', { name: 'Return to arcade' }).focus();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Hint' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(gameplayPage.dropZone(0, 0)).toBeFocused();

		// Toolbar arrows advance between visible actions: Hint -> Reference.
		const hint = page.getByRole('button', { name: 'Hint' });
		const reference = page.getByRole('button', { name: 'Toggle reference' });
		await hint.focus();
		await page.keyboard.press('ArrowRight');
		await expect(reference).toBeFocused();

		// Board arrows move spatially between cells: (0,0) -> (1,0).
		const cell00 = gameplayPage.dropZone(0, 0);
		const cell10 = gameplayPage.dropZone(1, 0);
		await cell00.focus();
		await page.keyboard.press('ArrowRight');
		await expect(cell10).toBeFocused();

		// Inventory arrows traverse the visible tray: the first visible root
		// receives focus, ArrowRight moves to the second.
		const secondPieceId = fixture.initialTrayOrder[1]!;
		await inventory.locator('[data-testid="puzzle-piece"][tabindex="0"]').focus();
		await page.keyboard.press('ArrowRight');
		await expect(gameplayPage.pieceSource(secondPieceId).getByTestId('puzzle-piece')).toBeFocused();

		// Selection announces and marks the piece.
		const piece = gameplayPage.pieceSource(0).getByTestId('puzzle-piece');
		await piece.focus();
		await piece.press('Enter');
		await expect(piece).toHaveAttribute('data-selected', 'true');
		await expect(announcer).toContainText('Puzzle piece 0 selected.');

		// Activating a wrong cell rejects via the durable announcer, and the
		// selection is retained so the player can try another cell.
		await gameplayPage.dropZone(1, 1).focus();
		await page.keyboard.press('Enter');
		await expect(announcer).toContainText('Puzzle piece 0 does not fit there.');

		// Escape clears the selection and announces the cancel.
		await page.keyboard.press('Escape');
		await expect(piece).toHaveAttribute('data-selected', 'false');
		await expect(announcer).toContainText('Selection canceled.');

		// The accepted placement announces, then undo returns the piece to the
		// tray and redo places it again.
		await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
		await gameplayPage.expectPiecePlaced(0, 0, 0);
		await expect(announcer).toContainText('Puzzle piece 0 placed.');

		await page.keyboard.press('Control+z');
		await expect(gameplayPage.pieceSource(0)).toBeVisible();
		await page.keyboard.press('Control+y');
		await gameplayPage.expectPiecePlaced(0, 0, 0);

		// Hint announces the one-based target of the first unplaced piece
		// (nothing is selected, so the tray order decides).
		const hintedId = fixture.initialTrayOrder.find((id) => id !== 0)!;
		const hintedPiece = fixture.pieces.find((p) => p.id === hintedId)!;
		await hint.focus();
		await hint.press('Enter');
		await expect(announcer).toContainText(
			`Hint: puzzle piece ${hintedPiece.id} goes to row ${hintedPiece.correctY + 1}, ` +
				`column ${hintedPiece.correctX + 1}.`
		);

		// Complete the puzzle from the partial state: the extended helper
		// skips the already-placed piece.
		await gameplayPage.solveFixture({ skipPlaced: true });
		await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		await expect(announcer).toContainText('Puzzle complete.');
	});

	test.describe('source scoping @extended', () => {
		test('piece-slot-3 targets piece 3 specifically', async ({ gameplayPage }) => {
			await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
			// Piece 3 correct position is (1,1).
			await gameplayPage.placeWithMouse(3, 1, 1);
			await gameplayPage.expectPiecePlaced(3, 1, 1);
		});
	});

	test('tap placement places a piece @smoke @webkit-critical', async ({ gameplayPage }) => {
		const project = PROJECT();
		test.skip(
			project !== 'chromium-mobile' && project !== 'webkit-mobile',
			'tap placement is retained on mobile Chromium and WebKit'
		);

		await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
		await gameplayPage.placeWithTap(0, 0, 0);
		await gameplayPage.expectPiecePlaced(0, 0, 0);
	});

	test.describe('completion dialog @webkit-critical', () => {
		test('role, focus, action activation, and escape dismissal', async ({ gameplayPage, page }) => {
			await gameplayPage.gotoFixture({
				completion: { kind: 'success' },
				seedPreferences: IMMEDIATE_START
			});
			// Use keyboard placement for cross-browser reliability.
			await gameplayPage.solveFixture();

			// Dialog opens with the puzzle name as its accessible name.
			const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
			await expect(dialog).toHaveAttribute('role', 'dialog');
			await expect(dialog).toHaveAttribute('aria-modal', 'true');

			// manageModalFocus moves focus to the first focusable element
			// (PLAY AGAIN) after a 100 ms timeout.
			const playAgain = dialog.getByRole('button', { name: 'PLAY AGAIN' });
			await gameplayPage.expectDialogInitialFocus(dialog, playAgain);

			// Activate an action — Play Again restarts and closes the dialog.
			await gameplayPage.activateDialogAction(dialog, 'PLAY AGAIN');
			await expect(page.getByTestId('celebration-modal')).not.toBeVisible();
		});

		test('escape dismisses the dialog', async ({ gameplayPage, page }) => {
			await gameplayPage.gotoFixture({
				completion: { kind: 'success' },
				seedPreferences: IMMEDIATE_START
			});
			await gameplayPage.solveFixture();
			const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
			await gameplayPage.dismissDialog(dialog, 'escape');
			await expect(page.getByTestId('celebration-modal')).not.toBeVisible();
		});
	});
});
