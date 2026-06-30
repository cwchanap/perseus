// Puzzle routes for public access
import { Hono } from 'hono';
import {
	createPuzzle as storePuzzle,
	deletePuzzle as deleteStoredPuzzle,
	getPuzzle,
	listPuzzlesPage,
	getThumbnailPath,
	getPieceImagePath,
	getOriginalImagePath,
	getPuzzleDir,
	findOriginalImagePath,
	InvalidPuzzleIdError
} from '../services/storage';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE, PUZZLE_CATEGORIES } from '../types/index';
import type { PuzzleCategory } from '../types/index';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DEFAULT_PUZZLE_ASPECT_RATIO, isPuzzleAspectRatio } from '@perseus/types';
import { generatePuzzle, isValidPieceCount } from '../services/puzzle-generator';
import { isPuzzleReady } from '../utils/puzzleReady';
import { requirePlayerAuth } from '../middleware/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';
import { getDb } from '../db';
import { insertPuzzleOwnership } from '@perseus/shared';

const puzzles = new Hono<{
	Variables: { playerSession: PlayerSessionRecord };
}>();
const DATA_DIR = process.env.DATA_DIR || './data';

const VALID_CATEGORIES = new Set(PUZZLE_CATEGORIES as readonly PuzzleCategory[]);

/* v8 ignore start -- duplicated admin upload validation helpers; covered by admin tests */
// Detect image MIME type from magic bytes
async function detectImageType(file: File | Blob): Promise<string | null> {
	try {
		const header = await file.slice(0, 12).arrayBuffer();
		const bytes = new Uint8Array(header);
		if (bytes.length < 4) return null;

		if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
			return 'image/jpeg';
		}
		if (
			bytes[0] === 0x89 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x4e &&
			bytes[3] === 0x47 &&
			bytes.length >= 8 &&
			bytes[4] === 0x0d &&
			bytes[5] === 0x0a &&
			bytes[6] === 0x1a &&
			bytes[7] === 0x0a
		) {
			return 'image/png';
		}
		if (
			bytes.length >= 12 &&
			bytes[0] === 0x52 &&
			bytes[1] === 0x49 &&
			bytes[2] === 0x46 &&
			bytes[3] === 0x46 &&
			bytes[8] === 0x57 &&
			bytes[9] === 0x45 &&
			bytes[10] === 0x42 &&
			bytes[11] === 0x50
		) {
			return 'image/webp';
		}
		return null;
	} catch (error) {
		console.error('Failed to detect image type from file bytes:', error);
		return null;
	}
}

// Parse image width/height from binary headers without decoding the full image
async function parseImageDimensions(
	file: File | Blob,
	mimeType: string
): Promise<{ width: number; height: number } | null> {
	try {
		if (mimeType === 'image/png') {
			const header = await file.slice(16, 24).arrayBuffer();
			if (header.byteLength < 8) return null;
			const view = new DataView(header);
			return { width: view.getUint32(0), height: view.getUint32(4) };
		}

		if (mimeType === 'image/jpeg') {
			const buf = await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer();
			const bytes = new Uint8Array(buf);
			let offset = 2;
			while (offset < bytes.length - 8) {
				if (bytes[offset] !== 0xff) break;
				const marker = bytes[offset + 1];
				if (marker === 0xda || marker === 0xd9) break;
				if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
					offset += 2;
					continue;
				}
				if (
					(marker >= 0xc0 && marker <= 0xc3) ||
					(marker >= 0xc5 && marker <= 0xc7) ||
					(marker >= 0xc9 && marker <= 0xcb) ||
					(marker >= 0xcd && marker <= 0xcf)
				) {
					const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
					if (segLen < 9 || offset + 9 > bytes.length) return null;
					const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
					const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
					return { width, height };
				}
				if (offset + 4 > bytes.length) break;
				const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
				offset += 2 + segLen;
			}
			return null;
		}

		if (mimeType === 'image/webp') {
			const header = await file.slice(12, 34).arrayBuffer();
			if (header.byteLength < 8) return null;
			const decoder = new TextDecoder();
			const fourCC = decoder.decode(new Uint8Array(header, 0, 4));
			if (fourCC === 'VP8 ') {
				if (header.byteLength < 18) return null;
				const view = new DataView(header);
				const w = view.getUint16(14, true) & 0x3fff;
				const h = view.getUint16(16, true) & 0x3fff;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8L') {
				if (header.byteLength < 13) return null;
				const b = new DataView(header).getUint32(9, true);
				const w = (b & 0x3fff) + 1;
				const h = ((b >> 14) & 0x3fff) + 1;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8X') {
				if (header.byteLength < 18) return null;
				const bytes = new Uint8Array(header);
				const w = (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16)) + 1;
				const h = (bytes[15] | (bytes[16] << 8) | (bytes[17] << 16)) + 1;
				return { width: w, height: h };
			}
			return null;
		}

		return null;
	} catch (error) {
		console.error('Failed to parse image dimensions:', error);
		return null;
	}
}

