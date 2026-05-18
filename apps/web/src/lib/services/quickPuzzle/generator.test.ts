import { describe, it, expect, vi } from 'vitest';
import { generateQuickPuzzle, validateUploadFile } from './generator';
import { QuickPuzzleValidationError } from './types';

vi.mock('../puzzleImage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../puzzleImage')>();
	return {
		...actual,
		normalizePuzzleImage: vi.fn(actual.normalizePuzzleImage)
	};
});

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

		// Round-trip: decode piece 0 back to verify it's a real PNG with the expected dimensions.
		const piece0Url = result.pieceBlobUrls.get(0)!;
		const piece0Response = await fetch(piece0Url);
		const piece0Blob = await piece0Response.blob();
		expect(piece0Blob.type).toBe('image/png');
		const piece0Bitmap = await createImageBitmap(piece0Blob);
		expect(piece0Bitmap.width).toBeGreaterThan(0);
		expect(piece0Bitmap.height).toBeGreaterThan(0);
		// Width/height should reflect base piece size + 2x overlap (TAB_RATIO = 0.2, so 1.4x).
		// For a 4-piece (2x2) grid of a 400x400 image, base piece is ~200x200, target ~280x280.
		expect(piece0Bitmap.width).toBeGreaterThanOrEqual(200);
		expect(piece0Bitmap.width).toBeLessThanOrEqual(320);
		expect(piece0Bitmap.height).toBeGreaterThanOrEqual(200);
		expect(piece0Bitmap.height).toBeLessThanOrEqual(320);
		piece0Bitmap.close?.();
	});

	it('downscales images larger than the max dimension', async () => {
		const file = await makeTestImageFile(2400, 1800);
		const result = await generateQuickPuzzle(file, 4, 'Big');
		const maxDimension = Math.max(result.stored.imageWidth, result.stored.imageHeight);

		expect(maxDimension).toBeLessThanOrEqual(1200);
	});

	it('rejects piece counts outside [4, 100]', async () => {
		const file = await makeTestImageFile(200, 200);
		const tooFewPieces = generateQuickPuzzle(file, 3, 'x');
		const tooManyPieces = generateQuickPuzzle(file, 101, 'x');

		await expect(tooFewPieces).rejects.toThrow(QuickPuzzleValidationError);
		await expect(tooManyPieces).rejects.toThrow(QuickPuzzleValidationError);
	});

	it('rejects counts that are not allowed for the selected aspect ratio', async () => {
		const file = await makeTestImageFile(200, 200);

		await expect(
			generateQuickPuzzle(file, 24, 'Bad Square', { aspectRatio: '1:1' })
		).rejects.toMatchObject({
			code: 'piece-count-out-of-range'
		});
	});

	it('normalizes portrait images and uses a portrait grid with square cells', async () => {
		const file = await makeTestImageFile(400, 300);
		const result = await generateQuickPuzzle(file, 12, 'Portrait', { aspectRatio: '3:4' });
		const cellWidth = result.stored.imageWidth / result.stored.gridCols;
		const cellHeight = result.stored.imageHeight / result.stored.gridRows;

		expect(result.stored.aspectRatio).toBe('3:4');
		expect(result.stored.gridRows).toBe(4);
		expect(result.stored.gridCols).toBe(3);
		expect(result.stored.imageWidth * 4).toBe(result.stored.imageHeight * 3);
		expect(cellWidth).toBe(cellHeight);
		expect(Number.isInteger(cellWidth)).toBe(true);
		expect(result.stored.pieces).toHaveLength(12);
		expect(result.pieceBlobUrls.size).toBe(12);
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

	it('closes decoded bitmap when piece rendering fails', async () => {
		const decodedClose = vi.fn();
		const decodedBitmap = {
			width: 100,
			height: 100,
			close: decodedClose
		} as unknown as ImageBitmap;
		const originalCreateImageBitmap = globalThis.createImageBitmap;
		const file = await makeTestImageFile(100, 100);

		vi.stubGlobal(
			'createImageBitmap',
			vi.fn((image: ImageBitmapSource) => {
				if (image instanceof Blob && !(image instanceof File)) {
					return Promise.resolve(decodedBitmap);
				}
				return originalCreateImageBitmap(image);
			})
		);

		try {
			await expect(generateQuickPuzzle(file, 4, 'x')).rejects.toThrow();
			expect(decodedClose).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('uses fallback id when crypto.randomUUID is unavailable', async () => {
		const original = crypto.randomUUID;
		const file = await makeTestImageFile(200, 200);

		Object.defineProperty(crypto, 'randomUUID', {
			value: undefined,
			configurable: true,
			writable: true
		});

		try {
			const result = await generateQuickPuzzle(file, 4, 'Fallback');
			expect(result.stored.id).toMatch(/^q-/);
			expect(result.stored.id).not.toMatch(
				/^q-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
			);
		} finally {
			Object.defineProperty(crypto, 'randomUUID', {
				value: original,
				configurable: true,
				writable: true
			});
		}
	});

	it('revokes prior piece blob URLs when mid-loop render fails', async () => {
		const file = await makeTestImageFile(200, 200);
		const originalCreateObjectURL = URL.createObjectURL;
		const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
		let createCount = 0;

		// Make URL.createObjectURL succeed once (for decodeAndDownscale's canvasToBlob
		// doesn't use createObjectURL — it uses FileReader for data URLs) then fail.
		// Actually, renderPiece calls URL.createObjectURL at the end. So we count those.
		vi.stubGlobal(
			'URL',
			class extends URL {
				static createObjectURL(blob: Blob) {
					createCount++;
					// First call: the downscale path uses canvasToBlob then blobToDataUrl
					// (FileReader), not createObjectURL. So the first createObjectURL call
					// is from renderPiece for piece 0. Let it succeed. Second call = piece 1 → fail.
					if (createCount > 1) {
						throw new Error('render failed');
					}
					return originalCreateObjectURL.call(URL, blob);
				}
				static revokeObjectURL = URL.revokeObjectURL;
			}
		);

		try {
			await expect(generateQuickPuzzle(file, 4, 'Leak Test')).rejects.toThrow('render failed');

			// The first piece's blob URL should have been revoked in the catch block
			expect(revokeSpy).toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
			revokeSpy.mockRestore();
		}
	});

	it('uses fallback ID format when crypto.randomUUID is not available', async () => {
		const _originalRandomUUID = crypto.randomUUID;
		const file = await makeTestImageFile(200, 200);

		try {
			vi.stubGlobal('crypto', {
				...crypto,
				randomUUID: undefined
			});

			const result = await generateQuickPuzzle(file, 4, 'Fallback');

			expect(result.stored.id).toMatch(/^q-/);
			expect(result.stored.id).not.toMatch(
				/^q-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('throws unsupported-browser when createImageBitmap is unavailable', async () => {
		const file = await makeTestImageFile(200, 200);
		vi.stubGlobal('createImageBitmap', undefined);
		try {
			await expect(generateQuickPuzzle(file, 4, 'x')).rejects.toMatchObject({
				code: 'unsupported-browser'
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('rejects when FileReader does not return a string', async () => {
		const file = await makeTestImageFile(200, 200);
		const OriginalFileReader = globalThis.FileReader;
		vi.stubGlobal(
			'FileReader',
			class extends OriginalFileReader {
				readAsDataURL(_blob: Blob) {
					Object.defineProperty(this, 'result', { value: null, configurable: true });
					this.onload?.(new Event('load') as ProgressEvent<FileReader>);
				}
			}
		);
		try {
			await expect(generateQuickPuzzle(file, 4, 'x')).rejects.toThrow(
				'FileReader did not return a string'
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('re-throws QuickPuzzleValidationError from normalizePuzzleImage', async () => {
		const file = await makeTestImageFile(200, 200);
		const validationError = new QuickPuzzleValidationError('decode-failed', 'bad');
		const { normalizePuzzleImage } = await import('../puzzleImage');
		vi.mocked(normalizePuzzleImage).mockRejectedValueOnce(validationError);
		await expect(generateQuickPuzzle(file, 4, 'x')).rejects.toBe(validationError);
		vi.mocked(normalizePuzzleImage).mockRestore();
	});

	it('wraps non-validation errors from normalizePuzzleImage', async () => {
		const file = await makeTestImageFile(200, 200);
		const { normalizePuzzleImage } = await import('../puzzleImage');
		vi.mocked(normalizePuzzleImage).mockRejectedValueOnce(new Error('generic failure'));
		await expect(generateQuickPuzzle(file, 4, 'x')).rejects.toMatchObject({
			code: 'decode-failed'
		});
		vi.mocked(normalizePuzzleImage).mockRestore();
	});
});
