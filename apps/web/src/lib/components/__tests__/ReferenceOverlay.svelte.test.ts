import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ReferenceOverlay from '../ReferenceOverlay.svelte';

vi.mock('$lib/services/api', () => ({
	getReferenceImageUrl: vi.fn((puzzleId: string) => `/api/puzzles/${puzzleId}/reference`)
}));

describe('ReferenceOverlay', () => {
	describe('when active', () => {
		it('renders the overlay', async () => {
			render(ReferenceOverlay, {
				puzzleId: 'test-puzzle',
				active: true
			});

			await expect.element(page.getByTestId('reference-overlay')).toBeInTheDocument();
		});

		it('renders the reference image with correct src', async () => {
			render(ReferenceOverlay, {
				puzzleId: 'test-puzzle',
				active: true
			});

			const overlay = page.getByTestId('reference-overlay');
			const img = overlay.locator('img');
			await expect.element(img).toHaveAttribute('src', '/api/puzzles/test-puzzle/reference');
		});

		it('overlay is visible', async () => {
			render(ReferenceOverlay, {
				puzzleId: 'test-puzzle',
				active: true
			});

			await expect.element(page.getByTestId('reference-overlay')).toBeVisible();
		});
	});

	describe('when inactive', () => {
		it('does not render the overlay', async () => {
			render(ReferenceOverlay, {
				puzzleId: 'test-puzzle',
				active: false
			});

			const overlay = page.getByTestId('reference-overlay');
			await expect.poll(() => overlay.query()).toBeNull();
		});
	});
});