const ASPECT_RATIO_TOLERANCE = 0.05;

function aspectRatiosMatch(imageWidth: number, imageHeight: number, targetRatio: string): boolean {
	const parts = targetRatio.split(':').map(Number);
	const targetW = parts[0];
	const targetH = parts[1];
	const actual = imageWidth / imageHeight;
	const expected = targetW / targetH;
	return Math.abs(actual - expected) / expected <= ASPECT_RATIO_TOLERANCE;
}
/* v8 ignore stop */

function getImageContentType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === '.png') return 'image/png';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	if (ext === '.webp') return 'image/webp';
	return 'application/octet-stream';
}

function puzzleHasReference(puzzleId: string): boolean {
	try {
		return findOriginalImagePath(puzzleId) !== null;
	} catch (error) {
		if (error instanceof InvalidPuzzleIdError) {
			return false;
		}
		console.error(`Unexpected error checking reference image for puzzle ${puzzleId}:`, error);
		return false;
	}
}

// GET /api/puzzles - List all puzzles
puzzles.get('/', async (c) => {
	const q = c.req.query('q') || undefined;

	const categoryParam = c.req.query('category');
	const category =
		categoryParam && VALID_CATEGORIES.has(categoryParam as PuzzleCategory)
			? (categoryParam as PuzzleCategory)
			: undefined;

	const DECIMAL_INT = /^\d+$/;
	const rawOffsetStr = c.req.query('offset') ?? '0';
	const rawOffset = DECIMAL_INT.test(rawOffsetStr) ? Number(rawOffsetStr) : NaN;
	const offset = !isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

	const rawLimitStr = c.req.query('limit') ?? '20';
	const rawLimit = DECIMAL_INT.test(rawLimitStr) ? Number(rawLimitStr) : NaN;
	const limit = !isNaN(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;

	const cursor = c.req.query('cursor') || undefined;

	try {
		const result = await listPuzzlesPage({ q, category, offset, limit, cursor });
		return c.json(result);
	} catch (error) {
		console.error('Failed to list puzzles', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// POST /api/puzzles - Create a server puzzle for the signed-in player
puzzles.post('/', requirePlayerAuth, async (c) => {
	let puzzleDirCreated = false;
	let id = '';

	try {
		let formData: FormData;
		try {
			formData = await c.req.formData();
		} catch (error) {
			console.error('Failed to parse puzzle form data', error);
			return c.json({ error: 'bad_request', message: 'Invalid form data' }, 400);
		}
		const name = formData.get('name');
		const pieceCountStr = formData.get('pieceCount');
		const aspectRatioStr = formData.get('aspectRatio');
		const image = formData.get('image') as File | string | null;

		if (!name || typeof name !== 'string' || name.trim().length === 0) {
			return c.json({ error: 'bad_request', message: 'Name is required' }, 400);
		}

		const trimmedName = name.trim();
		if (trimmedName.length > 255) {
			return c.json({ error: 'bad_request', message: 'Name must be at most 255 characters' }, 400);
		}

		if (!pieceCountStr) {
			return c.json({ error: 'bad_request', message: 'Piece count is required' }, 400);
		}

		const aspectRatio =
			typeof aspectRatioStr === 'string' && aspectRatioStr.trim().length > 0
				? aspectRatioStr.trim()
				: DEFAULT_PUZZLE_ASPECT_RATIO;
		if (!isPuzzleAspectRatio(aspectRatio)) {
			return c.json(
				{
					error: 'bad_request',
					message: 'Invalid aspect ratio. Allowed: 1:1, 4:3, 3:4'
				},
				400
			);
		}

		const pieceCount = Number(pieceCountStr.toString());
		if (!Number.isInteger(pieceCount) || !isValidPieceCount(pieceCount, aspectRatio)) {
			return c.json(
				{
					error: 'bad_request',
					message: `Invalid piece count for ${aspectRatio}`
				},
				400
			);
		}

		if (!image || !(image instanceof File)) {
			return c.json({ error: 'bad_request', message: 'Image file is required' }, 400);
		}

		const categoryStr = formData.get('category');
		let category: PuzzleCategory | undefined;
		if (categoryStr && typeof categoryStr === 'string' && categoryStr.trim().length > 0) {
			const trimmedCategory = categoryStr.trim();
			if (!(PUZZLE_CATEGORIES as readonly string[]).includes(trimmedCategory)) {
				return c.json(
					{
						error: 'bad_request',
						message: `Invalid category. Allowed: ${PUZZLE_CATEGORIES.join(', ')}`
					},
					400
				);
			}
			category = trimmedCategory as PuzzleCategory;
		}

		if (image.size > MAX_FILE_SIZE) {
			return c.json({ error: 'bad_request', message: 'File size exceeds 10MB limit' }, 400);
		}

		const detectedType = await detectImageType(image);
		if (
			!detectedType ||
			!ALLOWED_MIME_TYPES.includes(detectedType as (typeof ALLOWED_MIME_TYPES)[number])
		) {
			return c.json(
				{ error: 'bad_request', message: 'Invalid file type. Allowed: JPEG, PNG, WebP' },
				400
			);
		}

		const dimensions = await parseImageDimensions(image, detectedType);
		if (dimensions) {
			if (!aspectRatiosMatch(dimensions.width, dimensions.height, aspectRatio)) {
				return c.json(
					{
						error: 'bad_request',
						message: `Image aspect ratio (${dimensions.width}x${dimensions.height}) does not match requested ratio ${aspectRatio}. Please pre-crop the image to match.`
					},
					400
				);
			}
		} else {
			console.warn(
				`Could not parse dimensions for ${detectedType} image; skipping aspect-ratio validation`
			);
		}

		id = crypto.randomUUID();
		const imageBuffer = Buffer.from(await image.arrayBuffer());

		await mkdir(getPuzzleDir(id), { recursive: true });
		puzzleDirCreated = true;
		await writeFile(getOriginalImagePath(id, detectedType), imageBuffer);

		const result = await generatePuzzle({
			id,
			name: trimmedName,
			pieceCount,
			aspectRatio,
			imageBuffer,
			outputDir: `${DATA_DIR}/puzzles`
		});

		const puzzleToStore = category ? { ...result.puzzle, category } : result.puzzle;
		const saved = await storePuzzle(puzzleToStore);
		if (!saved) {
			const cleaned = await deleteStoredPuzzle(id);
			if (!cleaned) {
				console.error(`Failed to clean up puzzle directory ${id} after metadata save failure`);
			}
			return c.json({ error: 'internal_error', message: 'Failed to save puzzle metadata' }, 500);
		}

		// Ownership is a hard requirement: a committed puzzle without an owner
		// row is invisible to the player. On failure, roll back the saved puzzle
		// and fail the request instead of returning success.
		try {
			await insertPuzzleOwnership(getDb(), {
				id,
				ownerId: c.get('playerSession').user.id,
				name: trimmedName,
				pieceCount,
				...(category ? { category } : {}),
				status: 'ready',
				createdAt: puzzleToStore.createdAt
			});
		} catch (error) {
			console.error('Failed to record puzzle ownership:', error);
			const cleaned = await deleteStoredPuzzle(id);
			if (!cleaned) {
				console.error(`Failed to clean up puzzle directory ${id} after ownership insert failure`);
			}
			return c.json({ error: 'internal_error', message: 'Failed to record puzzle ownership' }, 500);
		}

		return c.json(puzzleToStore, 201);
	} catch (error) {
		console.error('Error creating puzzle:', error);
		if (puzzleDirCreated) {
			try {
				await deleteStoredPuzzle(id);
			} catch (cleanupError) {
				console.error('Failed to clean up puzzle directory after error:', cleanupError);
			}
		}
		return c.json({ error: 'internal_error', message: 'Failed to create puzzle' }, 500);
	}
});

// GET /api/puzzles/:id - Get puzzle details
puzzles.get('/:id', async (c) => {
	const id = c.req.param('id');
	let puzzle: Awaited<ReturnType<typeof getPuzzle>>;

	try {
		puzzle = await getPuzzle(id);
	} catch (error) {
		console.error('Failed to retrieve puzzle');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
	}

	if (!puzzle) {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	if (!isPuzzleReady(puzzle)) {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	return c.json({ ...puzzle, hasReference: puzzleHasReference(id) });
});

// GET /api/puzzles/:id/thumbnail - Get puzzle thumbnail image
puzzles.get('/:id/thumbnail', async (c) => {
	const id = c.req.param('id');
	try {
		const puzzle = await getPuzzle(id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		const thumbnailPath = getThumbnailPath(id);
		const imageData = await readFile(thumbnailPath);
		return c.body(imageData, 200, {
			'Content-Type': getImageContentType(thumbnailPath),
			'Cache-Control': 'public, max-age=86400'
		});
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT' || error instanceof InvalidPuzzleIdError) {
			return c.json({ error: 'not_found', message: 'Thumbnail not found' }, 404);
		}
		console.error('Failed to retrieve thumbnail');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to retrieve thumbnail' }, 500);
	}
});

// GET /api/puzzles/:id/reference - Get reference image
puzzles.get('/:id/reference', async (c) => {
	const id = c.req.param('id');
	try {
		const puzzle = await getPuzzle(id);

		if (!puzzle || !isPuzzleReady(puzzle)) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		const originalPath = findOriginalImagePath(id);
		if (!originalPath) {
			return c.json({ error: 'not_found', message: 'Reference image not found' }, 404);
		}
		const imageData = await readFile(originalPath);
		return c.body(imageData, 200, {
			'Content-Type': getImageContentType(originalPath),
			'Cache-Control': 'public, max-age=86400'
		});
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT' || error instanceof InvalidPuzzleIdError) {
			return c.json({ error: 'not_found', message: 'Reference image not found' }, 404);
		}
		console.error('Failed to retrieve reference image');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to retrieve reference image' }, 500);
	}
});

// GET /api/puzzles/:id/pieces/:pieceId/image - Get piece image
puzzles.get('/:id/pieces/:pieceId/image', async (c) => {
	const id = c.req.param('id');
	const pieceIdStr = c.req.param('pieceId');
	const pieceId = parseInt(pieceIdStr, 10);

	if (isNaN(pieceId) || pieceId < 0) {
		return c.json({ error: 'invalid_piece_id', message: 'Invalid piece ID' }, 400);
	}

	let puzzle: Awaited<ReturnType<typeof getPuzzle>>;

	try {
		puzzle = await getPuzzle(id);
	} catch (error) {
		console.error('Failed to retrieve puzzle');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
	}

	if (!puzzle) {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	if (pieceId >= puzzle.pieceCount) {
		return c.json({ error: 'not_found', message: 'Piece not found' }, 404);
	}

	try {
		const piecePath = getPieceImagePath(id, pieceId);
		const imageData = await readFile(piecePath);
		return c.body(imageData, 200, {
			'Content-Type': getImageContentType(piecePath),
			'Cache-Control': 'public, max-age=86400'
		});
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT' || error instanceof InvalidPuzzleIdError) {
			return c.json({ error: 'not_found', message: 'Piece image not found' }, 404);
		}
		console.error('Failed to retrieve piece image');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to retrieve piece image' }, 500);
	}
});

import complete from './puzzles.complete';
puzzles.route('/', complete);

export default puzzles;
