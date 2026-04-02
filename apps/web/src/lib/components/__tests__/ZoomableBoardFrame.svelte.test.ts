import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ZoomableBoardFrame from '../ZoomableBoardFrame.svelte';

describe('ZoomableBoardFrame', () => {
	describe('rendering', () => {
		it('renders the frame container', async () => {
			render(ZoomableBoardFrame, {
				scale: 1,
				panX: 0,
				panY: 0,
				onWheel: vi.fn()
			});

			await expect.element(page.getByTestId('zoomable-board-frame')).toBeInTheDocument();
		});
	});

	describe('transform state', () => {
		it('applies transform based on scale and pan values', async () => {
			render(ZoomableBoardFrame, {
				scale: 1.5,
				panX: 100,
				panY: 50,
				onWheel: vi.fn()
			});

			const frame = page.getByTestId('zoomable-board-frame');
			const style = await frame.element().getAttribute('style');
			expect(style).toContain('translate(100px, 50px)');
			expect(style).toContain('scale(1.5)');
		});

		it('applies scale of 1 correctly', async () => {
			render(ZoomableBoardFrame, {
				scale: 1,
				panX: 0,
				panY: 0,
				onWheel: vi.fn()
			});

			const frame = page.getByTestId('zoomable-board-frame');
			const style = await frame.element().getAttribute('style');
			expect(style).toContain('translate(0px, 0px)');
			expect(style).toContain('scale(1)');
		});

		it('applies scale less than 1 correctly', async () => {
			render(ZoomableBoardFrame, {
				scale: 0.5,
				panX: 0,
				panY: 0,
				onWheel: vi.fn()
			});

			const frame = page.getByTestId('zoomable-board-frame');
			const style = await frame.element().getAttribute('style');
			expect(style).toContain('scale(0.5)');
		});

		it('applies scale greater than 1 correctly', async () => {
			render(ZoomableBoardFrame, {
				scale: 2,
				panX: 0,
				panY: 0,
				onWheel: vi.fn()
			});

			const frame = page.getByTestId('zoomable-board-frame');
			const style = await frame.element().getAttribute('style');
			expect(style).toContain('scale(2)');
		});
	});

	describe('wheel events', () => {
		it('calls onWheel when wheel event occurs', async () => {
			const onWheel = vi.fn();
			render(ZoomableBoardFrame, {
				scale: 1,
				panX: 0,
				panY: 0,
				onWheel
			});

			const frame = page.getByTestId('zoomable-board-frame');
			await frame.element().dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true }));

			expect(onWheel).toHaveBeenCalledOnce();
			expect(onWheel).toHaveBeenCalledWith(expect.any(WheelEvent));
		});

		it('passes wheel event with correct deltaY', async () => {
			const onWheel = vi.fn();
			render(ZoomableBoardFrame, {
				scale: 1,
				panX: 0,
				panY: 0,
				onWheel
			});

			const frame = page.getByTestId('zoomable-board-frame');
			await frame.element().dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }));

			expect(onWheel).toHaveBeenCalledWith(expect.objectContaining({ deltaY: -50 }));
		});
	});
});
