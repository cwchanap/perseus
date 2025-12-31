// Puzzle generator service using Sharp for image processing
import type sharpType from 'sharp';
import { mkdir } from 'fs/promises';
import path from 'path';
import type { Puzzle, PuzzlePiece, AllowedPieceCount, EdgeConfig } from '../types';
import { generateJigsawSvgMask } from '../utils/jigsawPath';
import { TAB_RATIO } from '../constants/puzzle';

const THUMBNAIL_SIZE = 300;
const ALLOWED_PIECE_COUNTS: AllowedPieceCount[] = [9, 16, 25, 36, 49, 64, 100];

interface GridDimensions {
	rows: number;
	cols: number;
}

type SharpFactory = typeof sharpType;

let sharpFactory: SharpFactory | null = null;

async function getSharp(): Promise<SharpFactory> {
	if (sharpFactory) return sharpFactory;

	try {
		const mod = await import('sharp');
		const resolved =
			(mod as unknown as { default?: SharpFactory }).default ?? (mod as unknown as SharpFactory);
		sharpFactory = resolved;
		return sharpFactory;
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		throw new Error('Image processing dependency "sharp" is not available', { cause });
	}
}

function getGridDimensions(pieceCount: AllowedPieceCount): GridDimensions {
	const sqrt = Math.sqrt(pieceCount);
	return { rows: sqrt, cols: sqrt };
}

function isValidPieceCount(count: number): count is AllowedPieceCount {
	return ALLOWED_PIECE_COUNTS.includes(count as AllowedPieceCount);
}

export interface GeneratePuzzleOptions {
	id: string;
	name: string;
	pieceCount: number;
	imageBuffer: Buffer;
	outputDir: string;
}

export interface GeneratePuzzleResult {
	puzzle: Puzzle;
	thumbnailPath: string;
	piecePaths: string[];
}

