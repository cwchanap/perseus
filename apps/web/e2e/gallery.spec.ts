// E2E test for main page gallery
import { test, expect, type Page } from '@playwright/test';

const samplePuzzleSummary = {
	id: 'puzzle-1',
	name: 'Test Puzzle',
	pieceCount: 1
};

const samplePuzzle = {
	id: 'puzzle-1',
	name: 'Test Puzzle',
	pieceCount: 1,
	gridCols: 1,
	gridRows: 1,
	imageWidth: 100,
	imageHeight: 100,
	createdAt: 0,
	pieces: [
		{
			id: 1,
			puzzleId: 'puzzle-1',
			correctX: 0,
			correctY: 0,
			edges: {
				top: 'flat',
				right: 'flat',
				bottom: 'flat',
				left: 'flat'
			},
			imagePath: 'placeholder'
		}
	]
};

async function mockPuzzleList(
	page: Page,
	puzzles: Array<{ id: string; name: string; pieceCount: number }>
) {
	await page.route('**/api/puzzles', (route) => route.fulfill({ json: { puzzles } }));
}

async function mockPuzzleDetail(page: Page, puzzle: typeof samplePuzzle) {
	await page.route(`**/api/puzzles/${puzzle.id}`, (route) => route.fulfill({ json: puzzle }));
}

test.describe('Main Gallery Page', () => {
	test('should display the gallery page', async ({ page }) => {
		await mockPuzzleList(page, []);
		await page.goto('/');

		// Page should load successfully
		await expect(page).toHaveTitle(/Perseus|Jigsaw/i);
	});

	test('should show empty state when no puzzles exist', async ({ page }) => {
		await mockPuzzleList(page, []);
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
		await mockPuzzleList(page, [samplePuzzleSummary]);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const puzzleGrid = page.getByTestId('puzzle-grid');
		const emptyState = page.getByTestId('empty-state');
		const errorState = page.getByTestId('error-state');

		await expect(errorState).toBeHidden();
		await expect(puzzleGrid).toBeVisible();
		await expect(emptyState).toBeHidden();
		await expect(page.getByTestId('puzzle-card')).toHaveCount(1);
	});

	test('should navigate to puzzle page when clicking a card', async ({ page }) => {
		await mockPuzzleList(page, [samplePuzzleSummary]);
		await mockPuzzleDetail(page, samplePuzzle);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const puzzleCard = page.locator('[data-testid="puzzle-card"]').first();
		await expect(puzzleCard).toBeVisible();
		await puzzleCard.click();
		await expect(page).toHaveURL(/\/puzzle\/puzzle-1/);
	});
});
