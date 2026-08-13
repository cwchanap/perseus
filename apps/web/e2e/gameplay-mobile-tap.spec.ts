// HPA-219 Task 3: mobile inventory drawer layout/density/scroll proof.
//
// These tests pin the 390 × 844 chromium-mobile geometry for the in-flow
// inventory drawer added in this slice. Task 4 extends this file with the
// full mobile completion flow; Task 5 is the verification fence.
//
// The 4-piece fixture proves density + fit (the whole panel must sit inside
// the viewport and at least four tray slots must be fully visible). The
// 100-piece fixture proves scroll: a corrected-density 4-piece tray no longer
// needs scrolling, so scroll must be exercised against the large fixture via
// a real browser-level touch swipe.
import { test, expect } from './support/test';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };
const PROJECT = () => test.info().project.name;

function isChromiumMobile(): boolean {
	return PROJECT() === 'chromium-mobile';
}

test('mobile inventory fits the viewport and shows four tray slots @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(!isChromiumMobile(), 'mobile layout proof uses chromium-mobile');
	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });

	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	const panel = page.getByTestId('puzzle-inventory-panel');
	const grid = page.locator('.pieces-grid');
	const viewport = page.viewportSize();
	const panelBox = await panel.boundingBox();
	const gridBox = await grid.boundingBox();

	expect(viewport).toEqual({ width: 390, height: 844 });
	expect(panelBox).not.toBeNull();
	expect(gridBox).not.toBeNull();
	expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(viewport!.height);

	const slots = page.locator('[data-testid^="piece-slot-"]');
	const slotCount = await slots.count();
	let fullyVisible = 0;
	for (let index = 0; index < slotCount; index += 1) {
		const box = await slots.nth(index).boundingBox();
		if (
			box &&
			box.x >= gridBox!.x - 1 &&
			box.y >= gridBox!.y - 1 &&
			box.x + box.width <= gridBox!.x + gridBox!.width + 1 &&
			box.y + box.height <= gridBox!.y + gridBox!.height + 1
		) {
			fullyVisible += 1;
		}
	}

	expect(fullyVisible).toBeGreaterThanOrEqual(4);
});

test('large mobile inventory scrolls from a swipe starting on a piece @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(!isChromiumMobile(), 'browser-level touch swipe uses Chromium CDP');
	await gameplayPage.gotoFixture({
		fixtureId: 'e2e-square-100',
		seedPreferences: IMMEDIATE_START
	});

	const grid = page.locator('.pieces-grid');
	const firstPieceId = gameplayPage.fixture!.initialTrayOrder[0]!;
	const piece = gameplayPage.pieceSource(firstPieceId).getByTestId('puzzle-piece');
	const pieceBox = await piece.boundingBox();
	const gridBox = await grid.boundingBox();
	expect(pieceBox).not.toBeNull();
	expect(gridBox).not.toBeNull();

	const before = await grid.evaluate((element) => element.scrollTop);
	const x = pieceBox!.x + pieceBox!.width / 2;
	const startY = pieceBox!.y + pieceBox!.height / 2;
	const endY = Math.max(gridBox!.y + 16, startY - 140);
	// Synthesize a realistic finger swipe: many small touchMove frames spaced
	// ~one animation frame apart. Chromium's touch→scroll gesture detector needs
	// a fluent, temporally-spaced sequence to reliably commit a scroll under
	// worker-parallel CPU contention; two large jumps (the old shape) can be
	// dropped or coalesced into a tap when the lane is saturated.
	const cdp = await page.context().newCDPSession(page);
	const steps = 16;
	const frameMs = 16;
	try {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x, y: startY, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
		});
		await page.waitForTimeout(frameMs);
		for (let index = 1; index <= steps; index += 1) {
			const y = startY + ((endY - startY) * index) / steps;
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
			});
			await page.waitForTimeout(frameMs);
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	} finally {
		await cdp.detach();
	}

	await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
});

test('mobile tap-to-place and drawer complete a puzzle @smoke', async ({ gameplayPage, page }) => {
	test.skip(!isChromiumMobile(), 'HPA-219 feature flow uses chromium-mobile');
	await gameplayPage.gotoFixture({
		seedPreferences: IMMEDIATE_START,
		completion: { kind: 'success' }
	});

	const toggle = page.getByTestId('inventory-drawer-toggle');
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByTestId('puzzle-board')).toBeVisible();

	// Piece 0 belongs at (0, 0); reject it at (1, 1).
	await gameplayPage.tapPiece(0);
	const piece0 = gameplayPage.pieceSource(0).getByTestId('puzzle-piece');
	await expect(piece0).toHaveAttribute('data-selected', 'true');
	await gameplayPage.dropZone(1, 1).tap();

	// Durable rejection contract: the slot stays and selection stays.
	await expect(gameplayPage.pieceSource(0)).toBeVisible();
	await expect(piece0).toHaveAttribute('data-selected', 'true');

	// Retrying the selected piece at its real cell succeeds and clears selection.
	await gameplayPage.placeWithTap(0, 0, 0);
	await gameplayPage.expectPiecePlaced(0, 0, 0);
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);

	// Prove Cancel remains available in the collapsed header.
	await gameplayPage.tapPiece(1);
	await expect(gameplayPage.pieceSource(1).getByTestId('puzzle-piece')).toHaveAttribute(
		'data-selected',
		'true'
	);
	await page.getByRole('button', { name: 'Collapse inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	await page.getByRole('button', { name: 'Cancel selected piece' }).click();
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Open inventory' }).click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	const fixture = gameplayPage.fixture!;
	for (const piece of fixture.pieces.filter((candidate) => candidate.id !== 0)) {
		await gameplayPage.placeWithTap(piece.id, piece.correctX, piece.correctY);
		await gameplayPage.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
	}

	await expect(page.getByTestId('celebration-modal')).toBeVisible();
	const overflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});
