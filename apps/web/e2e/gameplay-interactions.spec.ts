// Rendered-UI interaction tests for the gameplay page.
//
// Covers correct/rejected mouse placement, Enter/Space keyboard selection and
// placement, supported touch drag, source scoping through piece-slot-${id},
// and the current completion-dialog role/action/focus behavior.
//
// Uses e2e-square-4 (2x2, 4 pieces) for speed.
//
// Tags:
//   @extended        — mouse drag tests (dragTo unreliable on WebKit; see
//                      webkit-drag-spike.spec.ts — 0/20 pass on webkit-mobile).
//   @webkit-critical — keyboard, touch, and dialog tests (reliable on WebKit).
import { test, expect } from './support/test';
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

	test.describe('source scoping @extended', () => {
		test('piece-slot-3 targets piece 3 specifically', async ({ gameplayPage }) => {
			await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
			// Piece 3 correct position is (1,1).
			await gameplayPage.placeWithMouse(3, 1, 1);
			await gameplayPage.expectPiecePlaced(3, 1, 1);
		});
	});

	test('touch drag places a piece @smoke (chromium-mobile)', async ({ gameplayPage }) => {
		test.skip(PROJECT() !== 'chromium-mobile', 'touch drag tested on chromium-mobile');
		await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });
		await gameplayPage.dragWithTouch(0, 0, 0);
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
