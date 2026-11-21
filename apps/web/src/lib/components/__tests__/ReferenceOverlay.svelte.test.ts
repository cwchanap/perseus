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

		it('does not trap keyboard focus (non-dismissible overlay has no keydown handler)', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			const overlay = await page.getByTestId('reference-overlay').element();
			// The non-dismissible (Hold-to-Peek) overlay intentionally has no
			// keydown handler, so Tab passes through without interception.
			const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
			overlay.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
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
			// the focused Close button. Each event is cancelable so the test
			// can assert the handler called preventDefault(), proving it
			// intercepted both forward and reverse Tab navigation.
			const forwardTab = new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
				cancelable: true
			});
			close.dispatchEvent(forwardTab);
			expect(forwardTab.defaultPrevented).toBe(true);
			await expect.poll(() => document.activeElement).toBe(close);

			const reverseTab = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey: true,
				bubbles: true,
				cancelable: true
			});
			close.dispatchEvent(reverseTab);
			expect(reverseTab.defaultPrevented).toBe(true);
			await expect.poll(() => document.activeElement).toBe(close);
		});

		it('restores focus to the trigger when the overlay closes', async () => {
			const trigger = document.createElement('button');
			trigger.textContent = 'REF';
			document.body.appendChild(trigger);
			trigger.focus();

			const { rerender } = await render(ReferenceOverlay, {
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

		it('lets non-Tab keys pass through without trapping focus', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true,
				dismissible: true,
				onDismiss: vi.fn()
			});

			const overlay = await page.getByTestId('reference-overlay').element();
			// A non-Tab key (e.g. Escape) must not be intercepted: the handler
			// only traps Tab, so other keys pass through to the route's global
			// shortcut guard.
			const event = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true
			});
			overlay.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		});
	});

	describe('when the reference image fails to load', () => {
		it('shows the unavailable message after an image error', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			const img = await page.getByRole('img', { name: 'Puzzle reference' }).element();
			img.dispatchEvent(new Event('error', { bubbles: true }));

			const overlay = await page.getByTestId('reference-overlay').element();
			expect(overlay.textContent).toContain('Reference image unavailable');
		});

		it('centres the unavailable message within the overlay instead of letting the hidden broken image displace it', async () => {
			render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			const img = (await page
				.getByRole('img', { name: 'Puzzle reference' })
				.element()) as HTMLImageElement;
			// Drive the error state directly: the vitest server's answer to the
			// fake /api URL is an HTML fallback whose first (cold) fetch can
			// outlast expect.poll's default timeout.
			img.dispatchEvent(new Event('error', { bubbles: true }));
			await expect.poll(() => img.dataset.imageState).toBe('error');

			const overlay = await page.getByTestId('reference-overlay').element();
			const message = await page.getByTestId('reference-image-unavailable').element();
			const overlayRect = overlay.getBoundingClientRect();
			const messageRect = message.getBoundingClientRect();

			const overlayCenterX = overlayRect.left + overlayRect.width / 2;
			const overlayCenterY = overlayRect.top + overlayRect.height / 2;
			const messageCenterX = messageRect.left + messageRect.width / 2;
			const messageCenterY = messageRect.top + messageRect.height / 2;

			expect(Math.abs(messageCenterX - overlayCenterX)).toBeLessThanOrEqual(1);
			expect(Math.abs(messageCenterY - overlayCenterY)).toBeLessThanOrEqual(1);
		});

		it('resets to pending and recovers to loaded on the same img when the imageUrl prop changes', async () => {
			const rendered = await render(ReferenceOverlay, {
				imageUrl: '/api/puzzles/test-puzzle/reference',
				active: true
			});

			const img = (await page
				.getByRole('img', { name: 'Puzzle reference' })
				.element()) as HTMLImageElement;
			// Drive the error state directly: the vitest server's answer to the
			// fake /api URL is an HTML fallback whose first (cold) fetch can
			// outlast expect.poll's default timeout.
			img.dispatchEvent(new Event('error', { bubbles: true }));
			await expect.poll(() => img.dataset.imageState).toBe('error');
			await expect.element(page.getByTestId('reference-image-unavailable')).toBeVisible();

			// Record every data-image-state transition so even a fast data/blob
			// decode proves update() reset the state to 'pending' first.
			const observedStates: string[] = [];
			const observer = new MutationObserver(() => {
				if (img.dataset.imageState) observedStates.push(img.dataset.imageState);
			});
			observer.observe(img, { attributes: true, attributeFilter: ['data-image-state'] });

			const workingSvg =
				'data:image/svg+xml,' +
				encodeURIComponent(
					'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#385"/></svg>'
				);
			try {
				await rendered.rerender({ imageUrl: workingSvg, active: true });
				await expect.poll(() => img.dataset.imageState).toBe('loaded');
			} finally {
				observer.disconnect();
			}

			expect(observedStates).toEqual(['pending', 'loaded']);
			expect(img.naturalWidth).toBeGreaterThan(0);
			expect(page.getByTestId('reference-image-unavailable').query()).toBeNull();
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

	describe('when imageUrl is empty (unavailable, like null)', () => {
		it('renders the unavailable message instead of a forever-pending empty-src img', async () => {
			// imageStatus intentionally never classifies an empty source, so an
			// empty URL would otherwise mount an invisible img stuck on pending
			// with no explanation — the empty URL must read as unavailable.
			render(ReferenceOverlay, { imageUrl: '', active: true });
			const overlay = await page.getByTestId('reference-overlay').element();
			expect(overlay.textContent).toContain('Reference image unavailable');
			expect(await page.getByRole('img', { name: 'Puzzle reference' }).query()).toBeNull();
		});
	});
});
