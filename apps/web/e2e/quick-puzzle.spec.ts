import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'test-image.jpg');

test.describe('Quick puzzle', () => {
	test.beforeEach(async ({ page }) => {
		// Pristine localStorage per test. Visiting any same-origin page first lets
		// us call clear() before the route under test runs.
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('upload → redirect → play → list → delete → 404', async ({ page }) => {
		await page.goto('/quick');

		// 1. Upload + submit
		await page.getByTestId('quick-uploader-file').setInputFiles(FIXTURE);
		await expect(page.getByTestId('quick-uploader-name')).toHaveValue('test-image');
		await page.getByTestId('quick-uploader-pieces').selectOption('4');
		await page.getByTestId('quick-uploader-submit').click();

		// 2. Redirect to play page
		await page.waitForURL(/\/puzzle\/q-/, { timeout: 10_000 });
		const url = page.url();
		const id = url.match(/\/puzzle\/(q-[\w-]+)/)![1];
		await expect(page.getByTestId('puzzle-board')).toBeVisible();

		// Inventory has 4 pieces
		const inventoryPieces = page.getByTestId('puzzle-piece');
		await expect(inventoryPieces).toHaveCount(4);

		// 3. Reload still works (pieces re-render)
		await page.reload();
		await expect(page.getByTestId('puzzle-board')).toBeVisible();
		await expect(page.getByTestId('puzzle-piece')).toHaveCount(4);

		// 4. Back to /quick: list shows the puzzle
		await page.goto('/quick');
		await expect(page.getByTestId(`quick-list-row-${id}`)).toBeVisible();

		// 5. Delete it
		await page.getByTestId(`quick-list-delete-${id}`).click();
		await expect(page.getByTestId(`quick-list-row-${id}`)).toHaveCount(0);

		// 6. Navigating back to /puzzle/<id> shows error UI
		await page.goto(`/puzzle/${id}`);
		await expect(
			page.getByText(/Mission no longer available|Failed to load mission/i)
		).toBeVisible();
	});
});