export async function generatePuzzle(
	options: GeneratePuzzleOptions
): Promise<GeneratePuzzleResult> {
	const { id, name, pieceCount, imageBuffer, outputDir } = options;
	const sharp = await getSharp();

	if (!isValidPieceCount(pieceCount)) {
		throw new Error(
			`Invalid piece count: ${pieceCount}. Allowed values: ${ALLOWED_PIECE_COUNTS.join(', ')}`
		);
	}

	// Create output directories
	const puzzleDir = path.join(outputDir, id);
	const piecesDir = path.join(puzzleDir, 'pieces');
	await mkdir(piecesDir, { recursive: true });

	// Get image metadata
	const image = sharp(imageBuffer);
	const metadata = await image.metadata();
	if (metadata.width === undefined || metadata.height === undefined) {
		throw new Error('Invalid image metadata: missing width or height');
	}
	const imageWidth = metadata.width;
	const imageHeight = metadata.height;

	// Generate thumbnail
	const thumbnailPath = path.join(puzzleDir, 'thumbnail.jpg');
	await image
		.resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'cover' })
		.jpeg({ quality: 80 })
		.toFile(thumbnailPath);

	// Calculate grid dimensions
	const { rows, cols } = getGridDimensions(pieceCount);
	const basePieceWidth = Math.floor(imageWidth / cols);
	const extraWidth = imageWidth % cols;
	const basePieceHeight = Math.floor(imageHeight / rows);
	const extraHeight = imageHeight % rows;

	// Generate pieces
	const pieces: PuzzlePiece[] = [];
	const piecePaths: string[] = [];

	const bottomEdgesForAbove: Array<'flat' | 'tab' | 'blank'> = new Array(cols).fill('flat');
	const opposite = (edge: 'flat' | 'tab' | 'blank'): 'flat' | 'tab' | 'blank' =>
		edge === 'tab' ? 'blank' : edge === 'blank' ? 'tab' : 'flat';

	for (let row = 0; row < rows; row++) {
		let leftEdgeForNext = 'flat' as 'flat' | 'tab' | 'blank';
		for (let col = 0; col < cols; col++) {
			const pieceId = row * cols + col;
			const piecePath = path.join(piecesDir, `${pieceId}.png`);

			// Calculate base piece dimensions
			const baseWidth = basePieceWidth + (col === cols - 1 ? extraWidth : 0);
			const baseHeight = basePieceHeight + (row === rows - 1 ? extraHeight : 0);

			// Calculate overlap for jigsaw tabs (TAB_RATIO of actual piece size on each side)
			const overlapX = Math.floor(baseWidth * TAB_RATIO);
			const overlapY = Math.floor(baseHeight * TAB_RATIO);

			// Target size: base piece + overlap on all sides (140% of base)
			const targetWidth = baseWidth + 2 * overlapX;
			const targetHeight = baseHeight + 2 * overlapY;

			// Calculate extraction bounds with overlap
			const baseLeft = col * basePieceWidth;
			const baseTop = row * basePieceHeight;

			// Calculate ideal extraction bounds (may extend outside image)
			const idealLeft = baseLeft - overlapX;
			const idealTop = baseTop - overlapY;

			// Clamp extraction to image boundaries
			const extractLeft = Math.max(0, idealLeft);
			const extractTop = Math.max(0, idealTop);
			const extractRight = Math.min(imageWidth, idealLeft + targetWidth);
			const extractBottom = Math.min(imageHeight, idealTop + targetHeight);

			const extractWidth = extractRight - extractLeft;
			const extractHeight = extractBottom - extractTop;

			// Calculate padding needed for edge pieces
			const padLeft = extractLeft - idealLeft;
			const padTop = extractTop - idealTop;
			const padRight = targetWidth - extractWidth - padLeft;
			const padBottom = targetHeight - extractHeight - padTop;

			// Determine edge types with matched neighbors (needed before masking)
			const topEdge = row === 0 ? 'flat' : opposite(bottomEdgesForAbove[col]);
			const rightEdge = col === cols - 1 ? 'flat' : (row + col) % 2 === 0 ? 'tab' : 'blank';
			const bottomEdge = row === rows - 1 ? 'flat' : (row + col) % 2 === 0 ? 'blank' : 'tab';
			const leftEdge = col === 0 ? 'flat' : opposite(leftEdgeForNext);

			bottomEdgesForAbove[col] = bottomEdge;
			leftEdgeForNext = rightEdge;

			const edges: EdgeConfig = {
				top: topEdge,
				right: rightEdge,
				bottom: bottomEdge,
				left: leftEdge
			};

			// Extract piece with padding for consistent 140% size
			const extractedPiece = await sharp(imageBuffer)
				.extract({
					left: extractLeft,
					top: extractTop,
					width: extractWidth,
					height: extractHeight
				})
				.extend({
					top: padTop,
					bottom: padBottom,
					left: padLeft,
					right: padRight,
					background: { r: 0, g: 0, b: 0, alpha: 0 }
				})
				.png()
				.toBuffer();

			// Generate jigsaw mask SVG and apply it
			const jigsawMask = generateJigsawSvgMask(edges, targetWidth, targetHeight);

			// Apply mask using composite with dest-in blend
			await sharp(extractedPiece)
				.composite([
					{
						input: jigsawMask,
						blend: 'dest-in'
					}
				])
				.png()
				.toFile(piecePath);

			pieces.push({
				id: pieceId,
				puzzleId: id,
				correctX: col,
				correctY: row,
				edges,
				imagePath: `pieces/${pieceId}.png`
			});

			piecePaths.push(piecePath);
		}
	}

	// Construct puzzle metadata
	const puzzle: Puzzle = {
		id: id,
		name,
		pieceCount,
		gridCols: cols,
		gridRows: rows,
		imageWidth,
		imageHeight,
		pieces,
		createdAt: Date.now()
	};

	return {
		puzzle,
		thumbnailPath,
		piecePaths
	};
}

export { ALLOWED_PIECE_COUNTS, isValidPieceCount };
