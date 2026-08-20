import { test, expect, type Page } from '@playwright/test';
import type { PuzzleSummary } from '@perseus/types';
import { getFixture } from './gameplay-fixtures/catalog';
import { createFixtureRouter } from './gameplay-fixtures/fixture-router';
import {
	buildMinimalSeed,
	createPersistedStateController
} from './gameplay-fixtures/persisted-state';

const pagedResponse = (puzzles: PuzzleSummary[]) => ({
	puzzles,
	total: puzzles.length,
	offset: 0,
	limit: 20
});

const samplePuzzleSummary: PuzzleSummary = {
	id: 'puzzle-1',
	name: 'Test Puzzle',
	pieceCount: 1,
	status: 'ready'
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
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' },
			imagePath: 'placeholder'
		}
	]
};

async function mockPuzzleList(page: Page, puzzles: PuzzleSummary[]) {
	await page.route(/\/api\/puzzles(?:\?.*)?$/, (route) =>
		route.fulfill({ json: pagedResponse(puzzles) })
	);
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

	test('shows current-device progress and continues the newest session', async ({ page }) => {
		const fixtureId = 'e2e-square-4';
		const fixture = getFixture(fixtureId);
		const firstPiece = fixture.pieces[0];
		const seed = {
			...buildMinimalSeed(fixtureId),
			placedPieces: [
				{
					pieceId: firstPiece.id,
					x: firstPiece.correctX,
					y: firstPiece.correctY
				}
			],
			timerStarted: true,
			hasUserActivity: true,
			lastUpdated: 2_000
		};

		await mockPuzzleList(page, [
			{
				id: fixtureId,
				name: 'Resume Fixture',
				pieceCount: fixture.pieceCount,
				aspectRatio: fixture.aspectRatio,
				status: 'ready'
			}
		]);
		await createFixtureRouter().install(page);
		await page.goto('/');
		await createPersistedStateController().seedValid(page, fixtureId, seed);
		await page.reload();

		await expect(page.getByTestId('continue-on-device')).toContainText('Resume Fixture');
		await expect(page.getByTestId('continue-on-device')).toContainText('1/4 PLACED');
		await expect(page.getByTestId('puzzle-card')).toContainText('CONTINUE · 1/4 PLACED');

		await page.getByTestId('continue-on-device').getByRole('link', { name: 'CONTINUE' }).click();
		await expect(page).toHaveURL(/\/puzzle\/e2e-square-4/);
	});

	test('opens saved progress and resumes an older off-page save', async ({ page }) => {
		const newestId = 'e2e-square-4';
		const olderId = 'e2e-landscape-12';
		const newest = getFixture(newestId);
		const older = getFixture(olderId);
		const newestPiece = newest.pieces[0]!;
		const olderPiece = older.pieces[0]!;
		const storage = createPersistedStateController();

		await mockPuzzleList(page, [
			{
				id: newestId,
				name: 'Newest Resume Fixture',
				pieceCount: newest.pieceCount,
				aspectRatio: newest.aspectRatio,
				status: 'ready'
			}
		]);
		await createFixtureRouter().install(page);
		await page.goto('/');

		await storage.seedValid(page, newestId, {
			...buildMinimalSeed(newestId),
			placedPieces: [
				{
					pieceId: newestPiece.id,
					x: newestPiece.correctX,
					y: newestPiece.correctY
				}
			],
			timerStarted: true,
			hasUserActivity: true,
			lastUpdated: 3_000
		});
		await storage.seedValid(page, olderId, {
			...buildMinimalSeed(olderId),
			placedPieces: [
				{
					pieceId: olderPiece.id,
					x: olderPiece.correctX,
					y: olderPiece.correctY
				}
			],
			timerStarted: true,
			hasUserActivity: true,
			lastUpdated: 2_000
		});
		await page.reload();

		await expect(page.getByTestId('continue-on-device')).toContainText('Newest Resume Fixture');
		await page.getByRole('button', { name: 'View saved progress' }).click();

		const dialog = page.getByRole('dialog', { name: 'Saved progress' });
		await expect(dialog.getByTestId(`saved-progress-row-${newestId}`)).toBeVisible();
		await expect(dialog.getByTestId(`saved-progress-row-${olderId}`)).toContainText(older.name);
		await dialog.getByRole('link', { name: `Continue ${older.name}` }).click();
		await expect(page).toHaveURL(new RegExp(`/puzzle/${olderId}$`));
	});

	test('should show no-results state when search returns empty', async ({ page }) => {
		// First load with puzzles, then search returns empty
		await page.route(/\/api\/puzzles(?:\?.*)?$/, async (route) => {
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

		await expect(page.getByTestId('no-results-state')).toBeVisible();
	});

	test('should append more puzzles when scrolling to sentinel', async ({ page }) => {
		const firstPage: PuzzleSummary[] = Array.from({ length: 20 }, (_, i) => ({
			id: `p${i}`,
			name: `Puzzle ${i}`,
			pieceCount: 225,
			status: 'ready'
		}));
		const secondPage: PuzzleSummary[] = [
			{ id: 'p20', name: 'Puzzle 20', pieceCount: 225, status: 'ready' }
		];
		const cursorValue = 'cursor-page-2';

		let callCount = 0;
		await page.route(/\/api\/puzzles(?:\?.*)?$/, async (route) => {
			callCount++;
			const url = route.request().url();
			if (url.includes(`cursor=${cursorValue}`)) {
				await route.fulfill({
					json: { puzzles: secondPage, total: 21, offset: 20, limit: 20 }
				});
			} else {
				await route.fulfill({
					json: { puzzles: firstPage, total: 21, offset: 0, limit: 20, nextCursor: cursorValue }
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
		await expect.poll(() => callCount).toBe(2);
	});
});
