import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ReferenceOverlay from '../ReferenceOverlay.svelte';

describe('ReferenceOverlay', () => {
	describe('when active', () => {
		it('renders the overlay', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			await expect.element(page.getByTestId('reference-overlay')).toBeInTheDocument();
		});

		it('renders the reference image with correct src', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			const img = page.getByRole('img', { name: 'Puzzle reference' });
			await expect.element(img).toHaveAttribute('src', '/api/puzzles/test-puzzle/reference');
		});

		it('overlay is visible', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			await expect.element(page.getByTestId('reference-overlay')).toBeVisible();
		});

		it('does not capture pointer events', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			const overlay = await page.getByTestId('reference-overlay').element();
			expect(overlay.className).toContain('pointer-events-none');
		});
	});

	describe('when inactive', () => {
		it('does not render the overlay', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: false
			});

			const overlay = page.getByTestId('reference-overlay');
			await expect.poll(() => overlay.query()).toBeNull();
		});
	});

	describe('when imageUrl is null', () => {
		it('renders the unavailable message', async () => {
			render(ReferenceOverlay, { imageUrl: null, active: true });
			const overlay = await page.getByTestId('reference-overlay').element();
			expect(overlay.textContent).toContain('Reference image unavailable');
		});
	});
});
