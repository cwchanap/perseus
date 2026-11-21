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

	const toolbar = page.getByTestId('puzzle-toolbar');
	const secondary = page.getByTestId('puzzle-toolbar-secondary');
	const more = page.getByRole('button', { name: 'More puzzle actions' });
	const zoomIn = page.getByRole('button', { name: 'Zoom in' });
	const resetView = page.getByRole('button', { name: 'Reset view' });
	const pause = page.getByRole('button', { name: 'Pause mission' });
	const setup = page.getByRole('button', { name: 'Open mission setup' });
	const toggleReference = page.getByRole('button', { name: 'Toggle reference' });
	const peekReference = page.getByRole('button', { name: 'Hold to peek reference' });

	// Every open More action must keep its pre-labels accessible name (asserted
	// through the computed name, not the aria-label attribute), render its text
	// label as a case-insensitive substring of that name (matching the
	// component test's accessible-name agreement contract), and keep a
	// >= 44px target. Shared by the desktop flyout and the compact panel.
	const PANEL_ACTION_NAMES: Record<string, string> = {
		redo: 'Redo',
		'zoom-out': 'Zoom out',
		'zoom-in': 'Zoom in',
		rotation: 'Rotation mode',
		sound: 'Sound effects',
		peek: 'Hold to peek reference',
		leaderboard: 'Open family leaderboard',
		setup: 'Open mission setup'
	};
	async function expectLabeledPanelActions(): Promise<void> {
		const panelButtons = secondary.locator('button:visible');
		const panelButtonCount = await panelButtons.count();
		expect(panelButtonCount).toBeGreaterThanOrEqual(6);
		for (let buttonIndex = 0; buttonIndex < panelButtonCount; buttonIndex += 1) {
			const action = panelButtons.nth(buttonIndex);
			const actionKey = (await action.getAttribute('data-toolbar-action')) ?? '';
			const expectedName = PANEL_ACTION_NAMES[actionKey];
			expect(expectedName, `unexpected open-panel action "${actionKey}"`).toBeTruthy();
			await expect(action).toHaveAccessibleName(expectedName);
			const label = action.locator('.toolbar-action-label');
			await expect(label).toBeVisible();
			const labelText = ((await label.textContent()) ?? '').trim();
			const name = (await action.getAttribute('aria-label')) ?? '';
			expect(labelText.length).toBeGreaterThan(0);
			expect(name.toLowerCase()).toContain(labelText.toLowerCase());
			const box = await action.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.width).toBeGreaterThanOrEqual(44);
			expect(box!.height).toBeGreaterThanOrEqual(44);
		}
	}

	if (project === 'chromium-desktop') {
		for (const [index, viewport] of [
			{ width: 1080, height: 810 },
			{ width: 1440, height: 900 }
		].entries()) {
			await page.setViewportSize(viewport);

			await expect(more).toBeVisible();
			await expect(zoomIn).toBeHidden();
			await expect(setup).toBeHidden();
			await expect(peekReference).toBeHidden();
			await expect(pause).toBeVisible();
			await expect(toggleReference).toBeVisible();
			if (index === 0) {
				await more.click();
				await expect(more).toHaveAttribute('aria-expanded', 'true');
				await expect(zoomIn).toBeVisible();
				await expect(setup).toBeVisible();
				await expect(peekReference).toBeVisible();
				await more.click();
				await expect(more).toHaveAttribute('aria-expanded', 'false');
			}

			// Redo is a direct rail action when enabled. Its closed secondary
			// wrapper must not stretch it to the flyout width.
			await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
			await page.getByRole('button', { name: 'Undo' }).click();
			const undoBox = await page.getByRole('button', { name: 'Undo' }).boundingBox();
			const redoBox = await page.getByRole('button', { name: 'Redo' }).boundingBox();
			expect(undoBox).not.toBeNull();
			expect(redoBox).not.toBeNull();
			expect(redoBox!.width).toBeCloseTo(undoBox!.width, 1);
			expect(redoBox!.height).toBeCloseTo(undoBox!.height, 1);

			await more.click();
			await expect(more).toHaveAttribute('aria-expanded', 'true');
			await expect(zoomIn).toBeVisible();
			await expect(peekReference).toBeVisible();
			await expectLabeledPanelActions();

			// The open flyout keeps the roving contract — exactly one visible
			// Tab stop across rail + panel — and arrow keys walk rail ->
			// panel (More -> Pause -> first flyout action).
			await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
			await more.focus();
			await page.keyboard.press('ArrowRight');
			await expect(pause).toBeFocused();
			await page.keyboard.press('ArrowRight');
			expect(
				await page.evaluate(
					() => document.activeElement?.closest('#puzzle-toolbar-secondary') !== null
				)
			).toBe(true);

			const secondaryBox = await secondary.boundingBox();
			expect(secondaryBox).not.toBeNull();
			expect(secondaryBox!.x).toBeGreaterThanOrEqual(0);
			expect(secondaryBox!.x + secondaryBox!.width).toBeLessThanOrEqual(viewport.width);
			expect(secondaryBox!.y).toBeGreaterThanOrEqual(0);
			expect(secondaryBox!.y + secondaryBox!.height).toBeLessThanOrEqual(viewport.height);
			const zoomBox = await zoomIn.boundingBox();
			expect(zoomBox).not.toBeNull();
			const zoomHit = await page.evaluate(
				({ x, y }) => {
					const hit = document.elementFromPoint(x, y);
					return hit?.closest('[aria-label="Zoom in"]') !== null;
				},
				{ x: zoomBox!.x + zoomBox!.width / 2, y: zoomBox!.y + zoomBox!.height / 2 }
			);
			expect(zoomHit).toBe(true);
			await zoomIn.click();

			// The open flyout must not push the document or .puzzle-main past
			// the viewport width.
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
		}
		return;
	}

	const viewport = page.viewportSize();
	expect(viewport).toEqual({ width: 390, height: 844 });

	const toolbarBox = await toolbar.boundingBox();
	expect(toolbarBox).not.toBeNull();
	expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
	expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(viewport!.width);

	const undo = page.getByRole('button', { name: 'Undo' });
	const redo = page.getByRole('button', { name: 'Redo' });
	const hint = page.getByRole('button', { name: 'Hint' });
	await expect(undo).toBeVisible();
	await expect(undo).toBeDisabled();
	await expect(redo).toBeHidden();
	await expect(hint).toBeVisible();
	await expect(toggleReference).toBeVisible();
	await expect(resetView).toBeVisible();
	await expect(pause).toBeVisible();
	await expect(peekReference).toBeHidden();
	await expect(more).toBeVisible();
	await expect(more).toHaveAttribute('aria-expanded', 'false');

	// Touch-target minimums: every visible primary action must be >= 44 px.
	for (const control of [undo, hint, toggleReference, resetView, pause, more]) {
		const box = await control.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.width).toBeGreaterThanOrEqual(44);
		expect(box!.height).toBeGreaterThanOrEqual(44);
	}

	await expect(zoomIn).toBeHidden();
	await expect(setup).toBeHidden();

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expect(peekReference).toBeVisible();
	await expect(redo).toBeVisible();
	await expect(zoomIn).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rotation mode' })).toBeVisible();
	await expect(setup).toBeVisible();
	await expectLabeledPanelActions();

	// The open compact panel keeps the roving contract — exactly one visible
	// Tab stop across rail + panel — and ArrowRight from More (the last rail
	// action) lands on the first open-panel action.
	await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
	await more.focus();
	await page.keyboard.press('ArrowRight');
	expect(
		await page.evaluate(() => document.activeElement?.closest('#puzzle-toolbar-secondary') !== null)
	).toBe(true);

	// Actionability is the stacking proof. This fails if the board covers the panel.
	await zoomIn.click();

	const secondaryBox = await secondary.boundingBox();
	expect(secondaryBox).not.toBeNull();
	expect(secondaryBox!.x).toBeGreaterThanOrEqual(0);
	expect(secondaryBox!.x + secondaryBox!.width).toBeLessThanOrEqual(viewport!.width);
	expect(secondaryBox!.y).toBeGreaterThanOrEqual(0);
	expect(secondaryBox!.y + secondaryBox!.height).toBeLessThanOrEqual(viewport!.height);

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

