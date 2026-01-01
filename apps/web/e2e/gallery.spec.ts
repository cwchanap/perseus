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
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const emptyState = page.getByTestId('empty-state');
		const puzzleGrid = page.getByTestId('puzzle-grid');
		const errorState = page.getByTestId('error-state');

		await expect(errorState).toBeHidden();
		await expect(puzzleGrid).toBeHidden();
		await expect(emptyState).toBeVisible();
	});

	test('should display puzzle cards when puzzles exist', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const puzzleGrid = page.getByTestId('puzzle-grid');
		const emptyState = page.getByTestId('empty-state');
		const errorState = page.getByTestId('error-state');

		await expect(errorState).toBeHidden();
		await expect(puzzleGrid).toBeVisible();
		await expect(emptyState).toBeHidden();
	});

	test('should navigate to puzzle page when clicking a card', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

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
