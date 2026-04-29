import { test, expect, type Page } from '@playwright/test';

const pagedResponse = (puzzles: Array<{ id: string; name: string; pieceCount: number }>) => ({
	puzzles,
	total: puzzles.length,
	offset: 0,
	limit: 20
});

const samplePuzzleSummary = { id: 'puzzle-1', name: 'Test Puzzle', pieceCount: 1 };

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
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' },
			imagePath: 'placeholder'
		}
	]
};

async function mockPuzzleList(
	page: Page,
	puzzles: Array<{ id: string; name: string; pieceCount: number }>
) {
	await page.route('**/api/puzzles**', (route) => route.fulfill({ json: pagedResponse(puzzles) }));
}

async function mockPuzzleDetail(page: Page, puzzle: typeof samplePuzzle) {
	await page.route(`**/api/puzzles/${puzzle.id}`, (route) => route.fulfill({ json: puzzle }));
}

test.describe('Main Gallery Page', () => {
	test('should display the gallery page', async ({ page }) => {
		await mockPuzzleList(page, []);
		await page.goto('/');
		await expect(page).toHaveTitle(/Perseus|Jigsaw/i);
	});

	test('should show empty state when no puzzles exist', async ({ page }) => {
		await mockPuzzleList(page, []);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		await expect(page.getByTestId('error-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeHidden();
		await expect(page.getByTestId('empty-state')).toBeVisible();
	});

	test('should display puzzle cards when puzzles exist', async ({ page }) => {
		await mockPuzzleList(page, [samplePuzzleSummary]);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		await expect(page.getByTestId('error-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeVisible();
		await expect(page.getByTestId('empty-state')).toBeHidden();
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

	test('should show no-results state when search returns empty', async ({ page }) => {
		// First load with puzzles, then search returns empty
		await page.route('**/api/puzzles**', async (route) => {
			const url = route.request().url();
			if (url.includes('q=')) {
				await route.fulfill({ json: pagedResponse([]) });
			} else {
				await route.fulfill({ json: pagedResponse([samplePuzzleSummary]) });
			}
		});

		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const searchInput = page.getByTestId('search-input');
		await searchInput.fill('xyznotfound');

		await expect(page.getByTestId('no-results-state')).toBeVisible({ timeout: 1000 });
	});

	test('should append more puzzles when scrolling to sentinel', async ({ page }) => {
		const firstPage = Array.from({ length: 20 }, (_, i) => ({
			id: `p${i}`,
			name: `Puzzle ${i}`,
			pieceCount: 225
		}));
		const secondPage = [{ id: 'p20', name: 'Puzzle 20', pieceCount: 225 }];

		let callCount = 0;
		await page.route('**/api/puzzles**', async (route) => {
			callCount++;
			const url = route.request().url();
			if (url.includes('offset=20')) {
				await route.fulfill({
					json: { puzzles: secondPage, total: 21, offset: 20, limit: 20 }
				});
			} else {
				await route.fulfill({
					json: { puzzles: firstPage, total: 21, offset: 0, limit: 20 }
				});
			}
		});

		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeVisible();

		// Scroll sentinel into view
		await page.getByTestId('scroll-sentinel').scrollIntoViewIfNeeded();

		// Second page should be appended
		await expect(page.getByTestId('puzzle-card')).toHaveCount(21, { timeout: 2000 });
	});
});
