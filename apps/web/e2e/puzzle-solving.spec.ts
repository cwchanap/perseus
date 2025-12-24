// E2E test for puzzle solving
import { test, expect } from '@playwright/test';

test.describe('Puzzle Solving Page', () => {
	test('should show 404 page for non-existent puzzle', async ({ page }) => {
		await page.goto('/puzzle/non-existent-id');

		// Should show a not-found style message
		const errorMessage = page.getByText(/not found|no longer available/i);
		await expect(errorMessage).toBeVisible();
	});

	test.skip('should display puzzle board when puzzle exists', async ({ page }) => {
		// Requires deterministic seeding/mocking of a known puzzle id
		await page.goto('/puzzle/test-puzzle');

		// Puzzle board must be visible for an existing puzzle
		const puzzleBoard = page.locator('[data-testid="puzzle-board"]');
		await expect(puzzleBoard).toBeVisible();
	});

	test('should have back to gallery link', async ({ page }) => {
		await page.goto('/puzzle/any-puzzle');

		// Should have navigation back to main page
		const backLink = page.getByRole('link', { name: /back|home|gallery/i });
		await expect(backLink).toBeVisible();
	});
});

test.describe('Puzzle Interaction', () => {
	test.skip('should allow dragging puzzle pieces', async ({ page: _page }) => {
		// This test requires a seeded puzzle with known ID
		// Skip until puzzle creation is implemented
	});

	test.skip('should snap piece to correct position', async ({ page: _page }) => {
		// This test requires drag-drop interaction testing
		// Skip until puzzle creation is implemented
	});

	test.skip('should show completion celebration', async ({ page: _page }) => {
		// This test requires completing a puzzle
		// Skip until full flow is testable
	});
});
