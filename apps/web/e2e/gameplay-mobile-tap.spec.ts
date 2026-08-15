// HPA-219 Task 3: mobile inventory drawer layout/density/scroll proof.
//
// These tests pin the 390 × 844 chromium-mobile geometry for the in-flow
// inventory drawer added in this slice. Task 4 extends this file with the
// full mobile completion flow; Task 5 is the verification fence.
//
// The 4-piece fixture proves the open drawer fits the 390x844 fold (HPA-219
// invariant, restored) and shows at least four tray slots fully visible. The
// 100-piece fixture proves the same fold fit plus the two-row grid content
// budget (HPA-220 fence) and scroll: a corrected-density 4-piece tray no
// longer needs scrolling, so scroll must be exercised against the large
// fixture via a real browser-level touch swipe.
import { test, expect } from './support/test';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };
const PROJECT = () => test.info().project.name;

function isChromiumMobile(): boolean {
	return PROJECT() === 'chromium-mobile';
}

test('puzzle toolbar is direct on desktop and compact on phone @smoke', async ({
	gameplayPage,
	page
}) => {
	const project = PROJECT();
	test.skip(
		project !== 'chromium-desktop' && project !== 'chromium-mobile',
		'toolbar responsive proof uses Chromium desktop/mobile'
	);

	await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });

	const more = page.getByRole('button', { name: 'More puzzle actions' });
	const zoomIn = page.getByRole('button', { name: 'Zoom in' });
	const pause = page.getByRole('button', { name: 'Pause mission' });
	const setup = page.getByRole('button', { name: 'Open mission setup' });
	const toggleReference = page.getByRole('button', { name: 'Toggle reference' });
	const peekReference = page.getByRole('button', { name: 'Hold to peek reference' });

	if (project === 'chromium-desktop') {
		await expect(more).toBeHidden();
		await expect(zoomIn).toBeVisible();
		await expect(pause).toBeVisible();
		await expect(setup).toBeVisible();
		await expect(toggleReference).toBeVisible();
		await expect(peekReference).toBeVisible();
		return;
	}

	const viewport = page.viewportSize();
	expect(viewport).toEqual({ width: 390, height: 844 });

	const toolbar = page.getByTestId('puzzle-toolbar');
	const toolbarBox = await toolbar.boundingBox();
	expect(toolbarBox).not.toBeNull();
	expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
	expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(viewport!.width);

	const undo = page.getByRole('button', { name: 'Undo' });
	const redo = page.getByRole('button', { name: 'Redo' });
	const hint = page.getByRole('button', { name: 'Hint' });
	await expect(undo).toBeVisible();
	await expect(redo).toBeVisible();
	await expect(hint).toBeVisible();
	await expect(toggleReference).toBeVisible();
	await expect(peekReference).toBeHidden();
	await expect(more).toBeVisible();
	await expect(more).toHaveAttribute('aria-expanded', 'false');

	// Touch-target minimums: every visible primary action must be >= 44 px.
	for (const control of [undo, redo, hint, toggleReference, more]) {
		const box = await control.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.width).toBeGreaterThanOrEqual(44);
		expect(box!.height).toBeGreaterThanOrEqual(44);
	}

	await expect(zoomIn).toBeHidden();
	await expect(pause).toBeHidden();
	await expect(setup).toBeHidden();

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expect(peekReference).toBeVisible();
	await expect(zoomIn).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reset view' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rotation mode' })).toBeVisible();
	await expect(pause).toBeVisible();
	await expect(setup).toBeVisible();

	// Actionability is the stacking proof. This fails if the board covers the panel.
	await zoomIn.click();

	const secondaryBox = await page.getByTestId('puzzle-toolbar-secondary').boundingBox();
	expect(secondaryBox).not.toBeNull();
	expect(secondaryBox!.x).toBeGreaterThanOrEqual(0);
	expect(secondaryBox!.x + secondaryBox!.width).toBeLessThanOrEqual(viewport!.width);

	const documentOverflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth
	}));
	expect(documentOverflow.scrollWidth).toBeLessThanOrEqual(documentOverflow.clientWidth);

	const mainOverflow = await page.locator('.puzzle-main').evaluate((element) => ({
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth
	}));
	expect(mainOverflow.scrollWidth).toBeLessThanOrEqual(mainOverflow.clientWidth);

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(zoomIn).toBeHidden();
});

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
	// HPA-219 invariant: the open drawer's bottom must stay within the 390x844
	// fold. The mobile layout pins .puzzle-page to the viewport and lets the
	// board panel shrink (its .board-wrap scrolls) so the tools row + 20rem cap
	// never push the drawer past the fold.
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

	const panel = page.getByTestId('puzzle-inventory-panel');
	const viewport = page.viewportSize();
	const panelBox = await panel.boundingBox();
	const firstSlotBox = await page.locator('[data-testid^="piece-slot-"]').first().boundingBox();
	expect(viewport).toEqual({ width: 390, height: 844 });
	expect(panelBox).not.toBeNull();
	expect(firstSlotBox).not.toBeNull();
	// HPA-220 fence: the large-inventory drawer must still fit the 390x844 fold
	// (panel bottom ≤ viewport bottom) AND retain two complete piece rows of
	// grid content under the mobile slot size, proving the tools row did not
	// steal the grid budget. The 4-piece test above owns horizontal slot
	// density; this test owns the fold-fit + two-row budget and the swipe-scroll
	// behavior below.
	expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(viewport!.height);
	const gridBudget = await grid.evaluate((element) => {
		const style = getComputedStyle(element);
		const paddingTop = Number.parseFloat(style.paddingTop) || 0;
		const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
		const rowGap = Number.parseFloat(style.rowGap) || 0;
		return {
			contentHeight: element.clientHeight - paddingTop - paddingBottom,
			rowGap
		};
	});

	expect(gridBudget.contentHeight).toBeGreaterThanOrEqual(
		firstSlotBox!.height * 2 + gridBudget.rowGap
	);

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
