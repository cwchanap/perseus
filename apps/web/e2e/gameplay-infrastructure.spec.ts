// Deterministic gameplay smoke coverage (HPA-226 Task 9).
//
// Exercises the full completion lifecycle against the e2e-square-4 fixture
// (2x2 grid, 4 pieces) via the canonical GameplayPage harness: fixture load +
// placement, authenticated/anonymous completion, deferred retry, timer
// integration, and persistence seed/reset. Supersedes the bare skips in
// puzzle-solving.spec.ts, which now point here.
//
// Determinism: every completion test passes `clock: { startAt }` to
// gotoFixture, which installs AND pauses Playwright's clock before navigation
// (see gameplay-page.ts). performance.now() stays at zero until a test calls
// page.clock.runFor(), so the monotonic clock driving elapsedActiveSeconds
// never accrues real wall-clock time. The timer test advances it explicitly.
// The sealed run id and result class come from the frozen fixture config, so
// the recorded server payload is byte-stable across runs.
//
// Tags: @smoke — runs in the smoke gate (chromium-desktop + chromium-mobile).
import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import type { GameplayPage } from './support/gameplay-page';
import { getFixture } from './gameplay-fixtures/catalog';
import { buildMinimalSeed, progressKey } from './gameplay-fixtures/persisted-state';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const FIXTURE_ID = 'e2e-square-4' as const;
const START_AT = new Date('2026-01-01T00:00:00Z');
const STATS_KEY = `puzzle-stats-${FIXTURE_ID}`;
const COMPLETION_URL = /\/api\/puzzles\/e2e-square-4\/complete(?:\?.*)?$/;

/**
 * Device preferences that auto-start fresh sessions. HPA-221 made Mission
 * Setup mandatory on fresh route entry, so tests that interact with the board
 * immediately seed `startImmediately` to skip the dialog.
 */
const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };

/** Piece id -> placement coordinates (correctX, correctY) for the 2x2 grid. */
const COORDS: Record<number, { x: number; y: number }> = {
	0: { x: 0, y: 0 },
	1: { x: 1, y: 0 },
	2: { x: 0, y: 1 },
	3: { x: 1, y: 1 }
};

/** The deterministic run id a fresh solve seals with (fixture runIds[0]). */
function firstRunId(): string {
	return getFixture(FIXTURE_ID).runIds[0]!;
}

/** Place the given pieces via keyboard in id order. */
async function placePieces(gameplayPage: GameplayPage, ids: number[]): Promise<void> {
	for (const id of ids) {
		const { x, y } = COORDS[id]!;
		await gameplayPage.selectAndPlaceWithKeyboard(id, x, y);
	}
}

/** Poll localStorage stats until totalCompletions reaches `expected`. */
async function expectStatsCompletions(page: Page, expected: number): Promise<void> {
	await expect
		.poll(async () => {
			const raw = await page.evaluate((k) => localStorage.getItem(k), STATS_KEY);
			if (!raw) return 0;
			try {
				return (JSON.parse(raw).totalCompletions as number) ?? 0;
			} catch {
				return 0;
			}
		})
		.toBe(expected);
}

