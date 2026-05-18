/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	getCoverCropBounds,
	getNormalizedPuzzleDimensions,
	normalizePuzzleImage,
	normalizePuzzleImageFile
} from './puzzleImage';
import type { PuzzleAspectRatio } from '@perseus/types';
import { createRenderCanvas, canvasToBlob } from './quickPuzzle/render';

vi.mock('./quickPuzzle/render', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>;
	return {
		...actual,
		createRenderCanvas: vi.fn(actual.createRenderCanvas),
		canvasToBlob: vi.fn(actual.canvasToBlob)
	};
});

async function makeTestImageFile(
	width = 200,
	height = 200,
	type: string = 'image/jpeg'
): Promise<File> {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff8800';
	ctx.fillRect(0, 0, width, height);
	const blob = await canvas.convertToBlob({ type, quality: 0.8 });
	return new File(
		[blob],
		`test.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`,
		{
			type
		}
	);
}

describe('getCoverCropBounds', () => {
	it('crops sides when source is wider than target ratio', () => {
		const result = getCoverCropBounds(400, 200, '1:1');
		expect(result.x).toBe(100);
		expect(result.y).toBe(0);
		expect(result.width).toBe(200);
		expect(result.height).toBe(200);
	});

	it('crops top/bottom when source is taller than target ratio', () => {
		const result = getCoverCropBounds(200, 400, '1:1');
		expect(result.x).toBe(0);
		expect(result.y).toBe(100);
		expect(result.width).toBe(200);
		expect(result.height).toBe(200);
	});

	it('returns full source when ratios match', () => {
		const result = getCoverCropBounds(400, 300, '4:3');
		expect(result.x).toBe(0);
		expect(result.y).toBe(0);
		expect(result.width).toBe(400);
		expect(result.height).toBe(300);
	});

	it('crops sides for 4:3 ratio on a 16:9 source', () => {
		const result = getCoverCropBounds(1600, 900, '4:3');
		expect(result.x).toBeGreaterThan(0);
		expect(result.y).toBe(0);
		expect(result.width).toBe(1200);
		expect(result.height).toBe(900);
	});

	it('crops top/bottom for 3:4 ratio on a landscape source', () => {
		const result = getCoverCropBounds(400, 600, '3:4');
		expect(result.x).toBe(0);
		expect(result.y).toBeGreaterThan(0);
		expect(result.width).toBe(400);
		expect(result.height).toBe(Math.floor(400 / 0.75));
	});
});

describe('getNormalizedPuzzleDimensions', () => {
	const baseOpts = {
		aspectRatio: '1:1' as PuzzleAspectRatio,
		pieceCount: 4,
		maxDimension: 1200
	};

	it('returns correct dimensions for a square image with 1:1 ratio', () => {
		const result = getNormalizedPuzzleDimensions(400, 400, baseOpts);
		expect(result.rows).toBe(2);
		expect(result.cols).toBe(2);
		expect(result.width).toBe(result.cols * result.cellSize);
		expect(result.height).toBe(result.rows * result.cellSize);
		expect(result.width).toBe(result.height);
	});

	it('returns correct dimensions for a landscape image with 4:3 ratio', () => {
		const result = getNormalizedPuzzleDimensions(800, 600, {
			aspectRatio: '4:3',
			pieceCount: 12,
			maxDimension: 1200
		});
		expect(result.rows).toBe(3);
		expect(result.cols).toBe(4);
		expect(result.width).toBe(result.cols * result.cellSize);
		expect(result.height).toBe(result.rows * result.cellSize);
		expect(result.width * 3).toBe(result.height * 4);
	});

	it('returns correct dimensions for portrait image with 3:4 ratio', () => {
		const result = getNormalizedPuzzleDimensions(600, 800, {
			aspectRatio: '3:4',
			pieceCount: 12,
			maxDimension: 1200
		});
		expect(result.rows).toBe(4);
		expect(result.cols).toBe(3);
		expect(result.height * 3).toBe(result.width * 4);
	});

	it('throws when piece count is invalid for the aspect ratio', () => {
		expect(() =>
			getNormalizedPuzzleDimensions(400, 400, {
				aspectRatio: '1:1',
				pieceCount: 7,
				maxDimension: 1200
			})
		).toThrow('Invalid piece count for selected aspect ratio');
	});

	it('throws when image is too small', () => {
		expect(() =>
			getNormalizedPuzzleDimensions(1, 1, {
				aspectRatio: '1:1',
				pieceCount: 100,
				maxDimension: 1200
			})
		).toThrow('Image is too small for the selected piece count');
	});

	it('caps cellSize by maxDimension', () => {
		const result = getNormalizedPuzzleDimensions(4000, 4000, {
			aspectRatio: '1:1',
			pieceCount: 4,
			maxDimension: 400
		});
		expect(result.cellSize).toBeLessThanOrEqual(200);
	});
});

