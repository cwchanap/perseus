import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRenderCanvas, canvasToBlob } from './render';
import { QuickPuzzleValidationError } from './types';

describe('createRenderCanvas', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns an OffscreenCanvas when available', () => {
		const canvas = createRenderCanvas(100, 80);
		expect(canvas.width).toBe(100);
		expect(canvas.height).toBe(80);
		expect(canvas).toBeInstanceOf(OffscreenCanvas);
	});

	it('falls back to HTMLCanvasElement when OffscreenCanvas is undefined', () => {
		vi.stubGlobal('OffscreenCanvas', undefined);
		const canvas = createRenderCanvas(150, 120);
		expect(canvas.width).toBe(150);
		expect(canvas.height).toBe(120);
		expect(canvas).toBeInstanceOf(HTMLCanvasElement);
	});

	it('throws QuickPuzzleValidationError when neither is available', () => {
		vi.stubGlobal('OffscreenCanvas', undefined);
		// document is a browser built-in we can't redefine, so we stub createElement
		// to a non-function to simulate the "no canvas at all" branch.
		const originalCreate = document.createElement;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(document as any).createElement = undefined;
		try {
			expect(() => createRenderCanvas(50, 50)).toThrow(QuickPuzzleValidationError);
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(document as any).createElement = originalCreate;
		}
	});
});

describe('canvasToBlob', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('produces a JPEG blob from an OffscreenCanvas', async () => {
		const canvas = createRenderCanvas(40, 40);
		const ctx = canvas.getContext('2d')!;
		(ctx as OffscreenCanvasRenderingContext2D).fillStyle = '#abc';
		ctx.fillRect(0, 0, 40, 40);
		const blob = await canvasToBlob(canvas, { type: 'image/jpeg', quality: 0.8 });
		expect(blob.type).toBe('image/jpeg');
		expect(blob.size).toBeGreaterThan(0);
	});

	it('produces a PNG blob from a fallback HTMLCanvasElement', async () => {
		vi.stubGlobal('OffscreenCanvas', undefined);
		const canvas = createRenderCanvas(40, 40);
		const ctx = canvas.getContext('2d')!;
		(ctx as CanvasRenderingContext2D).fillStyle = '#abc';
		ctx.fillRect(0, 0, 40, 40);
		const blob = await canvasToBlob(canvas, { type: 'image/png' });
		expect(blob.type).toBe('image/png');
		expect(blob.size).toBeGreaterThan(0);
	});
});
