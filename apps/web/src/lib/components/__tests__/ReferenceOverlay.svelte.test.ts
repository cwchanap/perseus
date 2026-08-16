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

		it('moves focus onto the Close control when opened', async () => {
			const trigger = document.createElement('button');
			trigger.textContent = 'REF';
			document.body.appendChild(trigger);
			trigger.focus();

			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true,
				dismissible: true,
				onDismiss: vi.fn()
			});

			const close = await page.getByLabelText('Close reference').element();
			await expect.poll(() => document.activeElement).toBe(close);
			trigger.remove();
		});

		it('traps Tab focus on the Close control so it cannot leave the overlay', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true,
				dismissible: true,
				onDismiss: vi.fn()
			});

			const close = await page.getByLabelText('Close reference').element();
			await expect.poll(() => document.activeElement).toBe(close);

			// Tab and Shift+Tab both wrap back to the single Close control.
			// The handler is on the overlay container; events bubble up from
			// the focused Close button.
			close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
			await expect.poll(() => document.activeElement).toBe(close);
			close.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
			);
			await expect.poll(() => document.activeElement).toBe(close);
		});

		it('restores focus to the trigger when the overlay closes', async () => {
			const trigger = document.createElement('button');
			trigger.textContent = 'REF';
			document.body.appendChild(trigger);
			trigger.focus();

			const { rerender } = render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true,
				dismissible: true,
				onDismiss: vi.fn()
			});

			const close = await page.getByLabelText('Close reference').element();
			await expect.poll(() => document.activeElement).toBe(close);

			rerender({
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: false,
				dismissible: true,
				onDismiss: vi.fn()
			});

			await expect.poll(() => document.activeElement).toBe(trigger);
			trigger.remove();
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
