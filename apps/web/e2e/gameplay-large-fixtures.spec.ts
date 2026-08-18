// Large-fixture layout coverage (HPA-226 Task 10).
//
// Exercises the non-square aspect ratios (4:3 landscape, 3:4 portrait), full
// 100- and 225-piece tray rendering, responsive usability across viewport
// classes, and ONE representative piece placement on a large board — without
// driving a full solve (solve coverage lives in gameplay-infrastructure.spec).
//
// Large-fixture cases are tagged @extended so they run across every Playwright
// project (chromium desktop/mobile/tablet, webkit mobile/tablet) via the
// `test:e2e:extended` script. The gameplay workspace polish smoke group below
// is not tagged @extended and runs in the default gate. The usable-layout test
// in particular relies on the extended matrix: it runs once per project,
// asserting the puzzle page fits each viewport without horizontal overflow.
import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import { getFixture } from './gameplay-fixtures/catalog';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

/**
 * Device preferences that auto-start fresh sessions. HPA-221 made Mission
 * Setup mandatory on fresh route entry, so tests that interact with the board
 * immediately seed `startImmediately` to skip the dialog.
 */
const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };

/**
 * Read the distinct rendered grid dimensions from the live board: cols = the
 * count of distinct data-x values across drop-zones, rows = distinct data-y.
 * This confirms the DOM grid matches the fixture's DERIVED grid (and is not a
 * transposed layout) — the same invariant the catalog builder enforces, here
 * checked against what actually rendered.
 */
async function renderedGridSize(page: Page): Promise<{ cols: number; rows: number }> {
	const dims = await page.evaluate(() => {
		const xs = new Set<string>();
		const ys = new Set<string>();
		document.querySelectorAll('[data-testid="drop-zone"]').forEach((el) => {
			xs.add(el.getAttribute('data-x') ?? '');
			ys.add(el.getAttribute('data-y') ?? '');
		});
		return { xs: xs.size, ys: ys.size };
	});
	return { cols: dims.xs, rows: dims.ys };
}

test.describe('large fixtures @extended', () => {
	test('3x4 landscape: board visible, 12 tray pieces, landscape orientation', async ({
		gameplayPage,
		page
	}) => {
		const fixture = getFixture('e2e-landscape-12');
		await gameplayPage.gotoFixture({ fixtureId: 'e2e-landscape-12' });

		await expect(page.getByTestId('puzzle-board')).toBeVisible();
		await expect(page.locator('[data-testid^="piece-slot-"]')).toHaveCount(fixture.pieceCount);

		const grid = await renderedGridSize(page);
		expect(grid.cols).toBe(fixture.cols); // 4
		expect(grid.rows).toBe(fixture.rows); // 3
		// Landscape: more columns than rows are visible.
		expect(grid.cols).toBeGreaterThan(grid.rows);
	});

	test('4x3 portrait: board visible, 12 tray pieces, portrait orientation', async ({
		gameplayPage,
		page
	}) => {
		const fixture = getFixture('e2e-portrait-12');
		await gameplayPage.gotoFixture({ fixtureId: 'e2e-portrait-12' });

		await expect(page.getByTestId('puzzle-board')).toBeVisible();
		await expect(page.locator('[data-testid^="piece-slot-"]')).toHaveCount(fixture.pieceCount);

		const grid = await renderedGridSize(page);
		expect(grid.cols).toBe(fixture.cols); // 3
		expect(grid.rows).toBe(fixture.rows); // 4
		// Portrait: more rows than columns are visible.
		expect(grid.rows).toBeGreaterThan(grid.cols);
	});

	test('usable layout by viewport: board + tray render without horizontal overflow', async ({
		gameplayPage,
		page
	}) => {
		// Runs once per Playwright project (desktop / tablet / mobile across
		// chromium and webkit) via the @extended matrix, so this single test
		// body exercises the full responsive range.
		await gameplayPage.gotoFixture({ fixtureId: 'e2e-landscape-12' });

		await expect(page.getByTestId('puzzle-board')).toBeVisible();
		await expect(page.locator('[data-testid^="piece-slot-"]').first()).toBeVisible();

		// Usable = the page fits its viewport: no horizontal document overflow.
		// (The board scales to its container and the tray wraps, so a positive
		// overflow here would be a real layout regression.)
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth
		);
		expect(
			overflow,
			`horizontal overflow at viewport ${test.info().project.name}`
		).toBeLessThanOrEqual(0);
	});

	test('100-piece fixture: exactly 100 tray slots render', async ({ gameplayPage, page }) => {
		await gameplayPage.gotoFixture({ fixtureId: 'e2e-square-100' });
		// gotoFixture's ready check already waits for the full tray, but assert
		// the exact count explicitly so this test's intent is self-documenting.
		await expect(page.locator('[data-testid^="piece-slot-"]')).toHaveCount(100);
	});

	test('225-piece fixture: exactly 225 tray slots render', async ({ gameplayPage, page }) => {
		await gameplayPage.gotoFixture({ fixtureId: 'e2e-square-225' });
		await expect(page.locator('[data-testid^="piece-slot-"]')).toHaveCount(225);
	});

	test('representative interaction: one piece places on the 100-piece board', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture({
			fixtureId: 'e2e-square-100',
			seedPreferences: IMMEDIATE_START
		});
		// Piece 0's correct cell is (0,0) on every fixture. Place just one
		// piece — full solve coverage lives in gameplay-infrastructure.spec.
		await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
		await gameplayPage.expectPiecePlaced(0, 0, 0);
	});
});

test.describe('gameplay workspace polish smoke', () => {
	test('desktop tray drag and hint reveal @smoke', async ({ gameplayPage, page }, testInfo) => {
		test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop-only split layout');

		await gameplayPage.gotoFixture({
			fixtureId: 'e2e-square-100',
			seedPreferences: IMMEDIATE_START
		});

		const layout = page.locator('.game-layout');
		const separator = page.getByTestId('tray-resizer');
		const before = await layout.evaluate((element) =>
			getComputedStyle(element).getPropertyValue('--tray-width').trim()
		);

		// The 100-piece board is taller than the desktop viewport; center the
		// separator so the prescribed bounding-box midpoint is an actual target.
		await separator.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			window.scrollBy(0, rect.top + rect.height / 2 - window.innerHeight / 2);
		});

		const box = await separator.boundingBox();
		expect(box).not.toBeNull();
		await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
		await page.mouse.down();
		await page.mouse.move(box!.x - 80, box!.y + box!.height / 2);
		await page.mouse.up();

		const after = await layout.evaluate((element) =>
			getComputedStyle(element).getPropertyValue('--tray-width').trim()
		);
		expect(after).not.toBe(before);

		await page.getByLabel('Puzzle piece 99', { exact: true }).click();
		await page.locator('.pieces-grid').evaluate((element) => {
			element.scrollTop = 0;
		});

		await page.getByRole('button', { name: 'Hint' }).click();

		const slot = page.getByTestId('piece-slot-99');
		await expect(slot).toHaveAttribute('data-hinted', 'true');
		await expect(slot).toBeInViewport();
		await expect(page.getByTestId('hint-target')).toBeVisible();
	});
});
