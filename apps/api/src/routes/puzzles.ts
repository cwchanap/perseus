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
import {
	DEFAULT_PUZZLE_ASPECT_RATIO,
	aspectRatiosMatch,
	isPuzzleAspectRatio,
	stripIdempotencyKey
} from '@perseus/types';
import { generatePuzzle, isValidPieceCount } from '../services/puzzle-generator';
import { requirePlayerAuth } from '../middleware/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';
import { getDb } from '../db';
import { detectImageType, insertPuzzleOwnership, parseImageDimensions } from '@perseus/shared';
import { isPuzzleReady } from './puzzle-ready';

const puzzles = new Hono<{
	Variables: { playerSession: PlayerSessionRecord };
}>();
const DATA_DIR = process.env.DATA_DIR || './data';

const VALID_CATEGORIES = new Set(PUZZLE_CATEGORIES as readonly PuzzleCategory[]);

function getImageContentType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === '.png') return 'image/png';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	if (ext === '.webp') return 'image/webp';
	return 'application/octet-stream';
}

// Re-export so existing imports (`from './puzzles'`) keep working. The
// definition lives in ./puzzle-ready to avoid a circular import with
// puzzles.complete.ts (which needs isPuzzleReady but is mounted by this file).
export { isPuzzleReady } from './puzzle-ready';

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
//
// Intentionally NO server-side idempotency (unlike the admin upload path in
// routes/admin.ts, which reserves an Idempotency-Key in PuzzleMetadataDO /
// the filesystem before minting a UUID). Player uploads are interactive and
// low-volume: a retried request after a lost response will create a distinct
// puzzle (fresh crypto.randomUUID() below). The player simply sees the new
// puzzle in their gallery. Wiring the full reserve/commit lifecycle here is
// deferred until duplicate player uploads become a real problem — it adds the
// DO reservation, transition endpoints, and ownership-rollback coupling that
// the admin path carries, for little gain at this volume.
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
				createdAt: Date.now()
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

	// idempotencyKey is an admin/server-side dedup secret — never expose it
	// on public puzzle reads (clients could replay create with it).
	return c.json({ ...stripIdempotencyKey(puzzle), hasReference: puzzleHasReference(id) });
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
