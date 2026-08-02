// Accessibility scans for the user-facing surface (HPA-226 Task 10).
//
// Runs axe against three representative states — gallery, active gameplay, and
// the completion celebration — failing only on serious/critical findings. The
// full axe JSON is attached to each run for triage of minor/moderate findings.
//
// These are automated scans ONLY. axe verifies a structural subset of WCAG; it
// does NOT certify real screen-reader behavior, focus-trap correctness under
// tab cycling, or announced semantics in NVDA/VoiceOver. Manual AT
// certification is a separate, human-driven activity.
//
// Tags: @a11y — runs across chromium desktop/tablet and webkit mobile via the
// `test:e2e:a11y` script.
import { test, expect } from './support/test';
import {
	assertPageAccessible,
	expectContainedIn,
	expectLiveRegion,
	expectRoleFocused,
	scanAccessibility,
	assertNoSeriousViolations
} from './support/accessibility';

/** Representative gallery cards so the scan covers real interactive markup
 *  (card links, images, buttons) rather than just the empty state. */
const GALLERY_CARDS = [
	{ id: 'e2e-square-4', name: 'Square 4', pieceCount: 4, status: 'ready' },
	{ id: 'e2e-landscape-12', name: 'Landscape 12', pieceCount: 12, status: 'ready' },
	{ id: 'e2e-square-100', name: 'Square 100', pieceCount: 100, status: 'ready' }
];

function pagedResponse(puzzles: typeof GALLERY_CARDS) {
	return { puzzles, total: puzzles.length, offset: 0, limit: 20 };
}

test.describe('accessibility @a11y', () => {
	test('gallery: no serious/critical violations', async ({ page }) => {
		// Mock the puzzle list so the scan exercises real card markup
		// deterministically, independent of whatever the live API is serving.
		// The response is intentionally HELD until after the live-region check
		// so the loading region is guaranteed visible (an instantly-resolving
		// mock can detach it before any assertion runs).
		let releaseList!: () => void;
		const listReleased = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		await page.route(/\/api\/puzzles(?:\?.*)?$/, async (route) => {
			await listReleased;
			await route.fulfill({ json: pagedResponse(GALLERY_CARDS) });
		});

		await page.goto('/');

		// While the fetch is held, the loading region is a polite live region.
		const loading = page.getByTestId('loading-state');
		await expect(loading).toBeVisible();
		await expectLiveRegion(loading, 'polite');

		// Release the fetch and wait for the gallery to settle + render cards.
		releaseList();
		await expect(loading).toBeHidden();
		await expect(page.getByTestId('puzzle-card').first()).toBeVisible();

		await assertPageAccessible(page, { label: 'gallery' });
	});

	test('active gameplay: no serious/critical violations during play', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({ fixtureId: 'e2e-square-4' });

		// A board drop-zone lives inside the page's main landmark.
		await expectContainedIn(gameplayPage.dropZone(0, 0), page.getByRole('main'));

		// Place one piece so the scan covers mid-game DOM state (a placed
		// piece image, a reduced tray), not just the initial render.
		await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
		await gameplayPage.expectPiecePlaced(0, 0, 0);

		await assertPageAccessible(page, { label: 'active-gameplay' });
	});

	test('completion: celebration modal role/focus correct and no violations', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({
			fixtureId: 'e2e-square-4',
			completion: { kind: 'success' }
		});

		// Solve all four pieces via keyboard for cross-browser reliability.
		await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
		await gameplayPage.selectAndPlaceWithKeyboard(1, 1, 0);
		await gameplayPage.selectAndPlaceWithKeyboard(2, 0, 1);
		await gameplayPage.selectAndPlaceWithKeyboard(3, 1, 1);

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveAttribute('aria-modal', 'true');

		// manageModalFocus moves focus to the first action (PLAY AGAIN) after a
		// short timeout; expectRoleFocused auto-waits for that focus to land.
		const playAgain = dialog.getByRole('button', { name: 'PLAY AGAIN' });
		await expectRoleFocused(playAgain, 'button');

		// Scan with the modal open so its markup is covered too.
		const results = await scanAccessibility(page, { label: 'completion' });
		assertNoSeriousViolations(results);
	});
});