test('phone keeps enabled Redo behind More after Undo @smoke', async ({ gameplayPage, page }) => {
	test.skip(!isChromiumMobile(), 'Redo placement proof uses chromium-mobile');
	await gameplayPage.gotoFixture({
		fixtureId: 'e2e2a000-0000-4000-8000-000000000004',
		seedPreferences: IMMEDIATE_START
	});
	await gameplayPage.placeWithTap(0, 0, 0);
	await page.getByRole('button', { name: 'Undo' }).click();

	const more = page.getByRole('button', { name: 'More puzzle actions' });
	const redo = page.getByRole('button', { name: 'Redo' });
	const redoAction = page.locator('[data-toolbar-action="redo"]');
	await expect(redo).toBeHidden();
	await expect(redoAction).toBeEnabled();
	await expect(more).toHaveAttribute('aria-expanded', 'false');

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'true');
	await expect(redo).toBeVisible();
	await expect(redoAction).toBeEnabled();

	await more.click();
	await expect(more).toHaveAttribute('aria-expanded', 'false');
	await expect(redo).toBeHidden();
});

test('canonical phone workspace keeps the board above the half sheet and exposes direct actions @smoke', async ({
	gameplayPage,
	page
}) => {
	test.skip(!isChromiumMobile(), 'canonical phone proof uses chromium-mobile');
	await gameplayPage.gotoFixture({
		fixtureId: 'e2e2c000-0000-4000-8000-000000000012',
		seedPreferences: IMMEDIATE_START
	});

	const board = await page.getByTestId('puzzle-board').boundingBox();
	const sheet = await page.getByTestId('puzzle-inventory-panel').boundingBox();
	const viewport = page.viewportSize();
	expect(viewport).toEqual({ width: 390, height: 844 });
	expect(board).not.toBeNull();
	expect(sheet).not.toBeNull();
	expect(board!.y).toBeGreaterThanOrEqual(0);
	expect(board!.y + board!.height).toBeLessThanOrEqual(sheet!.y + 1);
	await expect(page.getByTestId('puzzle-inventory-panel')).toHaveAttribute(
		'data-sheet-state',
		'half'
	);

	for (const name of ['Hint', 'Toggle reference', 'Undo', 'Reset view', 'Pause mission']) {
		await expect(page.getByRole('button', { name })).toBeVisible();
	}
	await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Redo' })).toBeHidden();

	const toolbar = page.getByTestId('puzzle-toolbar');
	await expect(toolbar.locator('[data-toolbar-action][tabindex="0"]:visible')).toHaveCount(1);
	const fixedButtons = await toolbar
		.locator('[data-toolbar-action]:visible')
		.evaluateAll(
			(buttons) => buttons.filter((button) => getComputedStyle(button).position === 'fixed').length
		);
	expect(fixedButtons).toBe(0);

	await page.getByRole('button', { name: 'Pause mission' }).click();
	await expect(page.getByRole('dialog', { name: 'Mission Paused' })).toBeVisible();
	await page
		.getByRole('dialog', { name: 'Mission Paused' })
		.getByRole('button', { name: 'Resume' })
		.click();
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
		fixtureId: 'e2e2a000-0000-4000-8000-000000000100',
		seedPreferences: IMMEDIATE_START
	});

	const grid = page.locator('.pieces-grid');
	const gridBox = await grid.boundingBox();
	expect(gridBox).not.toBeNull();

	const panel = page.getByTestId('puzzle-inventory-panel');
	const viewport = page.viewportSize();
	const panelBox = await panel.boundingBox();
	// HPA-466: capture the unselected baseline BEFORE selection — the selected
	// slot's 2x2 span reflows grid auto-placement, so no slot index is
	// guaranteed to stay a normal-size reference afterwards.
	const baselineSlotBox = await page.locator('[data-testid^="piece-slot-"]').first().boundingBox();
	expect(viewport).toEqual({ width: 390, height: 844 });
	expect(panelBox).not.toBeNull();
	expect(baselineSlotBox).not.toBeNull();
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
		baselineSlotBox!.height * 2 + gridBudget.rowGap
	);

	// HPA-466: selecting a piece expands its tray slot to a 2x2 grid area for
	// inspection. The expanded slot must be materially larger than the
	// unselected baseline without pushing the drawer past the 390x844 fold.
	const firstPieceId = gameplayPage.fixture!.initialTrayOrder[0]!;
	const firstPiece = gameplayPage.pieceSource(firstPieceId).getByTestId('puzzle-piece');
	await gameplayPage.tapPiece(firstPieceId);
	await expect(firstPiece).toHaveAttribute('data-selected', 'true');
	await expect(gameplayPage.pieceSource(firstPieceId)).toHaveClass(/selected-expanded/);
	await expect(page.locator('.piece-slot.selected-expanded')).toHaveCount(1);
	const expandedSlotBox = await page.locator('.piece-slot.selected-expanded').boundingBox();
	expect(expandedSlotBox).not.toBeNull();
	expect(expandedSlotBox!.width).toBeGreaterThanOrEqual(baselineSlotBox!.width * 2);
	expect(expandedSlotBox!.height).toBeGreaterThanOrEqual(baselineSlotBox!.height * 2);
	const panelBoxSelected = await panel.boundingBox();
	expect(panelBoxSelected).not.toBeNull();
	expect(panelBoxSelected!.y + panelBoxSelected!.height).toBeLessThanOrEqual(viewport!.height);

	const before = await grid.evaluate((element) => element.scrollTop);
	// Selection reflowed the grid; re-locate the swipe start on the still
	// selected piece so the touch sequence begins on an actual piece.
	const pieceBox = await firstPiece.boundingBox();
	expect(pieceBox).not.toBeNull();
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
	// Rotation mode is enabled so the reserved instruction line also proves
	// its rotate-first copy: fixture pieces 1-3 start non-upright.
	await gameplayPage.gotoFixture({
		seedPreferences: { ...IMMEDIATE_START, rotationEnabled: true },
		completion: { kind: 'success' }
	});

	const toggle = page.getByTestId('inventory-drawer-toggle');
	await expect(toggle).toHaveAttribute('aria-label', 'Expand piece tray to full');
	await expect(page.getByTestId('puzzle-inventory-panel')).toHaveAttribute(
		'data-sheet-state',
		'half'
	);
	await expect(page.getByTestId('puzzle-board')).toBeVisible();

	// HPA-1031: the reserved instruction line guides selection at real 390px
	// width; its fixed slot height and the board viewport height never change
	// as the copy transitions.
	const hint = page.getByTestId('gameplay-hint');
	const boardViewport = page.getByTestId('board-viewport');
	await expect(hint).toHaveText('Select a piece, then click/tap a cell or drag.');
	const hintBox = await hint.boundingBox();
	const viewportBox = await boardViewport.boundingBox();
	expect(hintBox).not.toBeNull();
	expect(hintBox!.height).toBeGreaterThan(0);
	expect(viewportBox).not.toBeNull();

	// Piece 0 belongs at (0, 0) and starts upright; reject it at (1, 1).
	await gameplayPage.tapPiece(0);
	const piece0 = gameplayPage.pieceSource(0).getByTestId('puzzle-piece');
	await expect(piece0).toHaveAttribute('data-selected', 'true');
	await expect(hint).toHaveText('Piece selected: click/tap its board cell.');
	expect((await hint.boundingBox())?.height).toBe(hintBox!.height);
	expect((await boardViewport.boundingBox())?.height).toBe(viewportBox!.height);
	await gameplayPage.dropZone(1, 1).tap();

	// Durable rejection contract: the slot stays and selection stays.
	await expect(gameplayPage.pieceSource(0)).toBeVisible();
	await expect(piece0).toHaveAttribute('data-selected', 'true');
	await expect(hint).toHaveText('Piece selected: click/tap its board cell.');

	// Retrying the selected piece at its real cell succeeds and clears selection.
	await gameplayPage.placeWithTap(0, 0, 0);
	await gameplayPage.expectPiecePlaced(0, 0, 0);
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);
	// Post-first-placement with nothing selected keeps the reserved line empty.
	await expect(hint).toHaveText('');
	expect((await boardViewport.boundingBox())?.height).toBe(viewportBox!.height);

	// Prove Cancel remains available in the collapsed header.
	await gameplayPage.tapPiece(1);
	await expect(gameplayPage.pieceSource(1).getByTestId('puzzle-piece')).toHaveAttribute(
		'data-selected',
		'true'
	);
	// Piece 1 starts rotated under the seeded rotation mode, so the line
	// instructs the player to rotate upright before the cell accepts the tap.
	await expect(hint).toHaveText('Rotate upright first, then click/tap its cell.');
	expect((await hint.boundingBox())?.height).toBe(hintBox!.height);
	expect((await boardViewport.boundingBox())?.height).toBe(viewportBox!.height);

	// HPA-1031 visual-acceptance fix: the compact header's back button
	// overhangs its parent by ~10px at 390px. The hint's text line boxes must
	// clear the button's real bounds so the first word stays readable, and
	// the copy must still fit inside the reserved two-line slot.
	const hintClearance = await page.evaluate(() => {
		const hintEl = document.querySelector('[data-testid="gameplay-hint"]');
		const back = document.querySelector('.hud-header .back-btn');
		if (!hintEl || !back) return null;
		const hintRect = hintEl.getBoundingClientRect();
		const range = document.createRange();
		range.selectNodeContents(hintEl);
		const backRect = back.getBoundingClientRect();
		return {
			hint: { top: hintRect.top, bottom: hintRect.bottom },
			lines: [...range.getClientRects()].map((rect) => ({
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom
			})),
			back: {
				left: backRect.left,
				right: backRect.right,
				top: backRect.top,
				bottom: backRect.bottom
			}
		};
	});
	expect(hintClearance).not.toBeNull();
	expect(hintClearance!.lines.length).toBeGreaterThan(0);
	expect(hintClearance!.lines.length).toBeLessThanOrEqual(2);
	for (const line of hintClearance!.lines) {
		const overlapsBack =
			line.left < hintClearance!.back.right &&
			line.right > hintClearance!.back.left &&
			line.top < hintClearance!.back.bottom &&
			line.bottom > hintClearance!.back.top;
		expect(overlapsBack).toBe(false);
		// Every wrapped line stays inside the reserved slot height.
		expect(line.bottom).toBeLessThanOrEqual(hintClearance!.hint.bottom);
	}
	await page.getByRole('button', { name: 'Expand piece tray to full' }).click();
	await page.getByRole('button', { name: 'Collapse piece tray to peek' }).click();
	await expect(toggle).toHaveAttribute('aria-label', 'Expand piece tray to half');
	await expect(page.getByTestId('puzzle-inventory-panel')).toHaveAttribute(
		'data-sheet-state',
		'peek'
	);
	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	await page.getByRole('button', { name: 'Cancel selected piece' }).click();
	await expect(page.locator('[data-testid="puzzle-piece"][data-selected="true"]')).toHaveCount(0);
	await expect(hint).toHaveText('');

	await page.getByRole('button', { name: 'Expand piece tray to half' }).click();
	await expect(toggle).toHaveAttribute('aria-label', 'Expand piece tray to full');

	const fixture = gameplayPage.fixture!;
	const rotateSelected = page.getByRole('button', { name: 'Rotate selected piece' });
	for (const piece of fixture.pieces.filter((candidate) => candidate.id !== 0)) {
		await gameplayPage.tapPiece(piece.id);
		await expect(gameplayPage.pieceSource(piece.id).getByTestId('puzzle-piece')).toHaveAttribute(
			'data-selected',
			'true'
		);
		// Each remaining fixture piece starts non-upright; rotate it back to
		// upright so its cell accepts the tap placement.
		for (let turns = ((360 - fixture.rotations[piece.id]!) / 90) % 4; turns > 0; turns -= 1) {
			await rotateSelected.click();
		}
		await gameplayPage.dropZone(piece.correctX, piece.correctY).tap();
		await gameplayPage.expectPiecePlaced(piece.id, piece.correctX, piece.correctY);
	}

	await expect(page.getByTestId('celebration-modal')).toBeVisible();
	const overflow = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});
