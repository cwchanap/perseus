// Worker-compatible puzzle routes for public variant access

import { Hono } from 'hono';
import { stripIdempotencyKey } from '@perseus/types';
import type { Env } from '../worker';
import {
	getThumbnailKey,
	getPieceKey,
	getImage,
	getFamilyOriginalKey
} from '../services/storage.worker';
import { resolvePlayableVariant } from '../services/variant-playability.worker';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIECE_ID_REGEX = /^\d+$/; // Only non-negative base-10 integers
const MAX_PIECE_ID = 10000; // Validation ceiling, significantly above any expected piece count

function validatePuzzleId(id: string): boolean {
	return UUID_REGEX.test(id);
}

function validatePieceId(id: string): number | null {
	if (!PIECE_ID_REGEX.test(id)) {
		return null;
	}
	const num = parseInt(id, 10);
	if (num > MAX_PIECE_ID) {
		return null;
	}
	return num;
}

const puzzles = new Hono<{ Bindings: Env }>();
puzzles.get('/:id', async (c) => {
	const id = c.req.param('id');

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		const resolved = await resolvePlayableVariant(c.env.PUZZLE_METADATA, id);
		if (!resolved.playable) {
			if (resolved.status === 500) {
				console.error(`Failed to resolve family for puzzle ${id}:`, resolved.error);
				return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
			}
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}
		const { puzzle } = resolved;

		// Check R2 for original image existence rather than hardcoding true —
		// puzzles created before the reference-upload patch won't have the asset.
		// Degrade gracefully if R2 is unavailable — hasReference is display-only.
		// resolvePlayableVariant already fetched this variant's metadata, so the
		// reference key derives from puzzle.familyId without a redundant KV read.
		let hasReference = false;
		try {
			const originalObj = await c.env.PUZZLES_BUCKET.head(getFamilyOriginalKey(puzzle.familyId));
			hasReference = originalObj !== null;
		} catch (r2Error) {
			console.error(`Failed to check R2 reference for puzzle ${id}:`, r2Error);
		}

		// idempotencyKey is an admin/server-side dedup secret — never expose
		// it on public puzzle reads (clients could replay create with it).
		return c.json({ ...stripIdempotencyKey(puzzle), hasReference });
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
		const resolved = await resolvePlayableVariant(c.env.PUZZLE_METADATA, id);
		if (!resolved.playable) {
			if (resolved.status === 500) {
				console.error(`Failed to resolve family for puzzle ${id}:`, resolved.error);
				return c.json({ error: 'internal_error', message: 'Failed to retrieve thumbnail' }, 500);
			}
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}
		const { puzzle } = resolved;

		const image = await getImage(c.env.PUZZLES_BUCKET, getThumbnailKey(puzzle.familyId));

		if (!image) {
			// Thumbnail missing for puzzle marked ready — inconsistent state / asset missing
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

// GET /api/puzzles/:id/reference - Get reference image
puzzles.get('/:id/reference', async (c) => {
	const id = c.req.param('id');

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		const resolved = await resolvePlayableVariant(c.env.PUZZLE_METADATA, id);
		if (!resolved.playable) {
			if (resolved.status === 500) {
				console.error(`Failed to resolve family for puzzle ${id}:`, resolved.error);
				return c.json(
					{ error: 'internal_error', message: 'Failed to retrieve reference image' },
					500
				);
			}
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		const { puzzle } = resolved;

		// The reference key derives from the already-resolved variant metadata —
		// no redundant variant KV read.
		const referenceKey = getFamilyOriginalKey(puzzle.familyId);
		const image = await getImage(c.env.PUZZLES_BUCKET, referenceKey);

		if (!image) {
			return c.json({ error: 'not_found', message: 'Reference image not found' }, 404);
		}

		return new Response(image.data, {
			status: 200,
			headers: {
				'Content-Type': image.contentType,
				'Cache-Control': 'public, max-age=86400'
			}
		});
	} catch (error) {
		console.error(`Failed to retrieve reference image for puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve reference image' }, 500);
	}
});

// GET /api/puzzles/:id/pieces/:pieceId/image - Get piece image
puzzles.get('/:id/pieces/:pieceId/image', async (c) => {
	const id = c.req.param('id');
	const pieceIdStr = c.req.param('pieceId');
	const pieceId = validatePieceId(pieceIdStr);

	if (!validatePuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	if (pieceId === null) {
		return c.json({ error: 'invalid_piece_id', message: 'Invalid piece ID' }, 400);
	}

	try {
		const resolved = await resolvePlayableVariant(c.env.PUZZLE_METADATA, id);
		if (!resolved.playable) {
			if (resolved.status === 500) {
				console.error(`Failed to resolve family for puzzle ${id}:`, resolved.error);
				return c.json({ error: 'internal_error', message: 'Failed to retrieve piece image' }, 500);
			}
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}
		const { puzzle } = resolved;

		if (typeof puzzle.pieceCount !== 'number' || !Number.isFinite(puzzle.pieceCount)) {
			return c.json({ error: 'unavailable', message: 'Puzzle metadata incomplete' }, 409);
		}

		if (pieceId >= puzzle.pieceCount) {
			return c.json({ error: 'not_found', message: 'Piece not found' }, 404);
		}

		const image = await getImage(c.env.PUZZLES_BUCKET, getPieceKey(id, pieceId));

		if (!image) {
			// Piece image not found despite puzzle being 'ready' — piece may have failed generation or be missing
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

import complete from './puzzles.complete.worker';
puzzles.route('/', complete);

export default puzzles;