describe('normalizePuzzleImage', () => {
	const baseOpts = {
		aspectRatio: '1:1' as PuzzleAspectRatio,
		pieceCount: 4,
		maxDimension: 1200
	};

	it('successfully normalizes a test image', async () => {
		const file = await makeTestImageFile(400, 400);
		const result = await normalizePuzzleImage(file, baseOpts);
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.blob.type).toBe('image/jpeg');
		expect(result.width).toBeGreaterThan(0);
		expect(result.height).toBeGreaterThan(0);
	});

	it('returns dimensions matching the expected grid', async () => {
		const file = await makeTestImageFile(400, 400);
		const result = await normalizePuzzleImage(file, baseOpts);
		expect(result.width).toBe(result.height);
	});

	it('uses the specified output type and quality', async () => {
		const file = await makeTestImageFile(400, 400);
		const result = await normalizePuzzleImage(file, {
			...baseOpts,
			type: 'image/png',
			quality: 1
		});
		expect(result.blob.type).toBe('image/png');
	});

	it('throws when createImageBitmap fails', async () => {
		const badFile = new File([new Uint8Array([0x00, 0x01, 0x02])], 'bad.jpg', {
			type: 'image/jpeg'
		});
		await expect(normalizePuzzleImage(badFile, baseOpts)).rejects.toThrow(
			"Couldn't read this image. Try a different file."
		);
	});

	it('handles landscape images with 4:3 ratio', async () => {
		const file = await makeTestImageFile(800, 600);
		const result = await normalizePuzzleImage(file, {
			aspectRatio: '4:3',
			pieceCount: 12,
			maxDimension: 1200
		});
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.width * 3).toBe(result.height * 4);
	});
});

describe('normalizePuzzleImageFile', () => {
	const baseOpts = {
		aspectRatio: '1:1' as PuzzleAspectRatio,
		pieceCount: 4,
		maxDimension: 1200
	};

	it('returns a File with correct name pattern', async () => {
		let file = await makeTestImageFile(200, 200);
		file = new File([file], 'sunset.jpg', { type: file.type });
		const result = await normalizePuzzleImageFile(file, baseOpts);
		expect(result).toBeInstanceOf(File);
		expect(result.name).toBe('sunset-1x1.jpg');
	});

	it('returns png extension for png output type', async () => {
		let file = await makeTestImageFile(200, 200);
		file = new File([file], 'photo.jpg', { type: file.type });
		const result = await normalizePuzzleImageFile(file, {
			...baseOpts,
			type: 'image/png'
		});
		expect(result.name).toBe('photo-1x1.png');
		expect(result.type).toBe('image/png');
	});

	it('returns webp extension for webp output type', async () => {
		let file = await makeTestImageFile(200, 200);
		file = new File([file], 'pic.jpg', { type: file.type });
		const result = await normalizePuzzleImageFile(file, {
			...baseOpts,
			type: 'image/webp'
		});
		expect(result.name).toBe('pic-1x1.webp');
		expect(result.type).toBe('image/webp');
	});

	it('uses puzzle as fallback stem when filename has no extension', async () => {
		let file = await makeTestImageFile(200, 200);
		file = new File([file], '.hidden', { type: file.type });
		const result = await normalizePuzzleImageFile(file, baseOpts);
		expect(result.name).toBe('puzzle-1x1.jpg');
	});

	it('uses aspect ratio in filename', async () => {
		let file = await makeTestImageFile(400, 300);
		file = new File([file], 'landscape.jpg', { type: file.type });
		const result = await normalizePuzzleImageFile(file, {
			aspectRatio: '4:3',
			pieceCount: 12,
			maxDimension: 1200
		});
		expect(result.name).toBe('landscape-4x3.jpg');
	});
});

describe('normalizePuzzleImage coverage gaps', () => {
	const baseOpts = {
		aspectRatio: '1:1' as PuzzleAspectRatio,
		pieceCount: 4,
		maxDimension: 1200
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('throws when canvas 2d context is null', async () => {
		vi.mocked(createRenderCanvas).mockReturnValueOnce({
			width: 200,
			height: 200,
			getContext: () => null
		} as any);

		const file = await makeTestImageFile(200, 200);
		await expect(normalizePuzzleImage(file, baseOpts)).rejects.toThrow(
			"Your browser doesn't support image resizing."
		);
	});

	it('handles source without close method in finally block', async () => {
		vi.spyOn(globalThis, 'createImageBitmap').mockResolvedValueOnce({
			width: 200,
			height: 200
		} as any);
		vi.mocked(createRenderCanvas).mockReturnValueOnce({
			width: 200,
			height: 200,
			getContext: () => null
		} as any);

		const file = await makeTestImageFile(200, 200);
		await expect(normalizePuzzleImage(file, baseOpts)).rejects.toThrow(
			"Your browser doesn't support image resizing."
		);
	});

	it('falls back to image/jpeg when blob has empty type', async () => {
		const blobNoType = new Blob([], { type: '' });
		vi.mocked(canvasToBlob).mockResolvedValueOnce(blobNoType);

		const file = await makeTestImageFile(200, 200);
		const result = await normalizePuzzleImageFile(file, baseOpts);
		expect(result.type).toBe('image/jpeg');
		expect(result.name).toMatch(/\.jpg$/);
	});
});
