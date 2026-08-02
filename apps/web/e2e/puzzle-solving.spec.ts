// E2E test for puzzle solving.
//
// The deterministic load/placement/completion coverage that previously lived
// here as bare skips is now implemented in gameplay-infrastructure.spec.ts
// (HPA-226): fixture-gated board load, keyboard/drag placement, snap-to-cell,
// and the full completion celebration flow all run against the e2e-square-4
// fixture through the canonical GameplayPage harness.
import { test, expect } from '@playwright/test';

test.describe('Puzzle Solving Page', () => {
	test('should show 404 page for non-existent puzzle', async ({ page }) => {
		await page.goto('/puzzle/non-existent-id');

		// Should show a not-found style message
		const errorMessage = page.getByText(
			/not found|no longer available|failed to load puzzle|puzzle not found/i
		);
		await expect(errorMessage).toBeVisible();
	});

	test('should have back navigation link', async ({ page }) => {
		await page.goto('/puzzle/any-puzzle');

		// Should have navigation back to main page
		const backLink = page.locator('header').getByTestId('back-to-arcade-link');
		await expect(backLink).toBeVisible();
	});
});
