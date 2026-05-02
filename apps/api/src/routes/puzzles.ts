// Puzzle routes for public access
import { Hono } from 'hono';
import {
	getPuzzle,
	listPuzzlesPage,
	getThumbnailPath,
	getPieceImagePath,
	findOriginalImagePath,
	InvalidPuzzleIdError
} from '../services/storage';
import { PUZZLE_CATEGORIES } from '../types/index';
import type { PuzzleCategory } from '../types/index';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const puzzles = new Hono();

const VALID_CATEGORIES = new Set(PUZZLE_CATEGORIES as readonly PuzzleCategory[]);

function getImageContentType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === '.png') return 'image/png';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	if (ext === '.webp') return 'image/webp';
	return 'application/octet-stream';
}

function isPuzzleReady(puzzle: unknown): boolean {
	if (typeof puzzle !== 'object' || puzzle === null) {
		return false;
	}

	const candidate = puzzle as { ready?: boolean; status?: string };

	if (typeof candidate.ready === 'boolean') {
		return candidate.ready;
	}

	if (typeof candidate.status === 'string') {
		return candidate.status === 'ready';
	}

	// Bun dev server returns legacy Puzzle shape (no ready/status fields).
	// If a puzzle exists on the filesystem, it's inherently ready — there's no async workflow.
	return true;
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

	const rawOffset = Number(c.req.query('offset') ?? '0');
	const offset =
		Number.isFinite(rawOffset) && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

	const rawLimit = Number(c.req.query('limit') ?? '20');
	const limit =
		Number.isFinite(rawLimit) && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100
			? rawLimit
			: 20;

	const cursor = c.req.query('cursor') || undefined;

	try {
		const result = await listPuzzlesPage({ q, category, offset, limit, cursor });
		return c.json(result);
	} catch (error) {
		console.error('Failed to list puzzles', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
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

export default puzzles;
