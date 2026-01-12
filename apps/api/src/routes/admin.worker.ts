// Worker-compatible admin routes for authentication and puzzle management

import { Hono } from 'hono';
import type { Env } from '../worker';
import {
	createPuzzleMetadata,
	deletePuzzleMetadata,
	deletePuzzleAssets,
	puzzleExists,
	uploadOriginalImage,
	type PuzzleMetadata
} from '../services/storage.worker';
import {
	createSession,
	setSessionCookie,
	clearSessionCookie,
	getSessionToken,
	verifySession,
	requireAuth
} from '../middleware/auth.worker';
import { loginRateLimit, resetLoginAttempts } from '../middleware/rate-limit.worker';

const admin = new Hono<{ Bindings: Env }>();

// Constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_PIECE_COUNT = 225; // 15x15 grid

// POST /api/admin/login - Admin login
admin.post('/login', loginRateLimit, async (c) => {
	try {
		const body = await c.req.json();
		const { passkey } = body as { passkey?: string };

		if (!passkey) {
			return c.json({ error: 'bad_request', message: 'Passkey is required' }, 400);
		}

		// Use WebCrypto for constant-time comparison
		const encoder = new TextEncoder();
		const passkeyBytes = encoder.encode(passkey);
		const expectedBytes = encoder.encode(c.env.ADMIN_PASSKEY);

		// Hash both for constant-time comparison
		const passkeyHash = await crypto.subtle.digest('SHA-256', passkeyBytes);
		const expectedHash = await crypto.subtle.digest('SHA-256', expectedBytes);

		// Compare hashes (timing-safe via equal length comparison)
		const passkeyArr = new Uint8Array(passkeyHash);
		const expectedArr = new Uint8Array(expectedHash);

		let isValid = passkeyArr.length === expectedArr.length;
		for (let i = 0; i < passkeyArr.length; i++) {
			isValid = isValid && passkeyArr[i] === expectedArr[i];
		}

		if (!isValid) {
			return c.json({ error: 'unauthorized', message: 'Invalid passkey' }, 401);
		}

		const token = await createSession(c.env, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		setSessionCookie(c, token);
		resetLoginAttempts(c);

		return c.json({ success: true });
	} catch (error) {
		console.error('Failed to process admin login', error);
		return c.json({ error: 'internal_error', message: 'Failed to process login' }, 500);
	}
});

// POST /api/admin/logout - Admin logout
admin.post('/logout', async (c) => {
	clearSessionCookie(c);
	return c.json({ success: true });
});

// GET /api/admin/session - Check admin session
admin.get('/session', async (c) => {
	const token = getSessionToken(c);

	if (!token) {
		return c.json({ authenticated: false });
	}

	const session = await verifySession(c.env, token);

	if (!session) {
		clearSessionCookie(c);
		return c.json({ authenticated: false });
	}

	return c.json({ authenticated: true });
});

// POST /api/admin/puzzles - Create new puzzle (protected)
admin.post('/puzzles', requireAuth, async (c) => {
	try {
		const formData = await c.req.formData();
		const name = formData.get('name');
		const pieceCountStr = formData.get('pieceCount');
		const image = formData.get('image');

		// Validate name
		if (!name || typeof name !== 'string' || name.trim().length === 0) {
			return c.json({ error: 'bad_request', message: 'Name is required' }, 400);
		}

		const trimmedName = name.trim();
		if (trimmedName.length > 255) {
			return c.json({ error: 'bad_request', message: 'Name must be at most 255 characters' }, 400);
		}

		// Validate piece count (only 225 allowed for now)
		if (!pieceCountStr) {
			return c.json({ error: 'bad_request', message: 'Piece count is required' }, 400);
		}

		const pieceCount = parseInt(pieceCountStr.toString(), 10);
		if (pieceCount !== ALLOWED_PIECE_COUNT) {
			return c.json(
				{
					error: 'bad_request',
					message: `Invalid piece count. Only ${ALLOWED_PIECE_COUNT} pieces allowed`
				},
				400
			);
		}

		// Validate image
		if (!image || !(image instanceof File)) {
			return c.json({ error: 'bad_request', message: 'Image file is required' }, 400);
		}

		if (image.size > MAX_FILE_SIZE) {
			return c.json({ error: 'bad_request', message: 'File size exceeds 10MB limit' }, 400);
		}

		if (!ALLOWED_MIME_TYPES.includes(image.type)) {
			return c.json(
				{ error: 'bad_request', message: 'Invalid file type. Allowed: JPEG, PNG, WebP' },
				400
			);
		}

		// Generate puzzle ID
		const id = crypto.randomUUID();

		// Calculate grid dimensions
		const sqrt = Math.sqrt(pieceCount);
		const gridCols = sqrt;
		const gridRows = sqrt;

		// Create initial puzzle metadata with processing status
		const puzzleMetadata: PuzzleMetadata = {
			id,
			name: trimmedName,
			pieceCount,
			gridCols,
			gridRows,
			imageWidth: 0, // Will be set by workflow
			imageHeight: 0, // Will be set by workflow
			createdAt: Date.now(),
			status: 'processing',
			progress: {
				totalPieces: pieceCount,
				generatedPieces: 0,
				updatedAt: Date.now()
			},
			pieces: []
		};

		// Store metadata in KV
		await createPuzzleMetadata(c.env.PUZZLE_METADATA, puzzleMetadata);

		// Upload original image to R2
		const imageBuffer = await image.arrayBuffer();
		await uploadOriginalImage(c.env.PUZZLES_BUCKET, id, imageBuffer, image.type);

		// Trigger workflow for puzzle generation
		await c.env.PUZZLE_WORKFLOW.create({
			id,
			params: { puzzleId: id }
		});

		return c.json(puzzleMetadata, 201);
	} catch (error) {
		console.error('Error creating puzzle:', error);
		return c.json({ error: 'internal_error', message: 'Failed to create puzzle' }, 500);
	}
});

// DELETE /api/admin/puzzles/:id - Delete puzzle (protected)
admin.delete('/puzzles/:id', requireAuth, async (c) => {
	const id = c.req.param('id');

	const exists = await puzzleExists(c.env.PUZZLE_METADATA, id);

	if (!exists) {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	// Get puzzle to know piece count for asset deletion
	const { getPuzzle } = await import('../services/storage.worker');
	const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

	// Delete assets from R2
	if (puzzle) {
		await deletePuzzleAssets(c.env.PUZZLES_BUCKET, id, puzzle.pieceCount);
	}

	// Delete metadata from KV
	const deleted = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);

	if (!deleted) {
		return c.json({ error: 'internal_error', message: 'Failed to delete puzzle' }, 500);
	}

	return c.body(null, 204);
});

export default admin;
