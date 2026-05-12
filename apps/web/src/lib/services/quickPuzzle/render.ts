import { TAB_RATIO, generateJigsawSvgMask } from '@perseus/types';
import { QuickPuzzleValidationError, type QuickPieceMeta } from './types';

export interface PieceBounds {
	extractLeft: number;
	extractTop: number;
	extractWidth: number;
	extractHeight: number;
	targetWidth: number;
	targetHeight: number;
	offsetX: number;
	offsetY: number;
}

export interface GridDims {
	rows: number;
	cols: number;
	srcWidth: number;
	srcHeight: number;
}

/**
 * Compute the piece's extraction bounds and target dimensions, accounting for
 * jigsaw-tab overlap and clamping at the source-image edges.
 */
export function computePieceBounds(
	row: number,
	col: number,
	{ rows, cols, srcWidth, srcHeight }: GridDims
): PieceBounds {
	const basePieceWidth = Math.floor(srcWidth / cols);
	const extraWidth = srcWidth % cols;
	const basePieceHeight = Math.floor(srcHeight / rows);
	const extraHeight = srcHeight % rows;

	const baseWidth = basePieceWidth + (col === cols - 1 ? extraWidth : 0);
	const baseHeight = basePieceHeight + (row === rows - 1 ? extraHeight : 0);

	const overlapX = Math.floor(baseWidth * TAB_RATIO);
	const overlapY = Math.floor(baseHeight * TAB_RATIO);

	const targetWidth = baseWidth + 2 * overlapX;
	const targetHeight = baseHeight + 2 * overlapY;

	const baseLeft = col * basePieceWidth;
	const baseTop = row * basePieceHeight;
	const idealLeft = baseLeft - overlapX;
	const idealTop = baseTop - overlapY;

	const extractLeft = Math.max(0, idealLeft);
	const extractTop = Math.max(0, idealTop);
	const extractRight = Math.min(srcWidth, idealLeft + targetWidth);
	const extractBottom = Math.min(srcHeight, idealTop + targetHeight);

	const extractWidth = extractRight - extractLeft;
	const extractHeight = extractBottom - extractTop;
	const offsetX = extractLeft - idealLeft;
	const offsetY = extractTop - idealTop;

	return {
		extractLeft,
		extractTop,
		extractWidth,
		extractHeight,
		targetWidth,
		targetHeight,
		offsetX,
		offsetY
	};
}

function svgStringToImage(svg: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const blob = new Blob([svg], { type: 'image/svg+xml' });
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Failed to load SVG mask'));
		};
		img.src = url;
	});
}

/**
 * Render a single piece by extracting from the source bitmap and applying the
 * jigsaw mask via canvas composite. Returns an object URL pointing at the masked PNG.
 */
export async function renderPiece(
	source: ImageBitmap,
	piece: QuickPieceMeta,
	bounds: PieceBounds
): Promise<string> {
	const canvas = new OffscreenCanvas(bounds.targetWidth, bounds.targetHeight);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new QuickPuzzleValidationError(
			'unsupported-browser',
			"Your browser doesn't support quick puzzles."
		);
	}

	ctx.drawImage(
		source,
		bounds.extractLeft,
		bounds.extractTop,
		bounds.extractWidth,
		bounds.extractHeight,
		bounds.offsetX,
		bounds.offsetY,
		bounds.extractWidth,
		bounds.extractHeight
	);

	const svg = generateJigsawSvgMask(piece.edges, bounds.targetWidth, bounds.targetHeight);
	const maskImg = await svgStringToImage(svg);
	ctx.globalCompositeOperation = 'destination-in';
	ctx.drawImage(maskImg, 0, 0, bounds.targetWidth, bounds.targetHeight);
	ctx.globalCompositeOperation = 'source-over';

	const blob = await canvas.convertToBlob({ type: 'image/png' });
	return URL.createObjectURL(blob);
}
