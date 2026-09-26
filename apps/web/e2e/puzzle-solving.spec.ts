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
		// Puzzle routes validate UUIDv4 ids before looking up metadata. Use a
		// valid UUID that is absent from the E2E database so the API returns 404.
		await page.goto('/puzzle/00000000-0000-4000-8000-000000000000');

		// Should show a not-found style message
		const errorMessage = page.getByText(
			/not found|no longer available|failed to load puzzle|puzzle not found/i
		);
		await expect(errorMessage).toBeVisible();
	});

	// The former "should have back navigation link" spec navigated to
	// `/puzzle/any-puzzle`, which the route UUID-validates to the 404 error
	// panel before any header renders, so it could never pass. HUD back-link
	// visibility is covered by the fixture-load smoke test in
	// gameplay-infrastructure.spec.ts; its exit interaction by
	// gameplay-session-controls.spec.ts.
});
