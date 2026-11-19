// Deterministic image-status coverage for the gameplay surfaces (HPA-1029).
//
// Every assertion pairs the data-image-state the shared imageStatus action
// reflects on the <img> with ACTUAL decoded readiness (naturalWidth), so a
// falsely-marked loaded attribute cannot pass. Image failures and holds come
// from the image-hold helper (declared to diagnostics), so diagnostics keeps
// everything else fatal.
//
// Tags: @smoke — runs in the smoke gate (chromium-desktop + chromium-mobile).
import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import { isDesktopChromiumProject } from './support/gameplay-page';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };

/** Decoded width of an <img> (0 until the browser has decoded real pixels). */
async function naturalWidth(img: ReturnType<Page['locator']>): Promise<number> {
	return img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
}

/** Open the reference overlay from the toolbar, on any smoke-lane layout. */
async function toggleReference(page: Page): Promise<void> {
	if (!isDesktopChromiumProject()) {
		await page.getByRole('button', { name: 'More puzzle actions' }).click();
	}
	await page.getByRole('button', { name: 'Toggle reference' }).click();
}

test.describe('gameplay artwork status @smoke', () => {
	test('held piece image shows pending, then loads decoded after release @smoke', async ({
		gameplayPage
	}) => {
		const page = gameplayPage.page;
		await gameplayPage.gotoFixture({
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'piece', pieceId: 0 }, outcome: 'hold' }]
		});

		const heldSlot = gameplayPage.pieceSource(0);
		const heldImg = heldSlot.locator('[data-testid="puzzle-piece"] img');
		const pendingBadge = heldSlot.getByTestId('piece-image-status');

		// Held request: the tray slot shows an explicit pending state and the
		// <img> reports it with no decoded pixels.
		await expect(pendingBadge).toBeVisible();
		await expect(pendingBadge).toHaveAttribute('data-status', 'pending');
		await expect(heldImg).toHaveAttribute('data-image-state', 'pending');
		expect(await naturalWidth(heldImg)).toBe(0);

		// The hold is narrowly scoped: piece 1 was never held and loads.
		const otherImg = page.locator('[data-testid="puzzle-piece"][data-piece-id="1"] img');
		await expect(otherImg).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(otherImg)).toBeGreaterThan(0);

		await gameplayPage.imageHoldHandle!.release();

		await expect(heldImg).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(heldImg)).toBeGreaterThan(0);
		await expect(pendingBadge).toHaveCount(0);
	});

	test('failed piece image shows an explicit error state and placement still works @smoke', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture({
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'piece', pieceId: 3 }, outcome: 'fail', status: 404 }]
		});

		const failedSlot = gameplayPage.pieceSource(3);
		const errorBadge = failedSlot.getByTestId('piece-image-status');
		const failedImg = failedSlot.locator('[data-testid="puzzle-piece"] img');

		await expect(errorBadge).toBeVisible();
		await expect(errorBadge).toHaveAttribute('data-status', 'error');
		await expect(failedImg).toHaveAttribute('data-image-state', 'error');
		expect(await naturalWidth(failedImg)).toBe(0);

		// Imagery is presentation-only: the failed piece still selects and
		// places, and the placed cell's <img> reports the same failed state.
		await gameplayPage.selectAndPlaceWithKeyboard(3, 1, 1);
		await gameplayPage.expectPiecePlaced(3, 1, 1);
		const placedImg = gameplayPage.dropZone(1, 1).locator('img');
		await expect(placedImg).toHaveAttribute('data-image-state', 'error');
		expect(await naturalWidth(placedImg)).toBe(0);
	});

	test('failed reference is unavailable, then recovers on reopen without a reload @smoke', async ({
		gameplayPage
	}) => {
		const page = gameplayPage.page;
		await gameplayPage.gotoFixture({
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'reference' }, outcome: 'fail', status: 404 }]
		});
		// A full reload would reset this marker; the recovery below must keep it.
		await page.evaluate(() => {
			(window as unknown as { __artworkNoReload?: boolean }).__artworkNoReload = true;
		});

		await toggleReference(page);
		const overlay = page.getByTestId('reference-overlay');
		await expect(overlay).toBeVisible();
		const refImg = overlay.locator('img');
		await expect(refImg).toHaveAttribute('data-image-state', 'error');
		await expect(overlay.getByTestId('reference-image-unavailable')).toBeVisible();
		expect(await naturalWidth(refImg)).toBe(0);

		// Close, drop the declared failure route, reopen: the overlay remounts
		// its <img>, the retry reaches the fixture router, and the image loads —
		// all without a full page reload.
		await page.getByTestId('reference-overlay-close').click();
		await expect(overlay).toBeHidden();
		await gameplayPage.imageHolds.dispose();
		// The failure route is gone: retire the declaration so the recovery 200
		// is no longer measured against it — any NEW failure stays fatal.
		gameplayPage.diagnostics.setDeclaredImageFailures([]);
		await toggleReference(page);

		await expect(refImg).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(refImg)).toBeGreaterThan(0);
		await expect(overlay.getByTestId('reference-image-unavailable')).toHaveCount(0);
		expect(
			await page.evaluate(
				() => (window as unknown as { __artworkNoReload?: boolean }).__artworkNoReload
			)
		).toBe(true);
	});

	test('changed reference URL recovers on the same mounted image without a reload @smoke', async ({
		gameplayPage
	}) => {
		const page = gameplayPage.page;
		await gameplayPage.gotoFixture({
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'reference' }, outcome: 'fail', status: 404 }]
		});
		// A full reload would reset this marker; the recovery below must keep it.
		await page.evaluate(() => {
			(window as unknown as { __artworkNoReload?: boolean }).__artworkNoReload = true;
		});

		await toggleReference(page);
		const overlay = page.getByTestId('reference-overlay');
		await expect(overlay).toBeVisible();
		const refImg = overlay.locator('img');
		await expect(refImg).toHaveAttribute('data-image-state', 'error');
		await expect(overlay.getByTestId('reference-image-unavailable')).toBeVisible();

		// The failure is asserted — retire the declaration AND remove the
		// failing route so any NEW failure (including the changed URL below)
		// stays fatal and the changed URL reaches the fixture router.
		await gameplayPage.imageHolds.dispose();
		gameplayPage.diagnostics.setDeclaredImageFailures([]);

		// Mark the element: the recovery must happen on the SAME <img> — a
		// remount would lose this attribute (that path is covered above).
		await refImg.evaluate((el) => {
			(el as HTMLImageElement).dataset.urlChangeProbe = 'mounted';
		});
		// Change the mounted image's URL in place. The fixture router answers
		// the same endpoint with a distinguishing query, so the browser issues
		// a real request for a DIFFERENT URL on the already-mounted element.
		const changedUrl: string = await refImg.evaluate((el) => {
			const img = el as HTMLImageElement;
			img.src = `${img.src}?retry=changed`;
			return img.src;
		});
		expect(changedUrl).toContain('?retry=changed');

		// The imageStatus action must not retain the prior error state: the
		// mounted image reports the new URL's outcome and the unavailable note
		// clears — all without a reload or a remount.
		await expect(refImg).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(refImg)).toBeGreaterThan(0);
		await expect(overlay.getByTestId('reference-image-unavailable')).toHaveCount(0);
		expect(await refImg.getAttribute('data-url-change-probe')).toBe('mounted');
		expect(
			await page.evaluate(
				() => (window as unknown as { __artworkNoReload?: boolean }).__artworkNoReload
			)
		).toBe(true);
	});

	test('solved fixture keeps placed imagery and loads both completion artwork surfaces @smoke', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture({
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START
		});

		await gameplayPage.solveFixture();
		const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);

		// Placed pieces carry real decoded imagery (not just an optimistic state).
		const placedImg = gameplayPage.dropZone(0, 0).locator('img');
		await expect(placedImg).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(placedImg)).toBeGreaterThan(0);

		// Surface 1: results preview art.
		const previewArt = dialog.getByTestId('completion-reference-art');
		await expect(previewArt).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(previewArt)).toBeGreaterThan(0);
		await expect(dialog.getByTestId('completion-preview-unavailable')).toHaveCount(0);

		// Surface 2: the full-artwork view (remounts the image on switch).
		await dialog.getByTestId('view-artwork').click();
		const artwork = dialog.getByTestId('completion-artwork-image');
		await expect(artwork).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(artwork)).toBeGreaterThan(0);
		await expect(dialog.getByTestId('completion-artwork-unavailable')).toHaveCount(0);

		// Local completion intact: exactly one sealed server request.
		await expect.poll(() => gameplayPage.apiController.recordedRequests.length).toBe(1);
	});

	// --- Completion artwork pending/error states (review wave) ----------------

	/** Bounding box of the results preview's placeholder frame (the img's wrapper). */
	async function previewFrameBox(dialog: ReturnType<Page['getByRole']>): Promise<{
		width: number;
		height: number;
	}> {
		const box = await dialog.locator('.completion-art-frame').boundingBox();
		expect(box, 'results preview frame must have a bounding box').not.toBeNull();
		return box!;
	}

	/** Wait until the dialog's finite entry animations (the 0.35s
	 * celebration-in scale-up on the modal box itself) have finished, so
	 * measured boxes are final-size (the infinite pending-pulse/flicker
	 * animations never settle and are excluded). Without this, a measurement
	 * taken mid-animation differs from the settled size by the remaining
	 * scale factor. */
	async function modalBoxSettled(dialog: ReturnType<Page['getByRole']>): Promise<void> {
		await expect
			.poll(() =>
				dialog.evaluate((node) =>
					(node as HTMLElement)
						.getAnimations()
						.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
						.every((animation) => animation.playState === 'finished')
				)
			)
			.toBe(true);
	}

	test('held reference keeps a bounded pending frame in the results preview, then loads decoded after release @smoke', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture({
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'reference' }, outcome: 'hold' }]
		});

		await gameplayPage.solveFixture();
		const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);

		// Held request: the dialog is open and the results preview is pending.
		await expect.poll(() => gameplayPage.imageHoldHandle!.pendingCount).toBe(1);
		const previewArt = dialog.getByTestId('completion-reference-art');
		await expect(previewArt).toHaveAttribute('data-image-state', 'pending');
		expect(await naturalWidth(previewArt)).toBe(0);

		// The pending pulse must sit on a REAL frame: nonzero width and height
		// with the reserved 3/4 aspect (below 900px the responsive width governs;
		// a wrapper sized from an undecoded img collapses to 0). Desktop and
		// mobile smoke lanes both run this assertion at their own widths.
		await modalBoxSettled(dialog);
		const pendingBox = await previewFrameBox(dialog);
		expect(pendingBox.width).toBeGreaterThan(0);
		expect(pendingBox.height).toBeGreaterThan(0);
		expect(pendingBox.height / pendingBox.width).toBeCloseTo(4 / 3, 1);

		await gameplayPage.imageHoldHandle!.release();

		// Released: decoded imagery in the SAME frame — no size or aspect shift.
		await expect(previewArt).toHaveAttribute('data-image-state', 'loaded');
		await expect.poll(() => naturalWidth(previewArt)).toBeGreaterThan(0);
		const loadedBox = await previewFrameBox(dialog);
		expect(loadedBox.width).toBeCloseTo(pendingBox.width, 0);
		expect(loadedBox.height).toBeCloseTo(pendingBox.height, 0);
		await expect(dialog.getByTestId('completion-preview-unavailable')).toHaveCount(0);
	});

	test('failed reference shows unavailable in the results preview and still opens the artwork view @smoke', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture({
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'reference' }, outcome: 'fail', status: 404 }]
		});

		await gameplayPage.solveFixture();
		const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);

		const previewArt = dialog.getByTestId('completion-reference-art');
		await expect(previewArt).toHaveAttribute('data-image-state', 'error');
		expect(await naturalWidth(previewArt)).toBe(0);

		// The explicit fallback stays bounded by the same 3/4 frame (never a
		// collapsed or unbounded dark area).
		const fallback = dialog.getByTestId('completion-preview-unavailable');
		await expect(fallback).toBeVisible();
		const frameBox = await previewFrameBox(dialog);
		expect(frameBox.width).toBeGreaterThan(0);
		expect(frameBox.height).toBeGreaterThan(0);
		const fallbackBox = await fallback.boundingBox();
		expect(fallbackBox!.width).toBeGreaterThan(0);
		expect(fallbackBox!.height).toBeGreaterThan(0);

		// Presentation-only failure: the VIEW ARTWORK entry still navigates.
		await dialog.getByTestId('view-artwork').click();
		await expect(dialog.getByTestId('completion-artwork-view')).toBeVisible();
	});

	test('full-artwork view keeps a bounded pending stage, then loads decoded after release @smoke', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture({
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'reference' }, outcome: 'hold' }]
		});

		await gameplayPage.solveFixture();
		const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);

		// Both mounted surfaces fetch the held reference (preview + artwork);
		// Chromium may coalesce the identical in-flight requests into ONE route
		// hit, so only assert the hold is still active here — the per-image
		// assertions below carry the state proof.
		await dialog.getByTestId('view-artwork').click();
		await expect.poll(() => gameplayPage.imageHoldHandle!.pendingCount).toBeGreaterThanOrEqual(1);
		const artwork = dialog.getByTestId('completion-artwork-image');
		await expect(artwork).toHaveAttribute('data-image-state', 'pending');
		expect(await naturalWidth(artwork)).toBe(0);

		// The bounded stage reserves nonzero dimensions while undecoded.
		const stage = dialog.locator('.artwork-image-wrap.art-stage');
		const stageBox = await stage.boundingBox();
		expect(stageBox, 'full-artwork pending stage must have a bounding box').not.toBeNull();
		expect(stageBox!.width).toBeGreaterThan(0);
		expect(stageBox!.height).toBeGreaterThan(0);

		// release() answers only the requests pending at snapshot time — a
		// non-coalesced artwork request can still land afterwards and stay
		// held, so keep draining the hold until the artwork actually decodes.
		await expect
			.poll(async () => {
				await gameplayPage.imageHoldHandle!.release();
				return naturalWidth(artwork);
			})
			.toBeGreaterThan(0);

		// Released: the artwork decodes in place and the pending stage drops.
		await expect(artwork).toHaveAttribute('data-image-state', 'loaded');
		await expect(stage).toHaveCount(0);
		await expect(dialog.getByTestId('completion-artwork-unavailable')).toHaveCount(0);
	});

	test('failed reference shows unavailable in the full-artwork view and returns to results @smoke', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture({
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START,
			imageHolds: [{ endpoint: { kind: 'reference' }, outcome: 'fail', status: 404 }]
		});

		await gameplayPage.solveFixture();
		const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		await dialog.getByTestId('view-artwork').click();

		const artwork = dialog.getByTestId('completion-artwork-image');
		await expect(artwork).toHaveAttribute('data-image-state', 'error');
		expect(await naturalWidth(artwork)).toBe(0);
		await expect(dialog.getByTestId('completion-artwork-unavailable')).toBeVisible();

		// Navigation intact: BACK TO RESULTS returns to the results subview.
		await dialog.getByTestId('back-to-results').click();
		await expect(dialog.getByTestId('completion-artwork-view')).toHaveCount(0);
		await expect(dialog.getByTestId('completion-reference-art')).toHaveCount(1);
	});
});
