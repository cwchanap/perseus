// Lifecycle-order tests for the canonical gameplay E2E fixture.
//
// These tests prove gotoFixture() executes the required lifecycle in order and
// observably: fixture lookup -> route registration -> cookie reset -> optional
// clock install -> ONE atomic init script -> navigation -> ready state. Each
// test asserts an observable consequence of one (or more) lifecycle stages
// rather than a call sequence, so the tests stay robust to refactor.
//
// Run: bun run --cwd apps/web test:e2e -- e2e/support/test-fixture.spec.ts \
//      --project=chromium-desktop --retries=0
import { buildGameplayConfig, getFixture } from '../gameplay-fixtures/catalog';
import { FIXTURE_ROUTER_SOURCE } from '../gameplay-fixtures/fixture-router';
import { buildMinimalSeed, progressKey } from '../gameplay-fixtures/persisted-state';
import { test, expect } from './test';

const FIXTURE_ID = 'e2e-square-4' as const;
const STATS_KEY = `puzzle-stats-${FIXTURE_ID}`;

/** Read the piece-slot ids in DOM order (the deterministic tray order). */
async function trayOrder(page: import('@playwright/test').Page): Promise<number[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll('[data-testid^="piece-slot-"]')).map((el) =>
			Number((el as HTMLElement).getAttribute('data-testid')!.replace('piece-slot-', ''))
		)
	);
}

// --- Stages 1, 6, 7: fixture lookup -> navigation -> ready state ---------------

