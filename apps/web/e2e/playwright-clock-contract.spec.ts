// Exemption: this spec intentionally imports from '@playwright/test' rather
// than e2e/support/test — it is a runtime-contract check for the Playwright
// clock API and the initializePausedClock harness helper, not a gameplay test,
// so the gameplayPage fixture and its teardown post-conditions do not apply.
import { expect, test } from '@playwright/test';
import { initializePausedClock } from './support/paused-clock';

test('@smoke installed clock advances performance.now exactly', async ({ page }) => {
	// The virtual lead keeps the pause target ahead even if navigation stalls.
	await page.clock.install({ time: new Date('2025-12-31T23:00:00Z') });
	await page.goto('/');
	await page.clock.pauseAt(new Date('2026-01-01T00:00:05Z'));
	const before = await page.evaluate(() => performance.now());
	await page.clock.runFor(2_000);
	const after = await page.evaluate(() => performance.now());
	expect(after - before).toBe(2_000);
});

test('@smoke paused clock initialization keeps Date.now at startAt despite install delay', async ({
	page
}) => {
	const startAt = new Date('2026-01-01T00:00:00Z');
	await initializePausedClock(
		{
			install: async (options) => {
				await page.clock.install(options);
				await new Promise<void>((resolve) => setTimeout(resolve, 150));
			},
			pauseAt: (time) => page.clock.pauseAt(time)
		},
		startAt
	);
	await page.goto('/');
	expect(await page.evaluate(() => Date.now())).toBe(startAt.getTime());
});
