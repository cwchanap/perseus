import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ReferenceOverlay from '../ReferenceOverlay.svelte';

describe('ReferenceOverlay', () => {
	describe('when active (hold-to-peek, non-dismissible)', () => {
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

		it('does not render a close control', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			await expect.poll(() => page.getByTestId('reference-overlay-close').query()).toBeNull();
		});
	});

	describe('when dismissible (persistent toggle)', () => {
		it('captures pointer events so the obscured gameplay surface is inert', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true,
				dismissible: true,
				onDismiss: vi.fn()
			});

			const overlay = await page.getByTestId('reference-overlay').element();
			expect(overlay.className).not.toContain('pointer-events-none');
		});

		it('renders a visible close control', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true,
				dismissible: true,
				onDismiss: vi.fn()
			});

			await expect.element(page.getByLabelText('Close reference')).toBeVisible();
		});

		it('invokes onDismiss when the close control is clicked', async () => {
			const onDismiss = vi.fn();
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true,
				dismissible: true,
				onDismiss
			});

			await page.getByLabelText('Close reference').click();
			expect(onDismiss).toHaveBeenCalledOnce();
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