test.describe('gotoFixture lifecycle', () => {
	test('loads the default fixture and reaches a ready puzzle board (lookup, navigation, ready)', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture();

		// Stage 6: navigation landed on the fixture's puzzle route.
		await expect(gameplayPage.page).toHaveURL(new RegExp(`/puzzle/${FIXTURE_ID}$`));

		// Stage 7: ready state — board visible, expected piece-slot count, no fixed delay.
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();
		await expect(gameplayPage.page.locator('[data-testid^="piece-slot-"]')).toHaveCount(
			getFixture(FIXTURE_ID).pieceCount
		);
	});

	// --- Stage 2: route registration --------------------------------------------

	test('registers the fixture router so metadata is served from the harness, not the backend', async ({
		gameplayPage
	}) => {
		const metadataMarkers: string[] = [];
		gameplayPage.page.on('response', (response) => {
			const url = response.url();
			// The metadata GET (not a piece image, not completion).
			if (
				url.endsWith(`/api/puzzles/${FIXTURE_ID}`) &&
				!url.includes('/pieces/') &&
				!url.includes('/complete')
			) {
				metadataMarkers.push(response.headers()['x-perseus-e2e-source'] ?? '');
			}
		});

		await gameplayPage.gotoFixture();

		// The real backend has no e2e-square-4; only the router could answer.
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();
		expect(metadataMarkers).toContain(FIXTURE_ROUTER_SOURCE);
	});

	// --- Stages 3 + 5: cookie reset + atomic init script (clear) ----------------

	test('clears stale cookies and stale localStorage via the atomic init script', async ({
		gameplayPage
	}) => {
		const context = gameplayPage.page.context();
		// Plant stale state on the web origin BEFORE gotoFixture.
		await gameplayPage.page.goto('/');
		await gameplayPage.page.evaluate(() => localStorage.setItem('stale-should-vanish', '1'));
		await context.addCookies([
			{ name: 'stale-cookie', value: '1', domain: 'localhost', path: '/' }
		]);
		expect(
			await gameplayPage.page.evaluate(() => localStorage.getItem('stale-should-vanish'))
		).toBe('1');

		await gameplayPage.gotoFixture();
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();

		// Stage 3: cookie reset.
		expect((await context.cookies()).some((c) => c.name === 'stale-cookie')).toBe(false);
		// Stage 5: the init script cleared localStorage.
		expect(
			await gameplayPage.page.evaluate(() => localStorage.getItem('stale-should-vanish'))
		).toBeNull();
	});

	// --- Stage 5: atomic init script (seed session + stats + freeze config) -----

	test('seeds a provided session snapshot and stats, and freezes the config global, in one init script', async ({
		gameplayPage
	}) => {
		const snapshot = buildMinimalSeed(FIXTURE_ID);
		const stats = {
			schemaVersion: 1 as const,
			puzzleId: FIXTURE_ID,
			standardBestTime: 42,
			standardBestCompletedAt: 1710000000000,
			totalCompletions: 1,
			lastCompletedAt: 1710000000000,
			lastRecordedRunId: null,
			recordedRunIds: []
		};

		await gameplayPage.gotoFixture({ seedSession: snapshot, seedStats: stats });
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();

		const seeded = await gameplayPage.page.evaluate(
			(key) => localStorage.getItem(key),
			progressKey(FIXTURE_ID)
		);
		expect(seeded).toBe(JSON.stringify(snapshot));

		const seededStats = await gameplayPage.page.evaluate(
			(key) => localStorage.getItem(key),
			STATS_KEY
		);
		expect(seededStats).toBe(JSON.stringify(stats));
	});

	test('the atomic init script defines a deeply-frozen config matching the fixture', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture();
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();

		const observed = await gameplayPage.page.evaluate(() => {
			const cfg = (window as unknown as { __PERSEUS_E2E_GAMEPLAY_V1__: unknown })
				.__PERSEUS_E2E_GAMEPLAY_V1__ as Record<string, unknown> | undefined;
			if (!cfg) return null;
			return {
				topFrozen: Object.isFrozen(cfg),
				runIdsFrozen: Object.isFrozen(cfg.runIds),
				rotationsFrozen: Object.isFrozen(cfg.rotations),
				restartFrozen: Object.isFrozen(cfg.restartTrayOrders),
				value: cfg
			};
		});

		expect(observed).not.toBeNull();
		expect(observed!.topFrozen).toBe(true);
		expect(observed!.runIdsFrozen).toBe(true);
		expect(observed!.rotationsFrozen).toBe(true);
		expect(observed!.restartFrozen).toBe(true);
		// Deep value match (JSON-normalized) against the fixture's projection.
		expect(observed!.value).toEqual(
			JSON.parse(JSON.stringify(buildGameplayConfig(getFixture(FIXTURE_ID))))
		);
	});

	test('the init script runs before app scripts: the rendered tray order matches config.initialTrayOrder', async ({
		gameplayPage
	}) => {
		await gameplayPage.gotoFixture();
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();

		const expected = [...getFixture(FIXTURE_ID).initialTrayOrder];
		expect(await trayOrder(gameplayPage.page)).toEqual(expected);
	});

	// --- Stage 4: optional clock install (before navigation) --------------------

	test('installs the clock before navigation when requested', async ({ gameplayPage }) => {
		const startAt = new Date('2026-01-01T00:00:00Z');
		await gameplayPage.gotoFixture({ clock: { startAt } });
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();

		const now = await gameplayPage.page.evaluate(() => Date.now());
		// gotoFixture pauses the installed clock at startAt before navigation, so
		// Date.now() is frozen at startAt (not advancing in real time). Real "now"
		// is months away, so a 60s window unambiguously proves the clock won.
		expect(Math.abs(now - startAt.getTime())).toBeLessThan(60_000);
	});

	test('does not install the clock when clock:false', async ({ gameplayPage }) => {
		await gameplayPage.gotoFixture({ clock: false });
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();

		const now = await gameplayPage.page.evaluate(() => Date.now());
		// Within a minute of the real wall clock (not pinned to any fixture time).
		expect(Math.abs(now - Date.now())).toBeLessThan(5_000);
	});

	// --- Teardown: assertSettled + assertNoUnexpectedFixtureRequests ------------

	test('teardown is clean after a load with no completion activity', async ({ gameplayPage }) => {
		await gameplayPage.gotoFixture();
		await expect(gameplayPage.page.getByTestId('puzzle-board')).toBeVisible();
		// Explicit invocation mirrors the fixture's automatic teardown.
		expect(() => gameplayPage.assertSettled()).not.toThrow();
		expect(() => gameplayPage.assertNoUnexpectedFixtureRequests()).not.toThrow();
	});
});
