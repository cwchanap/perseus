// Puzzle generator service using WASM image processing for worker compatibility
import { mkdir, writeFile } from 'fs/promises';
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

type PhotonModule = typeof import('@cf-wasm/photon');
type ResvgModule = typeof import('@cf-wasm/resvg');

interface ImageTooling {
	PhotonImage: PhotonModule['PhotonImage'];
	resize: PhotonModule['resize'];
	crop: PhotonModule['crop'];
	SamplingFilter: PhotonModule['SamplingFilter'];
	Resvg: ResvgModule['Resvg'];
}

let imageTooling: ImageTooling | null = null;

async function getImageTooling(
	loadPhoton: () => Promise<unknown> = () => import('@cf-wasm/photon'),
	loadResvg: () => Promise<unknown> = () => import('@cf-wasm/resvg')
): Promise<ImageTooling> {
	if (imageTooling) return imageTooling;

	try {
		const photon = (await loadPhoton()) as PhotonModule;
		const resvg = (await loadResvg()) as ResvgModule;

		const missingSymbols: string[] = [];
		if (!photon?.PhotonImage) missingSymbols.push('photon.PhotonImage');
		if (!photon?.resize) missingSymbols.push('photon.resize');
		if (!photon?.crop) missingSymbols.push('photon.crop');
		if (!photon?.SamplingFilter) missingSymbols.push('photon.SamplingFilter');
		if (!resvg?.Resvg) missingSymbols.push('resvg.Resvg');
		if (missingSymbols.length > 0) {
			throw new Error(
				`Missing exports from image processing modules: ${missingSymbols.join(', ')}`
			);
		}

		imageTooling = {
			PhotonImage: photon.PhotonImage,
			resize: photon.resize,
			crop: photon.crop,
			SamplingFilter: photon.SamplingFilter,
			Resvg: resvg.Resvg
		};

		return imageTooling;
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		throw new Error(
			'Image processing dependencies "@cf-wasm/photon" or "@cf-wasm/resvg" are not available',
			{ cause }
		);
	}
}

export function __resetImageToolingForTests(): void {
	imageTooling = null;
}