test.describe('gameplay smoke @smoke', () => {
	// --- Step 1: fixture load + placement ----------------------------------------

	test('fixture load renders the board and four tray pieces @smoke', async ({ gameplayPage }) => {
		await gameplayPage.gotoFixture();

		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();
		await expect(gameplayPage.page.locator('[data-testid^="piece-slot-"]')).toHaveCount(4);
	});

	test('keyboard placement places a piece on the board @smoke', async ({ gameplayPage }) => {
		await gameplayPage.gotoFixture({ seedPreferences: IMMEDIATE_START });

		await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
		await gameplayPage.expectPiecePlaced(0, 0, 0);
	});

	// --- Step 2: authenticated completion ---------------------------------------

	test('authenticated completion: celebration, local stats, one sealed request @smoke', async ({
		gameplayPage,
		page
	}) => {
		const runId = firstRunId();
		await gameplayPage.gotoFixture({
			persona: 'authenticated',
			clock: { startAt: START_AT },
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START
		});

		// One rejected attempt first: piece 0 belongs at (0,0); placing it at
		// (1,0) is a wrong_slot rejection. The piece stays in the tray and the
		// board gains nothing (all four slots still present).
		await gameplayPage.selectAndPlaceWithKeyboard(0, 1, 0);
		await expect(page.getByTestId('piece-slot-0')).toBeVisible();
		await expect(page.locator('[data-testid^="piece-slot-"]')).toHaveCount(4);

		// The engine RETAINS the selection after a rejection (so the user can
		// try another cell), so place piece 0 by activating its correct
		// drop-zone directly — re-selecting would toggle the piece off.
		const home = gameplayPage.dropZone(0, 0);
		await home.focus();
		await home.press('Enter');
		await gameplayPage.expectPiecePlaced(0, 0, 0);

		// Solve the remaining pieces through the UI.
		await placePieces(gameplayPage, [1, 2, 3]);

		// completion_sealed opens the celebration modal.
		await expect(page.getByTestId('celebration-modal')).toBeVisible();

		// Local stats recorded (Web Lock write resolves under a paused clock).
		await expectStatsCompletions(page, 1);

		// Exactly one server completion request, carrying the deterministic seal.
		await expect.poll(() => gameplayPage.apiController.recordedRequests.length).toBe(1);
		const body = gameplayPage.apiController.recordedRequests[0]!.bodyJson as Record<
			string,
			unknown
		>;
		expect(body).toEqual({
			version: 1,
			runId,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 1
		});

		// The local stats record pins the same run id (idempotency guard).
		const stats = await page.evaluate((k) => localStorage.getItem(k), STATS_KEY);
		expect(JSON.parse(stats!).lastRecordedRunId).toBe(runId);
	});

	// --- Step 3: anonymous completion -------------------------------------------

	test('anonymous completion: celebration, local stats, one 401 request @smoke', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({
			persona: 'anonymous',
			clock: { startAt: START_AT },
			completion: { kind: 'http-failure', status: 401 },
			seedPreferences: IMMEDIATE_START
		});
		// Chromium also logs a browser-level "Failed to load resource" for the
		// 401 response (distinct from the page's own console.error, which the
		// http-failure scenario already allowlists).
		gameplayPage.diagnostics.expectConsoleError('Failed to load resource');

		const statuses: number[] = [];
		page.on('response', (res) => {
			if (COMPLETION_URL.test(res.url())) statuses.push(res.status());
		});

		await placePieces(gameplayPage, [0, 1, 2, 3]);

		await expect(page.getByTestId('celebration-modal')).toBeVisible();
		await expectStatsCompletions(page, 1);

		// Exactly one server attempt, returning 401 (no auto-retry of an
		// unauthorized submission within a single page session).
		await expect.poll(() => gameplayPage.apiController.recordedRequests.length).toBe(1);
		await expect.poll(() => statuses.length).toBe(1);
		expect(statuses[0]).toBe(401);
	});

	// --- Step 4: deferred retry -------------------------------------------------
	//
	// The failure-then-success flow is driven by the controller-owned
	// `retry-sequence` scenario: the ApiScenarioController fulfills the first
	// POST with `failureStatus` (500) and every subsequent POST with 200,
	// recording every attempt. Diagnostics declares the scenario (not
	// network-abort), so only 500 and 200 are allowed on the completion path —
	// a controller regression that returns the wrong status (or a custom route
	// impersonating the controller) is flagged. The controller stamps the
	// api-scenario provenance marker itself; the test never stamps it manually.

	test('deferred retry: held failure then manual retry succeeds with the same seal @smoke', async ({
		gameplayPage,
		page
	}) => {
		const runId = firstRunId();
		await gameplayPage.gotoFixture({
			persona: 'authenticated',
			clock: { startAt: START_AT },
			completion: { kind: 'retry-sequence', failureStatus: 500 },
			seedPreferences: IMMEDIATE_START
		});
		// The driven 500 logs both the page's console.error (allowlisted via
		// the retry-sequence scenario) and Chromium's "Failed to load resource".
		gameplayPage.diagnostics.expectConsoleError('Failed to load resource');

		await placePieces(gameplayPage, [0, 1, 2, 3]);

		// The first submission failed with a retryable 500; the celebration
		// modal surfaces the manual retry affordance.
		await expect(page.getByTestId('celebration-modal')).toBeVisible();
		await expect(page.getByTestId('server-retry-banner')).toBeVisible();
		await expect.poll(() => gameplayPage.apiController.recordedRequests.length).toBe(1);

		// Manual retry re-submits the SAME sealed payload and succeeds.
		await page.getByTestId('retry-server-submission').click();
		await expect(page.getByTestId('server-retry-banner')).not.toBeVisible();
		await expect.poll(() => gameplayPage.apiController.recordedRequests.length).toBe(2);

		const bodies = gameplayPage.apiController.recordedRequests.map(
			(r) => r.bodyJson as Record<string, unknown>
		);
		expect(bodies[0]).toMatchObject({
			version: 1,
			runId,
			resultClass: 'standard_timed'
		});
		// The seal is immutable: the retry projects an identical request body.
		expect(bodies[1]).toEqual(bodies[0]);
	});

	// --- Step 5: timer integration ---------------------------------------------

	test('timer integration: five advanced seconds seal as elapsed=5 @smoke', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({
			clock: { startAt: START_AT },
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START
		});

		// The first counted action starts the timer (monotonicStart = 0).
		await gameplayPage.selectAndPlaceWithKeyboard(0, COORDS[0]!.x, COORDS[0]!.y);
		await gameplayPage.expectPiecePlaced(0, 0, 0);

		// Advance exactly five seconds; the 1s checkpoint ticks accrue 5s.
		await page.clock.runFor(5_000);

		// Timer UI reflects the elapsed seconds.
		await expect(page.getByTestId('game-timer')).toHaveAttribute('aria-label', 'Timer: 00:05');

		// Finish the run (clock paused -> no extra time accrues).
		await placePieces(gameplayPage, [1, 2, 3]);

		await expect(page.getByTestId('celebration-modal')).toBeVisible();
		await expect.poll(() => gameplayPage.apiController.recordedRequests.length).toBe(1);
		const body = gameplayPage.apiController.recordedRequests[0]!.bodyJson as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({
			runId: firstRunId(),
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 5
		});
	});

	// --- Step 6: persistence seed / reset ---------------------------------------

	test('persistence seed: a seeded placement is restored onto the board @smoke', async ({
		gameplayPage,
		page
	}) => {
		const seeded = buildMinimalSeed(FIXTURE_ID);
		seeded.placedPieces = [{ pieceId: 0, x: 0, y: 0 }];
		seeded.hasUserActivity = true;

		// A restored placement leaves the tray with three pieces, so the
		// ready-state wait must match the restored tray count (three), not the
		// fixture's full tray (four).
		await gameplayPage.gotoFixture({ seedSession: seeded, expectedTrayCount: 3 });
		await expect(page.getByTestId('puzzle-board')).toBeVisible();
		await gameplayPage.expectPiecePlaced(0, 0, 0);
		await expect(page.locator('[data-testid^="piece-slot-"]')).toHaveCount(3);
	});

	test('persistence reset: a fresh context starts with no canonical session key @smoke', async ({
		gameplayPage,
		page
	}) => {
		// Each test receives an isolated page, so this exercises a genuinely
		// fresh context with no seeded storage.
		await gameplayPage.gotoFixture({});
		await expect(page.getByTestId('puzzle-board')).toBeVisible();

		// A fresh in-memory session is not checkpointed until the first counted
		// action, so the canonical progress key is absent right after load.
		const stored = await page.evaluate((k) => localStorage.getItem(k), progressKey(FIXTURE_ID));
		expect(stored).toBeNull();
	});

	test('restored completed session: Play Again restarts without a run-id collision @smoke', async ({
		gameplayPage,
		page
	}) => {
		// Build a completed session seed using the fixture's seedRunId (which
		// is NOT in runIds). Before the seedRunId fix, buildMinimalSeed used
		// runIds[0], so Play Again's first runIdFactory.create() returned the
		// same id and the session engine threw a collision error.
		const fixture = getFixture(FIXTURE_ID);
		const seeded = buildMinimalSeed(FIXTURE_ID);
		seeded.lifecycle = 'completed';
		seeded.placedPieces = [
			{ pieceId: 0, x: 0, y: 0 },
			{ pieceId: 1, x: 1, y: 0 },
			{ pieceId: 2, x: 0, y: 1 },
			{ pieceId: 3, x: 1, y: 1 }
		];
		seeded.timerStarted = true;
		seeded.elapsedActiveSeconds = 5;
		seeded.hasUserActivity = true;
		seeded.sealedCompletion = {
			runId: fixture.seedRunId,
			resultClass: 'standard_timed',
			elapsedActiveSeconds: 5,
			completedAt: 1710000005000,
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'succeeded' },
			hintsUsed: 0,
			incorrectAttempts: 0,
			rotationEnabled: false,
			rotationUsed: false
		};

		await gameplayPage.gotoFixture({
			seedSession: seeded,
			expectedTrayCount: 0,
			completion: { kind: 'success' }
		});

		// A restored completed session opens the celebration modal.
		const dialog = await gameplayPage.waitForDialog(/E2E SQUARE 4/i);

		// Play Again restarts the session. The first runIdFactory.create()
		// returns runIds[0] — distinct from seedRunId — so no collision.
		await gameplayPage.activateDialogAction(dialog, 'PLAY AGAIN');
		await expect(page.getByTestId('celebration-modal')).not.toBeVisible();

		// The board reset: a full tray of 4 pieces is visible again.
		await expect(page.locator('[data-testid^="piece-slot-"]')).toHaveCount(4);
	});
});

