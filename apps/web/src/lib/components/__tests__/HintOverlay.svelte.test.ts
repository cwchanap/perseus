import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import HintOverlay from '../HintOverlay.svelte';

describe('HintOverlay', () => {
	describe('when active with target', () => {
		it('renders the overlay', async () => {
			render(HintOverlay, {
				active: true,
				targetX: 2,
				targetY: 1,
				cellSize: 100
			});

			await expect.element(page.getByTestId('hint-overlay')).toBeInTheDocument();
		});

		it('overlay is visible', async () => {
			render(HintOverlay, {
				active: true,
				targetX: 2,
				targetY: 1,
				cellSize: 100
			});

			await expect.element(page.getByTestId('hint-overlay')).toBeVisible();
		});

		it('positions highlight at correct location based on targetX, targetY, and cellSize', async () => {
			const targetX = 2;
			const targetY = 1;
			const cellSize = 100;

			render(HintOverlay, {
				active: true,
				targetX,
				targetY,
				cellSize
			});

			const highlight = page.getByTestId('hint-highlight');
			const highlightElement = await highlight.element();
			const styles = getComputedStyle(highlightElement);

			expect(styles.left).toBe(`${targetX * cellSize}px`);
			expect(styles.top).toBe(`${targetY * cellSize}px`);
			expect(styles.width).toBe(`${cellSize}px`);
			expect(styles.height).toBe(`${cellSize}px`);
		});
	});

	describe('when inactive', () => {
		it('does not render the overlay', async () => {
			render(HintOverlay, {
				active: false,
				targetX: 0,
				targetY: 0,
				cellSize: 100
			});

			const overlay = page.getByTestId('hint-overlay');
			await expect.poll(() => overlay.query()).toBeNull();
		});
	});

	describe('when active without target coordinates', () => {
		it('does not render highlight when targetX is undefined', async () => {
			render(HintOverlay, {
				active: true,
				targetX: undefined,
				targetY: 1,
				cellSize: 100
			});

			const highlight = page.getByTestId('hint-highlight');
			await expect.poll(() => highlight.query()).toBeNull();
		});

		it('does not render highlight when targetY is undefined', async () => {
			render(HintOverlay, {
				active: true,
				targetX: 2,
				targetY: undefined,
				cellSize: 100
			});

			const highlight = page.getByTestId('hint-highlight');
			await expect.poll(() => highlight.query()).toBeNull();
		});
	});
});
