// Worker-compatible puzzle routes for public access

import { Hono } from 'hono';
import type { Env } from '../worker';
import {
	getPuzzle,
	listPuzzles,
	getThumbnailKey,
	getPieceKey,
	getImage
} from '../services/storage.worker';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PIECE_ID = 10000; // Well above MAX_PIECES (250)

function validatePuzzleId(id: string): boolean {
	return UUID_REGEX.test(id);
}

const puzzles = new Hono<{ Bindings: Env }>();

// GET /api/puzzles - List all puzzles
puzzles.get('/', async (c) => {
	try {
		const puzzleList = await listPuzzles(c.env.PUZZLE_METADATA);
		return c.json({ puzzles: puzzleList });
	} catch (error) {
		console.error('Failed to list puzzles', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// GET /api/puzzles/:id - Get puzzle details
puzzles.get('/:id', async (c) => {
	const id = c.req.param('id');

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		return c.json(puzzle);
	} catch (error) {
		console.error(`Failed to retrieve puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
	}
});

// GET /api/puzzles/:id/thumbnail - Get puzzle thumbnail image
puzzles.get('/:id/thumbnail', async (c) => {
	const id = c.req.param('id');

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, getThumbnailKey(id));

		if (!image) {
			// Thumbnail not yet generated (puzzle may be processing)
			return c.json({ error: 'not_found', message: 'Thumbnail not found' }, 404);
		}

		return new Response(image.data, {
			status: 200,
			headers: {
				'Content-Type': image.contentType,
				'Cache-Control': 'public, max-age=86400'
			}
		});
	} catch (error) {
		console.error(`Failed to retrieve thumbnail for puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve thumbnail' }, 500);
	}
});

// GET /api/puzzles/:id/pieces/:pieceId/image - Get piece image
puzzles.get('/:id/pieces/:pieceId/image', async (c) => {
	const id = c.req.param('id');
	const pieceIdStr = c.req.param('pieceId');
	const pieceId = parseInt(pieceIdStr, 10);

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	if (isNaN(pieceId) || pieceId < 0 || pieceId > MAX_PIECE_ID) {
		return c.json({ error: 'invalid_piece_id', message: 'Invalid piece ID' }, 400);
	}

	try {
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		if (pieceId >= puzzle.pieceCount) {
			return c.json({ error: 'not_found', message: 'Piece not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, getPieceKey(id, pieceId));

		if (!image) {
			// Piece not yet generated (puzzle may be processing)
			return c.json({ error: 'not_found', message: 'Piece image not found' }, 404);
		}

		return new Response(image.data, {
			status: 200,
			headers: {
				'Content-Type': image.contentType,
				'Cache-Control': 'public, max-age=86400'
			}
		});
	} catch (error) {
		console.error(`Failed to retrieve piece ${pieceId} for puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve piece image' }, 500);
	}
});

export default puzzles;
