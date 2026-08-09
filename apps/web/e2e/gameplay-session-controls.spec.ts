// Deterministic session-control E2E coverage (HPA-221 Task 8).
//
// Exercises the Mission Setup entry flow and the Pause/Resume/Restart
// controls introduced by HPA-221 through the canonical GameplayPage harness:
//
//   1. Timed setup -> first placement -> 3s active -> 5s paused -> 2s resumed
//      -> final timer 00:05.
//   2. Relaxed completion: no timed labels anywhere and a recorded request
//      sealing `resultClass: 'relaxed'` with no elapsed time.
//   3. A restored active Relaxed+rotation session: Resume, Restart, a fresh
//      run id, empty placements, and the setup choices retained.
//   4. webkit-mobile reachability of the setup dialog and Pause action,
//      a dynamic-height viewport, and Shift+Tab focus wrap.
//
// Determinism: the timer test passes `clock: { startAt }` to gotoFixture,
// which installs AND pauses Playwright's clock before navigation, so
// performance.now() stays frozen until the test advances it explicitly with
// page.clock.runFor() (see e2e/README.md). Fresh-session flows exercise the
// mandatory Mission Setup dialog (no seedPreferences); the restored flow
// seeds a snapshot via buildMinimalSeed, validated by the production codec
// before it is planted.
//
// Tags: @smoke runs in the smoke gate (chromium desktop/mobile);
// @webkit-critical runs in the webkit gate (webkit-mobile) — the dialog and
// keyboard interactions used here are reliable on WebKit (see README).
import { test, expect } from './support/test';
import { getFixture } from './gameplay-fixtures/catalog';
import { buildMinimalSeed } from './gameplay-fixtures/persisted-state';

const FIXTURE_ID = 'e2e-square-4' as const;
const START_AT = new Date('2026-01-01T00:00:00Z');

/** Piece id -> placement coordinates (correctX, correctY) for the 2x2 grid. */
const COORDS: Record<number, { x: number; y: number }> = {
	0: { x: 0, y: 0 },
	1: { x: 1, y: 0 },
	2: { x: 0, y: 1 },
	3: { x: 1, y: 1 }
};