export async function __getImageToolingForTests(
	loadPhoton?: () => Promise<unknown>,
	loadResvg?: () => Promise<unknown>
): Promise<ImageTooling> {
	return getImageTooling(loadPhoton, loadResvg);
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

function padPixelsToTarget(
	sourcePixels: Uint8Array,
	sourceWidth: number,
	sourceHeight: number,
	targetWidth: number,
	targetHeight: number,
	offsetX: number,
	offsetY: number
): Uint8Array {
	const padded = new Uint8Array(targetWidth * targetHeight * 4);
	const rowBytes = sourceWidth * 4;
	for (let y = 0; y < sourceHeight; y += 1) {
		const sourceStart = y * rowBytes;
		const targetStart = ((y + offsetY) * targetWidth + offsetX) * 4;
		padded.set(sourcePixels.subarray(sourceStart, sourceStart + rowBytes), targetStart);
	}
	return padded;
}

function applyMaskAlpha(piecePixels: Uint8Array, maskPixels: Uint8Array): void {
	for (let i = 0; i < piecePixels.length; i += 4) {
		piecePixels[i + 3] = maskPixels[i + 3];
	}
}

export async function generatePuzzle(
	options: GeneratePuzzleOptions
): Promise<GeneratePuzzleResult> {
	const { id, name, pieceCount, imageBuffer, outputDir } = options;
	const { PhotonImage, resize, crop, SamplingFilter, Resvg } = await getImageTooling();

	if (!isValidPieceCount(pieceCount)) {
		throw new Error(
			`Invalid piece count: ${pieceCount}. Allowed values: ${ALLOWED_PIECE_COUNTS.join(', ')}`
		);
	}

	// Create output directories
	const puzzleDir = path.join(outputDir, id);
	const piecesDir = path.join(puzzleDir, 'pieces');
	await mkdir(piecesDir, { recursive: true });

	const sourceBytes = new Uint8Array(
		imageBuffer.buffer,
		imageBuffer.byteOffset,
		imageBuffer.byteLength
	);
	const sourceImage = PhotonImage.new_from_byteslice(sourceBytes);
	let sourceImageFreed = false;

	try {
		const imageWidth = sourceImage.get_width();
		const imageHeight = sourceImage.get_height();

		// Generate thumbnail
		const thumbnailPath = path.join(puzzleDir, 'thumbnail.jpg');
		let thumbnailSource: InstanceType<typeof PhotonImage> | null = null;
		let resized: InstanceType<typeof PhotonImage> | null = null;
		let cropped: InstanceType<typeof PhotonImage> | null = null;
		let jpegBytes: Uint8Array;
		try {
			thumbnailSource = PhotonImage.new_from_byteslice(sourceBytes);
			const srcW = thumbnailSource.get_width();
			const srcH = thumbnailSource.get_height();
			const scale = Math.max(THUMBNAIL_SIZE / srcW, THUMBNAIL_SIZE / srcH);
			const newW = Math.round(srcW * scale);
			const newH = Math.round(srcH * scale);
			resized = resize(thumbnailSource, newW, newH, SamplingFilter.Lanczos3);
			thumbnailSource.free();
			thumbnailSource = null;
			const cropX = Math.floor((newW - THUMBNAIL_SIZE) / 2);
			const cropY = Math.floor((newH - THUMBNAIL_SIZE) / 2);
			cropped = crop(resized, cropX, cropY, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
			resized.free();
			resized = null;
			jpegBytes = cropped.get_bytes_jpeg(80);
			cropped.free();
			cropped = null;
		} finally {
			if (cropped) cropped.free();
			if (resized) resized.free();
			if (thumbnailSource) thumbnailSource.free();
		}
		await writeFile(thumbnailPath, Buffer.from(jpegBytes));

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

				// Extract piece region from source image
				const pieceImage = crop(sourceImage, extractLeft, extractTop, extractWidth, extractHeight);
				const piecePixels = pieceImage.get_raw_pixels();
				const paddedPiecePixels = padPixelsToTarget(
					piecePixels,
					extractWidth,
					extractHeight,
					targetWidth,
					targetHeight,
					padLeft,
					padTop
				);

				// Generate jigsaw mask SVG and apply it
				const jigsawMask = generateJigsawSvgMask(edges, targetWidth, targetHeight).toString(
					'utf-8'
				);
				const resvg = new Resvg(jigsawMask, {
					fitTo: { mode: 'width', value: targetWidth }
				});
				const maskPng = resvg.render().asPng();
				const maskImage = PhotonImage.new_from_byteslice(maskPng);

				let maskImageFreed = false;
				let pieceImageFreed = false;
				let maskedPiece: InstanceType<typeof PhotonImage> | null = null;

				try {
					const maskPixels = maskImage.get_raw_pixels();

					if (maskPixels.length !== paddedPiecePixels.length) {
						throw new Error(
							`Mask and piece image pixel count mismatch for piece ${pieceId}: ` +
								`mask=${maskPixels.length} pixels, piece=${paddedPiecePixels.length} pixels`
						);
					}

					applyMaskAlpha(paddedPiecePixels, maskPixels);

					maskedPiece = new PhotonImage(paddedPiecePixels, targetWidth, targetHeight);
					const pngBytes = maskedPiece.get_bytes();

					await writeFile(piecePath, Buffer.from(pngBytes));
				} finally {
					if (!maskImageFreed) {
						maskImage.free();
						maskImageFreed = true;
					}
					if (!pieceImageFreed) {
						pieceImage.free();
						pieceImageFreed = true;
					}
					if (maskedPiece) {
						maskedPiece.free();
						maskedPiece = null;
					}
				}

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

		sourceImage.free();
		sourceImageFreed = true;

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
	} finally {
		if (!sourceImageFreed) sourceImage.free();
	}
}

export { ALLOWED_PIECE_COUNTS, isValidPieceCount };
