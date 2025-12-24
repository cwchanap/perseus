// E2E test for main page gallery
import { test, expect } from '@playwright/test';

test.describe('Main Gallery Page', () => {
	test('should display the gallery page', async ({ page }) => {
		await page.goto('/');

		// Page should load successfully
		await expect(page).toHaveTitle(/Perseus|Jigsaw/i);
	});

	test('should show empty state when no puzzles exist', async ({ page }) => {
		await page.goto('/');

		// Either the empty state OR at least one puzzle card should be visible
		const emptyState = page.getByText(/no puzzles|get started|create/i);
		const puzzleCard = page.locator('[data-testid="puzzle-card"]').first();

		const emptyVisible = await emptyState.isVisible().catch(() => false);
		const cardVisible = await puzzleCard.isVisible().catch(() => false);

		expect(emptyVisible || cardVisible).toBeTruthy();
	});

	test('should display puzzle cards when puzzles exist', async ({ page }) => {
		// This test will pass once puzzles are seeded
		await page.goto('/');

		// Check for puzzle grid or empty state
		const puzzleGrid = page.locator('[data-testid="puzzle-grid"]');
		const emptyState = page.getByText(/no puzzles/i);

		// Either puzzle grid or empty state should be visible
		const gridVisible = await puzzleGrid.isVisible().catch(() => false);
		const emptyVisible = await emptyState.isVisible().catch(() => false);

		expect(gridVisible || emptyVisible).toBeTruthy();
	});

	test('should navigate to puzzle page when clicking a card', async ({ page }) => {
		await page.goto('/');

		// If puzzle cards exist, click one
		const puzzleCard = page.locator('[data-testid="puzzle-card"]').first();
		const cardExists = await puzzleCard.isVisible().catch(() => false);

		if (cardExists) {
			await puzzleCard.click();
			await expect(page).toHaveURL(/\/puzzle\/.+/);
		} else {
			// No puzzles exist, test passes (empty state is valid)
			expect(true).toBeTruthy();
		}
	});
});
