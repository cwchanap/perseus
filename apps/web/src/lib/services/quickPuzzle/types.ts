import type { EdgeConfig, PuzzleAspectRatio } from '@perseus/types';

export interface QuickPieceMeta {
	id: number; // row * cols + col
	correctX: number; // col
	correctY: number; // row
	edges: EdgeConfig;
}

export interface StoredQuickPuzzle {
	id: string; // 'q-' + crypto.randomUUID()
	name: string; // derived from filename, max 80 chars
	aspectRatio?: PuzzleAspectRatio;
	pieceCount: number;
	gridRows: number;
	gridCols: number;
	imageWidth: number; // post-downscale
	imageHeight: number;
	imageDataUrl: string; // JPEG, base64
	pieces: QuickPieceMeta[];
	createdAt: number; // epoch ms
	schemaVersion: 1;
}

export interface QuickPuzzleIndex {
	ids: string[]; // newest first; max length 5
	schemaVersion: 1;
}

export type QuickPuzzleValidationCode =
	| 'invalid-mime'
	| 'file-too-large'
	| 'piece-count-out-of-range'
	| 'decode-failed'
	| 'unsupported-browser';

export class QuickPuzzleValidationError extends Error {
	constructor(
		public code: QuickPuzzleValidationCode,
		message: string
	) {
		super(message);
		this.name = 'QuickPuzzleValidationError';
	}
}

// Constants
export const QUICK_PUZZLE_INDEX_KEY = 'quickPuzzle:index';
export const QUICK_PUZZLE_KEY_PREFIX = 'quickPuzzle:';
export const QUICK_PUZZLE_MAX_COUNT = 5;
export const QUICK_PUZZLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const QUICK_PUZZLE_SCHEMA_VERSION = 1 as const;
export const QUICK_PUZZLE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
export const QUICK_PUZZLE_MAX_DIMENSION = 1200; // longest side in px after downscale
export const QUICK_PUZZLE_JPEG_QUALITY = 0.8;
export const QUICK_PUZZLE_MIN_PIECES = 4;
export const QUICK_PUZZLE_MAX_PIECES = 100;
export const QUICK_PUZZLE_DEFAULT_ASPECT_RATIO: PuzzleAspectRatio = '1:1';
export const QUICK_PUZZLE_DEFAULT_PIECES = 16;
export const QUICK_PUZZLE_ID_PREFIX = 'q-';
export const QUICK_PUZZLE_ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
