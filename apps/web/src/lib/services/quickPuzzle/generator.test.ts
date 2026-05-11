import { describe, it, expect } from 'vitest';
import { generateQuickPuzzle, validateUploadFile } from './generator';
import { QuickPuzzleValidationError } from './types';

async function makeTestImageFile(width = 200, height = 200): Promise<File> {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff8800';
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = '#0088ff';
	ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
	return new File([blob], 'test.jpg', { type: 'image/jpeg' });
}

describe('validateUploadFile', () => {
	it('accepts JPEG/PNG/WebP under the size cap', () => {
		const file = new File([new Uint8Array(100)], 'a.jpg', { type: 'image/jpeg' });
		expect(() => validateUploadFile(file)).not.toThrow();
	});

	it('rejects unsupported MIME with code invalid-mime', () => {
		const file = new File([new Uint8Array(100)], 'a.gif', { type: 'image/gif' });
		expect(() => validateUploadFile(file)).toThrow(QuickPuzzleValidationError);
		try {
			validateUploadFile(file);
		} catch (err) {
			expect((err as QuickPuzzleValidationError).code).toBe('invalid-mime');
		}
	});

	it('rejects oversized file with code file-too-large', () => {
		const big = new File([new Uint8Array(21 * 1024 * 1024)], 'a.jpg', { type: 'image/jpeg' });
		try {
			validateUploadFile(big);
		} catch (err) {
			expect((err as QuickPuzzleValidationError).code).toBe('file-too-large');
		}
	});
});

describe('generateQuickPuzzle', () => {
	it('produces stored metadata + a piece-blob URL per piece', async () => {
		const file = await makeTestImageFile(400, 400);
		const result = await generateQuickPuzzle(file, 4, 'My Puzzle');

		expect(result.stored.id).toMatch(/^q-/);
		expect(result.stored.name).toBe('My Puzzle');
		expect(result.stored.pieceCount).toBe(4);
		expect(result.stored.gridRows * result.stored.gridCols).toBe(4);
		expect(result.stored.pieces).toHaveLength(4);
		expect(result.stored.imageDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
		expect(result.pieceBlobUrls.size).toBe(4);
		for (let i = 0; i < 4; i++) {
			expect(result.pieceBlobUrls.get(i)).toMatch(/^blob:/);
		}
	});

	it('downscales images larger than the max dimension', async () => {
		const file = await makeTestImageFile(2400, 1800);
		const result = await generateQuickPuzzle(file, 4, 'Big');

		expect(Math.max(result.stored.imageWidth, result.stored.imageHeight)).toBeLessThanOrEqual(1200);
	});

	it('rejects piece counts outside [4, 100]', async () => {
		const file = await makeTestImageFile(200, 200);
		await expect(generateQuickPuzzle(file, 3, 'x')).rejects.toThrow(QuickPuzzleValidationError);
		await expect(generateQuickPuzzle(file, 101, 'x')).rejects.toThrow(QuickPuzzleValidationError);
	});

	it('reports progress via the optional onProgress callback', async () => {
		const file = await makeTestImageFile(200, 200);
		const calls: Array<{ done: number; total: number }> = [];
		await generateQuickPuzzle(file, 4, 'Prog', {
			onProgress: (done, total) => calls.push({ done, total })
		});
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[calls.length - 1]).toEqual({ done: 4, total: 4 });
	});
});
