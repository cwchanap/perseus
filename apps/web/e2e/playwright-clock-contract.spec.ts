// Exemption: this spec intentionally imports from '@playwright/test' rather
// than e2e/support/test — it is a runtime-contract check for the Playwright
// clock API itself, not a gameplay test, so the gameplayPage fixture and its
// teardown post-conditions do not apply.
import { expect, test } from '@playwright/test';

test('@smoke installed clock advances performance.now exactly', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
	await page.goto('/');
	await page.clock.pauseAt(new Date('2026-01-01T00:00:05Z'));
	const before = await page.evaluate(() => performance.now());
	await page.clock.runFor(2_000);
	const after = await page.evaluate(() => performance.now());
	expect(after - before).toBe(2_000);
});
