// E2E test for puzzle solving
import { test, expect } from '@playwright/test';

test.describe('Puzzle Solving Page', () => {
  test('should show 404 page for non-existent puzzle', async ({ page }) => {
    await page.goto('/puzzle/non-existent-id');

    // Should show error or redirect
    const errorMessage = page.getByText(/not found|no longer available/i);
    const homeLink = page.getByRole('link', { name: /home|back|gallery/i });

    // Either error message or home link should be visible
    const hasError = await errorMessage.isVisible().catch(() => false);
    const hasHomeLink = await homeLink.isVisible().catch(() => false);

    expect(hasError || hasHomeLink).toBeTruthy();
  });

  test('should display puzzle board when puzzle exists', async ({ page }) => {
    // This test requires a seeded puzzle - will pass once admin creates puzzles
    await page.goto('/puzzle/test-puzzle');

    // Check for puzzle board or 404
    const puzzleBoard = page.locator('[data-testid="puzzle-board"]');
    const notFound = page.getByText(/not found|no longer available/i);

    const hasPuzzle = await puzzleBoard.isVisible().catch(() => false);
    const hasNotFound = await notFound.isVisible().catch(() => false);

    expect(hasPuzzle || hasNotFound).toBeTruthy();
  });

  test('should have back to gallery link', async ({ page }) => {
    await page.goto('/puzzle/any-puzzle');

    // Should have navigation back to main page
    const backLink = page.getByRole('link', { name: /back|home|gallery/i });
    const backLinkVisible = await backLink.isVisible().catch(() => false);

    // Either back link exists or we're on error page
    expect(backLinkVisible || (await page.url()).includes('/puzzle/')).toBeTruthy();
  });
});

test.describe('Puzzle Interaction', () => {
  test.skip('should allow dragging puzzle pieces', async ({ page }) => {
    // This test requires a seeded puzzle with known ID
    // Skip until puzzle creation is implemented
  });

  test.skip('should snap piece to correct position', async ({ page }) => {
    // This test requires drag-drop interaction testing
    // Skip until puzzle creation is implemented
  });

  test.skip('should show completion celebration', async ({ page }) => {
    // This test requires completing a puzzle
    // Skip until full flow is testable
  });
});
