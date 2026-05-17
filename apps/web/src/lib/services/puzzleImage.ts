import { getGridDimensionsForAspectRatio, type PuzzleAspectRatio } from '@perseus/types';
import { createRenderCanvas, canvasToBlob } from './quickPuzzle/render';

export interface NormalizePuzzleImageOptions {
	aspectRatio: PuzzleAspectRatio;
	pieceCount: number;
	maxDimension: number;
	type?: string;
	quality?: number;
}

export interface NormalizedPuzzleImage {
	blob: Blob;
	width: number;
	height: number;
}

interface CropBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

function getAspectParts(aspectRatio: PuzzleAspectRatio): { width: number; height: number } {
	const [width, height] = aspectRatio.split(':').map((part) => Number.parseInt(part, 10));
	return { width, height };
}

export function getCoverCropBounds(
	sourceWidth: number,
	sourceHeight: number,
	aspectRatio: PuzzleAspectRatio
): CropBounds {
	const target = getAspectParts(aspectRatio);
	const targetRatio = target.width / target.height;
	const sourceRatio = sourceWidth / sourceHeight;

	if (sourceRatio > targetRatio) {
		const width = Math.floor(sourceHeight * targetRatio);
		return {
			x: Math.floor((sourceWidth - width) / 2),
			y: 0,
			width,
			height: sourceHeight
		};
	}

	const height = Math.floor(sourceWidth / targetRatio);
	return {
		x: 0,
		y: Math.floor((sourceHeight - height) / 2),
		width: sourceWidth,
		height
	};
}

export function getNormalizedPuzzleDimensions(
	sourceWidth: number,
	sourceHeight: number,
	options: Pick<NormalizePuzzleImageOptions, 'aspectRatio' | 'pieceCount' | 'maxDimension'>
): { width: number; height: number; rows: number; cols: number; cellSize: number } {
	const { rows, cols } = getGridDimensionsForAspectRatio(options.pieceCount, options.aspectRatio);
	if (rows <= 0 || cols <= 0) {
		throw new Error('Invalid piece count for selected aspect ratio');
	}

	const crop = getCoverCropBounds(sourceWidth, sourceHeight, options.aspectRatio);
	const cellSize = Math.floor(
		Math.min(crop.width / cols, crop.height / rows, options.maxDimension / Math.max(rows, cols))
	);
	if (cellSize <= 0) {
		throw new Error('Image is too small for the selected piece count');
	}

	return {
		width: cols * cellSize,
		height: rows * cellSize,
		rows,
		cols,
		cellSize
	};
}

export async function normalizePuzzleImage(
	file: File,
	options: NormalizePuzzleImageOptions
): Promise<NormalizedPuzzleImage> {
	let source: ImageBitmap;
	try {
		source = await createImageBitmap(file);
	} catch {
		throw new Error("Couldn't read this image. Try a different file.");
	}

	try {
		const crop = getCoverCropBounds(source.width, source.height, options.aspectRatio);
		const dimensions = getNormalizedPuzzleDimensions(source.width, source.height, options);
		const canvas = createRenderCanvas(dimensions.width, dimensions.height);
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			throw new Error("Your browser doesn't support image resizing.");
		}

		ctx.drawImage(
			source,
			crop.x,
			crop.y,
			crop.width,
			crop.height,
			0,
			0,
			dimensions.width,
			dimensions.height
		);

		const blob = await canvasToBlob(canvas, {
			type: options.type ?? 'image/jpeg',
			quality: options.quality ?? 0.88
		});

		return {
			blob,
			width: dimensions.width,
			height: dimensions.height
		};
	} finally {
		source.close?.();
	}
}

function getExtensionForMimeType(mimeType: string): string {
	if (mimeType === 'image/png') return 'png';
	if (mimeType === 'image/webp') return 'webp';
	return 'jpg';
}

export async function normalizePuzzleImageFile(
	file: File,
	options: NormalizePuzzleImageOptions
): Promise<File> {
	const normalized = await normalizePuzzleImage(file, options);
	const stem = file.name.replace(/\.[^.]*$/, '') || 'puzzle';
	const mimeType = normalized.blob.type || 'image/jpeg';
	const ext = getExtensionForMimeType(mimeType);
	return new File([normalized.blob], `${stem}-${options.aspectRatio.replace(':', 'x')}.${ext}`, {
		type: mimeType,
		lastModified: Date.now()
	});
}