test.describe('mission session controls', () => {
	test('timed setup: 3s active, 5s paused, 2s resumed seals 00:05 @smoke @webkit-critical', async ({
		gameplayPage,
		page
	}) => {
		// Fresh route entry with no seeded preferences: the mandatory Mission
		// Setup dialog presents before any play.
		await gameplayPage.gotoFixture({ clock: { startAt: START_AT } });

		// Configure and start the run from the dialog (defaults: timed).
		await gameplayPage.startMission();

		// The first placement starts the clock at monotonic zero.
		await gameplayPage.selectAndPlaceWithKeyboard(0, COORDS[0]!.x, COORDS[0]!.y);
		await gameplayPage.expectPiecePlaced(0, 0, 0);

		// 3 active seconds accumulate into the HUD timer.
		await page.clock.runFor(3_000);
		await expect(page.getByTestId('game-timer')).toHaveAttribute('aria-label', 'Timer: 00:03');

		// Pausing freezes the clock: 5 paused seconds change nothing.
		await gameplayPage.pauseMission();
		await page.clock.runFor(5_000);
		await expect(page.getByTestId('game-timer')).toHaveAttribute('aria-label', 'Timer: 00:03');

		// Resuming restarts the clock: 2 more seconds reach 00:05.
		await gameplayPage.resumeMission();
		await page.clock.runFor(2_000);
		await expect(page.getByTestId('game-timer')).toHaveAttribute('aria-label', 'Timer: 00:05');
	});

	test('relaxed completion: no timed labels, recorded resultClass relaxed @smoke @webkit-critical', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({
			clock: { startAt: START_AT },
			completion: { kind: 'success' }
		});

		await gameplayPage.startMission({ mode: 'relaxed' });

		// A relaxed run presents the static RELAXED indicator, never a timer.
		await expect(page.getByTestId('relaxed-mode-indicator')).toBeVisible();
		await expect(page.getByTestId('game-timer')).toHaveCount(0);

		await gameplayPage.solveFixture();

		// The celebration modal omits the timed labels (no FINAL TIME, no rank).
		await expect(page.getByTestId('celebration-modal')).toBeVisible();
		await expect(page.getByText('FINAL TIME')).toHaveCount(0);
		await expect(page.getByText('S RANK')).toHaveCount(0);

		// Exactly one sealed completion request, for a relaxed, clockless run.
		await expect.poll(() => gameplayPage.apiController.recordedRequests.length).toBe(1);
		const body = gameplayPage.apiController.recordedRequests[0]!.bodyJson as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({
			version: 1,
			runId: getFixture(FIXTURE_ID).runIds[0],
			resultClass: 'relaxed',
			elapsedActiveSeconds: null
		});
	});

	test('restored relaxed+rotation: Resume, Restart keeps choices and a fresh run @smoke @webkit-critical', async ({
		gameplayPage
	}) => {
		const fixture = getFixture(FIXTURE_ID);
		// A restored ACTIVE relaxed session with rotation configured but no
		// user activity yet — valid under the codec's pre-activity exception.
		const seeded = buildMinimalSeed(FIXTURE_ID);
		seeded.lifecycle = 'active';
		seeded.mode = 'relaxed';
		seeded.elapsedActiveSeconds = null;
		seeded.timerStarted = false;
		seeded.rotationEnabled = true;
		seeded.pieceRotations = { ...fixture.rotations };
		seeded.facts = { rotationUsed: true, hintUsed: false, ghostReferenceUsed: false };
		seeded.resultClass = 'relaxed';

		await gameplayPage.gotoFixture({ seedSession: seeded });

		// A restored active run is paused at entry and presented for explicit
		// re-engagement.
		await expect(gameplayPage.page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
		await gameplayPage.resumeMission();

		// Pause again from the toolbar and request a restart. The run has no
		// user activity, so Restart applies immediately (no confirmation).
		await gameplayPage.pauseMission();
		await gameplayPage.page
			.getByRole('dialog', { name: 'Mission Paused' })
			.getByRole('button', { name: 'Restart' })
			.click();

		// Restart re-opens the mandatory setup dialog with the retained
		// choices (relaxed + rotation) pre-selected.
		const setup = gameplayPage.missionSetupDialog();
		await expect(setup).toBeVisible();
		await expect(setup.getByLabel('Relaxed')).toBeChecked();
		await expect(setup.getByLabel('Enable rotation')).toBeChecked();

		// Start the fresh run with the retained choices.
		await gameplayPage.startMission();

		// The persisted snapshot is a fresh run: a new run id, no placements,
		// the relaxed + rotation setup retained, and the restart tray order.
		const persisted = await gameplayPage.readPersistedSession();
		expect(persisted).not.toBeNull();
		expect(persisted!.runId).toBe(fixture.runIds[0]);
		expect(persisted!.runId).not.toBe(seeded.runId);
		expect(persisted!.placedPieces).toEqual([]);
		expect(persisted!.mode).toBe('relaxed');
		expect(persisted!.rotationEnabled).toBe(true);
		expect(persisted!.trayOrder).toEqual(fixture.restartTrayOrders[0]);
	});

	test('webkit-mobile: setup dialog and Pause action reachable, focus wraps @webkit-critical', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture();
		const setup = gameplayPage.missionSetupDialog();
		await expect(setup).toBeVisible();

		// Focus lands on the first control; Shift+Tab wraps to the last
		// focusable (Start Mission) instead of escaping the dialog.
		await expect(setup.getByLabel('Timed')).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(setup.getByRole('button', { name: 'Start Mission' })).toBeFocused();

		// A short (dynamic-height) viewport must keep the dialog usable.
		await page.setViewportSize({ width: 390, height: 480 });
		await expect(setup).toBeVisible();
		await gameplayPage.startMission();

		// The toolbar Pause action stays reachable and opens the pause dialog.
		const pause = page.getByRole('button', { name: 'Pause mission' });
		await expect(pause).toBeVisible();
		await pause.click();
		const paused = page.getByRole('dialog', { name: 'Mission Paused' });
		await expect(paused).toBeVisible();
		await paused.getByRole('button', { name: 'Resume' }).click();
		await expect(paused).not.toBeVisible();
	});
});