// --- Auth personas through the canonical GameplayPage fixture -----------------
//
// The service-level AuthPersona tests (harness-services.spec.ts) prove each
// persona answers /api/auth/session with the right contract, but they bypass
// GameplayPage diagnostics. These integration tests exercise the personas
// through gotoFixture so the automatic teardown proves the expected auth
// outcome (a driven 500, a cancelled deferred request, a released deferred
// request) is not mistaken for a regression: diagnostics requires the
// auth-persona provenance marker, narrowly allows the configured failure
// status / abort, and allowlists the page's auth-failure console errors.
test.describe('auth personas through gameplayPage @smoke', () => {
	test('failed-session persona: page falls back to anonymous and teardown stays clean @smoke', async ({
		gameplayPage,
		page
	}) => {
		// The auth GET returns 500; playerAuth.refresh() catches it and falls
		// back to anonymous, so the board still renders and is interactive.
		await gameplayPage.gotoFixture({
			persona: 'failed-session',
			seedPreferences: IMMEDIATE_START
		});

		await expect(page.getByTestId('puzzle-board')).toBeVisible();
		await gameplayPage.selectAndPlaceWithKeyboard(0, 0, 0);
		await gameplayPage.expectPiecePlaced(0, 0, 0);
	});

	test('deferred-session persona cancel(): aborts the held auth request and teardown stays clean @smoke', async ({
		gameplayPage,
		page
	}) => {
		// The deferred persona holds the auth GET pending; the board renders
		// independently of auth (the layout renders children unconditionally).
		await gameplayPage.gotoFixture({ persona: 'deferred-session' });
		await expect(page.getByTestId('puzzle-board')).toBeVisible();

		expect(gameplayPage.authHandle).not.toBeNull();
		// The layout's onMount fires playerAuth.refresh() -> the held GET.
		await expect.poll(() => gameplayPage.authHandle!.pendingCount).toBe(1);

		// Cancel aborts the held request; refresh() catches the abort and falls
		// back to anonymous. Diagnostics tolerates the abort (deferred-session)
		// and the auth-failure console errors are allowlisted.
		await gameplayPage.authHandle!.cancel();
		expect(gameplayPage.authHandle!.cancelled).toBe(true);
		expect(gameplayPage.authHandle!.pendingCount).toBe(0);
	});

	test('deferred-session persona release(): resolves auth and teardown stays clean @smoke', async ({
		gameplayPage,
		page
	}) => {
		await gameplayPage.gotoFixture({ persona: 'deferred-session' });
		await expect(page.getByTestId('puzzle-board')).toBeVisible();

		expect(gameplayPage.authHandle).not.toBeNull();
		await expect.poll(() => gameplayPage.authHandle!.pendingCount).toBe(1);

		// Release resolves the held request with the anonymous session (200,
		// stamped with the auth-persona provenance marker). No console error.
		await gameplayPage.authHandle!.release({ authenticated: false });
		expect(gameplayPage.authHandle!.released).toBe(true);
		expect(gameplayPage.authHandle!.pendingCount).toBe(0);
	});
});
