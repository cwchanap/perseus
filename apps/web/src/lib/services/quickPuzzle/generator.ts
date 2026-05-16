import {
	getGridDimensionsForAspectRatio,
	getTopEdge,
	getRightEdge,
	getBottomEdge,
	getLeftEdge,
	isValidPieceCountForAspectRatio,
	type PuzzleAspectRatio,
	type EdgeConfig
} from '@perseus/types';

import { computePieceBounds, renderPiece } from './render';
import { normalizePuzzleImage } from '../puzzleImage';
import {
	QUICK_PUZZLE_ALLOWED_MIMES,
	QUICK_PUZZLE_DEFAULT_ASPECT_RATIO,
	QUICK_PUZZLE_DEFAULT_PIECES,
	QUICK_PUZZLE_ID_PREFIX,
	QUICK_PUZZLE_JPEG_QUALITY,
	QUICK_PUZZLE_MAX_DIMENSION,
	QUICK_PUZZLE_MAX_PIECES,
	QUICK_PUZZLE_MAX_UPLOAD_BYTES,
	QUICK_PUZZLE_MIN_PIECES,
	QUICK_PUZZLE_SCHEMA_VERSION,
	QuickPuzzleValidationError,
	type QuickPieceMeta,
	type StoredQuickPuzzle
} from './types';

export interface GenerateOptions {
	onProgress?: (done: number, total: number) => void;
	aspectRatio?: PuzzleAspectRatio;
}

export interface GenerateResult {
	stored: StoredQuickPuzzle;
	pieceBlobUrls: Map<number, string>;
}

export function validateUploadFile(file: File): void {
	const mime = file.type.toLowerCase();
	if (!(QUICK_PUZZLE_ALLOWED_MIMES as readonly string[]).includes(mime)) {
		throw new QuickPuzzleValidationError(
			'invalid-mime',
			'Please choose a JPEG, PNG, or WebP image.'
		);
	}
	if (file.size > QUICK_PUZZLE_MAX_UPLOAD_BYTES) {
		throw new QuickPuzzleValidationError('file-too-large', 'Image too large (max 20 MB).');
	}
}

function validatePieceCount(count: number, aspectRatio: PuzzleAspectRatio): void {
	if (
		!Number.isInteger(count) ||
		count < QUICK_PUZZLE_MIN_PIECES ||
		count > QUICK_PUZZLE_MAX_PIECES ||
		!isValidPieceCountForAspectRatio(count, aspectRatio)
	) {
		throw new QuickPuzzleValidationError(
			'piece-count-out-of-range',
			`Choose a valid ${aspectRatio} piece count between ${QUICK_PUZZLE_MIN_PIECES} and ${QUICK_PUZZLE_MAX_PIECES}.`
		);
	}
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') resolve(reader.result);
			else reject(new Error('FileReader did not return a string'));
		};
		reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
		reader.readAsDataURL(blob);
	});
}

async function decodeAndNormalize(
	file: File,
	pieceCount: number,
	aspectRatio: PuzzleAspectRatio
): Promise<{
	bitmap: ImageBitmap;
	width: number;
	height: number;
	imageDataUrl: string;
}> {
	let normalized;
	try {
		normalized = await normalizePuzzleImage(file, {
			aspectRatio,
			pieceCount,
			maxDimension: QUICK_PUZZLE_MAX_DIMENSION,
			type: 'image/jpeg',
			quality: QUICK_PUZZLE_JPEG_QUALITY
		});
	} catch (err) {
		if (err instanceof QuickPuzzleValidationError) throw err;
		throw new QuickPuzzleValidationError(
			'decode-failed',
			"Couldn't read this image. Try a different file."
		);
	}

	const imageDataUrl = await blobToDataUrl(normalized.blob);

	// Re-decode the downscaled blob so subsequent piece extraction operates on the
	// final, normalised pixel data (otherwise we'd pull from the larger source).
	const finalBitmap = await createImageBitmap(normalized.blob);

	return {
		bitmap: finalBitmap,
		width: normalized.width,
		height: normalized.height,
		imageDataUrl
	};
}

function buildPieceMeta(rows: number, cols: number, pieceCount: number): QuickPieceMeta[] {
	const pieces: QuickPieceMeta[] = [];
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const id = row * cols + col;
			if (id >= pieceCount) break;
			const edges: EdgeConfig = {
				top: getTopEdge(row, col, rows),
				right: getRightEdge(row, col, cols),
				bottom: getBottomEdge(row, col, rows),
				left: getLeftEdge(row, col, cols)
			};
			pieces.push({ id, correctX: col, correctY: row, edges });
		}
	}
	return pieces;
}

function generateId(): string {
	const uuid =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: Math.random().toString(36).slice(2) + Date.now().toString(36);
	return `${QUICK_PUZZLE_ID_PREFIX}${uuid}`;
}

export async function generateQuickPuzzle(
	file: File,
	pieceCount: number = QUICK_PUZZLE_DEFAULT_PIECES,
	name: string = '',
	options: GenerateOptions = {}
): Promise<GenerateResult> {
	validateUploadFile(file);
	const aspectRatio = options.aspectRatio ?? QUICK_PUZZLE_DEFAULT_ASPECT_RATIO;
	validatePieceCount(pieceCount, aspectRatio);

	const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
	const hasDomCanvas =
		typeof document !== 'undefined' && typeof document.createElement === 'function';
	if (typeof createImageBitmap === 'undefined' || (!hasOffscreen && !hasDomCanvas)) {
		throw new QuickPuzzleValidationError(
			'unsupported-browser',
			"Your browser doesn't support quick puzzles."
		);
	}

	const decoded = await decodeAndNormalize(file, pieceCount, aspectRatio);
	const { rows, cols } = getGridDimensionsForAspectRatio(pieceCount, aspectRatio);
	const pieces = buildPieceMeta(rows, cols, pieceCount);
	const pieceBlobUrls = new Map<number, string>();

	let done = 0;
	options.onProgress?.(done, pieces.length);

	try {
		for (const piece of pieces) {
			const bounds = computePieceBounds(piece.correctY, piece.correctX, {
				rows,
				cols,
				srcWidth: decoded.width,
				srcHeight: decoded.height
			});
			const url = await renderPiece(decoded.bitmap, piece, bounds);
			pieceBlobUrls.set(piece.id, url);
			done += 1;
			options.onProgress?.(done, pieces.length);
		}
	} catch (err) {
		// Revoke any piece URLs created before the failure to avoid leaking blob URLs.
		for (const u of pieceBlobUrls.values()) URL.revokeObjectURL(u);
		throw err;
	} finally {
		decoded.bitmap.close?.();
	}

	const stored: StoredQuickPuzzle = {
		id: generateId(),
		name: (name || 'Untitled').slice(0, 80),
		aspectRatio,
		pieceCount,
		gridRows: rows,
		gridCols: cols,
		imageWidth: decoded.width,
		imageHeight: decoded.height,
		imageDataUrl: decoded.imageDataUrl,
		pieces,
		createdAt: Date.now(),
		schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION
	};

	return { stored, pieceBlobUrls };
}
