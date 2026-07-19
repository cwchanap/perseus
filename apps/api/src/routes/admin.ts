// Admin routes for authentication and puzzle management
import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import {
	createSession,
	setSessionCookie,
	clearSessionCookie,
	getSessionToken,
	verifySession,
	requireAuth
} from '../middleware/auth';
import { loginRateLimit, resetLoginAttempts } from '../middleware/rate-limit';
import {
	addAllowlistEntry,
	deleteAllowlistEntry,
	getPlayerByEmail,
	listAllowlistEntries,
	revokePlayerSessionsForEmail
} from '../services/player-auth';
import { generatePuzzle, isValidPieceCount } from '../services/puzzle-generator';
import {
	createPuzzle as storePuzzle,
	deletePuzzle as deleteStoredPuzzle,
	getPuzzle,
	listPuzzles,
	getOriginalImagePath,
	getPuzzleDir,
	puzzleExists,
	releaseIdempotencyKey,
	reserveIdempotencyKey
} from '../services/storage';
import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES, PUZZLE_CATEGORIES } from '../types';
import type { PuzzleCategory } from '../types';
import {
	DEFAULT_PUZZLE_ASPECT_RATIO,
	aspectRatiosMatch,
	isPuzzleAspectRatio,
	stripIdempotencyKey
} from '@perseus/types';
import { getDb } from '../db';
import {
	deletePuzzleOwnership,
	deletePuzzleStats,
	detectImageType,
	insertPuzzleOwnership,
	parseImageDimensions,
	SYSTEM_OWNER_ID
} from '@perseus/shared';

const admin = new Hono();

const ADMIN_PASSKEY = (() => {
	const passkey = process.env.ADMIN_PASSKEY;
	if (!passkey) {
		throw new Error('ADMIN_PASSKEY environment variable is required');
	}
	return passkey;
})();

const ADMIN_PASSKEY_DIGEST = createHash('sha256').update(ADMIN_PASSKEY).digest();
const DATA_DIR = process.env.DATA_DIR || './data';

// POST /api/admin/login - Admin login
admin.post('/login', loginRateLimit, async (c) => {
	try {
		const body = await c.req.json();
		const { passkey } = body as { passkey?: string };

		if (!passkey) {
			return c.json({ error: 'bad_request', message: 'Passkey is required' }, 400);
		}

		const passkeyDigest = createHash('sha256').update(passkey).digest();
		const isValidPasskey = timingSafeEqual(passkeyDigest, ADMIN_PASSKEY_DIGEST);

		if (!isValidPasskey) {
			return c.json({ error: 'unauthorized', message: 'Invalid passkey' }, 401);
		}

		const token = await createSession({
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		setSessionCookie(c, token);
		resetLoginAttempts(c);

		return c.json({ success: true });
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err && (err.name === 'SyntaxError' || err.code === 'ERR_INVALID_ARG_TYPE')) {
			return c.json({ error: 'bad_request', message: 'Invalid request body' }, 400);
		}

		console.error('Failed to process admin login');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
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

	const session = await verifySession(token);

	if (!session) {
		clearSessionCookie(c);
		return c.json({ authenticated: false });
	}

	return c.json({ authenticated: true });
});

// GET /api/admin/player-allowlist - List player allowlist entries (protected)
admin.get('/player-allowlist', requireAuth, async (c) => {
	try {
		const allowlistEntries = await listAllowlistEntries();
		const entries = await Promise.all(
			allowlistEntries.map(async (entry) => {
				const player = await getPlayerByEmail(entry.email);
				return player ? { ...entry, player } : entry;
			})
		);

		return c.json({ entries });
	} catch (error) {
		console.error('Failed to list player allowlist entries', error);
		return c.json({ error: 'internal_error', message: 'Failed to list player allowlist' }, 500);
	}
});

// POST /api/admin/player-allowlist - Add a player allowlist entry (protected)
admin.post('/player-allowlist', requireAuth, async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}

	const email = (body as { email?: unknown })?.email;
	if (typeof email !== 'string') {
		return c.json({ error: 'bad_request', message: 'Email is required' }, 400);
	}

	try {
		const entry = await addAllowlistEntry(email, 'admin');
		return c.json({ entry });
	} catch (error) {
		if (error instanceof Error && error.message === 'Invalid email') {
			return c.json({ error: 'bad_request', message: 'Enter a valid email address' }, 400);
		}

		console.error('Failed to add player allowlist entry', error);
		return c.json(
			{ error: 'internal_error', message: 'Failed to add player allowlist entry' },
			500
		);
	}
});

// DELETE /api/admin/player-allowlist/:email - Remove a player allowlist entry (protected)
admin.delete('/player-allowlist/:email', requireAuth, async (c) => {
	const email = c.req.param('email');

	try {
		await revokePlayerSessionsForEmail(email);
		await deleteAllowlistEntry(email);
		return c.json({ success: true });
	} catch (error) {
		if (error instanceof Error && error.message === 'Invalid email') {
			return c.json({ error: 'bad_request', message: 'Enter a valid email address' }, 400);
		}

		console.error('Failed to delete player allowlist entry', error);
		return c.json(
			{ error: 'internal_error', message: 'Failed to delete player allowlist entry' },
			500
		);
	}
});

// GET /api/admin/puzzles - List all puzzles for admin
admin.get('/puzzles', requireAuth, async (c) => {
	try {
		const puzzleList = await listPuzzles();
		return c.json({ puzzles: puzzleList });
	} catch (error) {
		console.error('Failed to list puzzles for admin', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// POST /api/admin/puzzles - Create new puzzle (protected)
admin.post('/puzzles', requireAuth, async (c) => {
	let puzzleDirCreated = false;
	let id = '';
	let reservedIdempotencyKey: string | undefined;

	try {
		const formData = await c.req.formData();
		const name = formData.get('name');
		const pieceCountStr = formData.get('pieceCount');
		const aspectRatioStr = formData.get('aspectRatio');
		const image = formData.get('image') as File | string | null;

		// Validate required fields
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

		// Validate optional category
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

		// Validate file size
		if (image.size > MAX_FILE_SIZE) {
			return c.json({ error: 'bad_request', message: 'File size exceeds 10MB limit' }, 400);
		}

		// Validate file type via magic bytes instead of trusting image.type
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

		// Validate that image dimensions match the requested aspect ratio
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
		}
		// If dimensions can't be parsed, proceed — the generator will use actual pixel dimensions

		// Server-side idempotency: reserve the key atomically before minting a
		// UUID or creating assets. Exclusive file create closes the concurrent-
		// POST race that a post-create filesystem scan cannot. Without the
		// header, behavior is unchanged (fresh UUID per POST).
		const idempotencyKeyHeader = c.req.header('Idempotency-Key');
		let idempotencyKey: string | undefined;
		if (idempotencyKeyHeader) {
			const trimmed = idempotencyKeyHeader.trim();
			if (trimmed.length === 0 || trimmed.length > 128 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
				return c.json(
					{
						error: 'bad_request',
						message: 'Idempotency-Key must be 1-128 alphanumeric/[-_] chars'
					},
					400
				);
			}
			idempotencyKey = trimmed;
		}

		id = crypto.randomUUID();
		if (idempotencyKey) {
			try {
				const reserved = await reserveIdempotencyKey(idempotencyKey, id);
				if (reserved.existing) {
					const existing = await getPuzzle(reserved.puzzleId);
					if (existing) {
						// Bun path is synchronous generation — puzzles have no
						// processing/failed lifecycle (see Puzzle in types/index.ts).
						// Failed-reclaim lives only on the Worker path.
						return c.json(existing, 200);
					}
					// Reservation exists but metadata is missing (in-flight or
					// orphaned). Do not invent a response body.
					//
					// NOTE: this Bun path always returns 409, while the Worker path
					// (admin.worker.ts) distinguishes 409 (pending) from reclaim
					// (committed-but-missing). The filesystem reservation
					// (reserveIdempotencyKey in storage.ts) stores only a flat
					// puzzleId string with no lifecycle status, so the Bun runtime
					// cannot tell pending from committed. Adding status tracking to
					// the dev-only filesystem reservation is not worth the
					// complexity; the Worker (production) path is the authoritative
					// behavior. This divergence is dev-only and low-impact.
					return c.json(
						{
							error: 'conflict',
							message: 'A request with this Idempotency-Key is already in progress'
						},
						409
					);
				}
				id = reserved.puzzleId;
				reservedIdempotencyKey = idempotencyKey;
			} catch (error) {
				console.error('Idempotency reserve failed:', error);
				return c.json(
					{ error: 'internal_error', message: 'Failed to reserve idempotency key' },
					500
				);
			}
		}

		// Read image buffer
		const imageBuffer = Buffer.from(await image.arrayBuffer());

		// Persist original image for the /reference endpoint using detected type
		await mkdir(getPuzzleDir(id), { recursive: true });
		puzzleDirCreated = true;
		await writeFile(getOriginalImagePath(id, detectedType), imageBuffer);

		// Generate puzzle pieces and thumbnail
		const result = await generatePuzzle({
			id,
			name: trimmedName,
			pieceCount,
			aspectRatio,
			imageBuffer,
			outputDir: `${DATA_DIR}/puzzles`
		});

		// Save puzzle metadata
		const puzzleToStore = {
			...(category ? { ...result.puzzle, category } : result.puzzle),
			...(idempotencyKey && { idempotencyKey })
		};
		const saved = await storePuzzle(puzzleToStore);
		if (!saved) {
			const cleaned = await deleteStoredPuzzle(id);
			if (!cleaned) {
				// Puzzle directory cleanup failed — the on-disk puzzle data
				// remains as an orphan. Keep the reservation file in place
				// (do NOT release) so a same-key retry sees existing:true and
				// returns the orphaned puzzleId instead of minting a
				// replacement alongside the orphan. The dev can manually
				// clean up the filesystem and reservation file. This mirrors
				// the Worker's failReservation() pattern — the Bun filesystem
				// reservation has no "failed" state, so we settle for leaving
				// the key reserved.
				console.error(`Failed to clean up puzzle directory ${id} after metadata save failure`);
				return c.json(
					{
						error: 'internal_error',
						message: 'Puzzle may be stuck on disk; cleanup failed after metadata save failure'
					},
					500
				);
			}
			if (reservedIdempotencyKey) {
				try {
					await releaseIdempotencyKey(reservedIdempotencyKey, id);
				} catch (releaseErr) {
					console.error(`Failed to release idempotency reservation for puzzle ${id}:`, releaseErr);
				}
				reservedIdempotencyKey = undefined;
			}
			return c.json({ error: 'internal_error', message: 'Failed to save puzzle metadata' }, 500);
		}

		// Mirror the puzzle into the D1 ownership table with a system sentinel
		// owner so listPlayerStats can resolve its name when a signed-in player
		// solves it. Best-effort: filesystem metadata above is the source of
		// truth for puzzle existence in the Bun runtime, so a failed ownership
		// insert is logged, not fatal. getDb() is a lazy init that can throw on
		// first call; wrap it so a DB init failure doesn't bubble a 500 after a
		// successful puzzle creation.
		try {
			await insertPuzzleOwnership(getDb(), {
				id,
				ownerId: SYSTEM_OWNER_ID,
				name: trimmedName,
				pieceCount,
				...(category ? { category } : {}),
				status: 'ready',
				createdAt: puzzleToStore.createdAt
			}).catch((err) => console.error(`Failed to record admin puzzle ownership for ${id}:`, err));
		} catch (err) {
			console.error(`Failed to init DB for ownership insert of puzzle ${id}:`, err);
		}

		// Keep the reservation file as the durable key → puzzleId mapping.
		reservedIdempotencyKey = undefined;
		return c.json(stripIdempotencyKey(puzzleToStore), 201);
	} catch (error) {
		console.error('Error creating puzzle:', error);
		// Clean up the puzzle directory if it was created before the failure.
		// If cleanup fails, keep the reservation file in place (do NOT release)
		// so a same-key retry sees existing:true and returns the orphaned
		// puzzleId instead of minting a replacement alongside the orphan.
		// Mirrors the Worker's failReservation() pattern; the Bun filesystem
		// reservation has no "failed" state, so we settle for leaving the key
		// reserved for manual cleanup.
		let cleanupFailed = false;
		if (puzzleDirCreated) {
			try {
				// deleteStoredPuzzle returns false on failure (it catches
				// internally and never throws), so we must check the return
				// value — the catch below only fires on an unexpected throw
				// from a non-defensive caller. A false result means the
				// on-disk puzzle directory remains as an orphan; preserve
				// the reservation (do NOT release) so a same-key retry sees
				// existing:true and returns the orphaned puzzleId instead
				// of minting a replacement alongside the orphan. Mirrors
				// the failReservation() pattern in admin.worker.ts.
				const cleaned = await deleteStoredPuzzle(id);
				if (!cleaned) {
					cleanupFailed = true;
				}
			} catch (cleanupError) {
				console.error('Failed to clean up puzzle directory after error:', cleanupError);
				cleanupFailed = true;
			}
		}
		if (cleanupFailed) {
			return c.json(
				{
					error: 'internal_error',
					message:
						'Puzzle may be stuck on disk; cleanup failed after create error. Manually remove the puzzle directory and idempotency reservation before retrying.'
				},
				500
			);
		}
		if (reservedIdempotencyKey && id) {
			try {
				await releaseIdempotencyKey(reservedIdempotencyKey, id);
			} catch (releaseErr) {
				console.error(`Failed to release idempotency reservation for puzzle ${id}:`, releaseErr);
			}
		}
		return c.json({ error: 'internal_error', message: 'Failed to create puzzle' }, 500);
	}
});

// DELETE /api/admin/puzzles/:id - Delete puzzle (protected)
admin.delete('/puzzles/:id', requireAuth, async (c) => {
	const id = c.req.param('id');

	// Read metadata before deletion so we can release the idempotency
	// reservation (keyed by idempotencyKey, not puzzleId). Without this,
	// a deleted seeded puzzle permanently maps its key to the deleted ID,
	// and the next upload with the same key gets a permanent 409.
	//
	// Best-effort read: if metadata is corrupt/unreadable, fall back to
	// puzzleExists so an existing puzzle directory can still be deleted
	// instead of 500-ing. The idempotency reservation release is skipped
	// (no key available) — same as a puzzle never reserved with a key.
	let puzzle: Awaited<ReturnType<typeof getPuzzle>> = null;
	try {
		puzzle = await getPuzzle(id);
	} catch (err) {
		console.error(`Failed to read metadata for puzzle ${id}, attempting best-effort cleanup:`, err);
	}

	if (puzzle === null) {
		// Either getPuzzle returned null (truly missing) or threw (corrupt).
		// Fall back to puzzleExists so a corrupt-but-present puzzle can still
		// be deleted instead of 500-ing.
		const exists = await puzzleExists(id);
		if (!exists) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}
		// puzzle stays null — proceed with deletion; idempotency reservation
		// release is skipped (no key available).
	}

	const deleted = await deleteStoredPuzzle(id);

	if (!deleted) {
		return c.json({ error: 'internal_error', message: 'Failed to delete puzzle' }, 500);
	}

	// Best-effort release of the idempotency reservation so the key can be
	// reused after deletion. Owner-checked: only deletes if the file content
	// matches this puzzleId. Logged, not fatal — filesystem deletion above
	// is the source of truth for puzzle existence. Skipped when metadata was
	// corrupt (no idempotency key available).
	if (puzzle?.idempotencyKey) {
		try {
			await releaseIdempotencyKey(puzzle.idempotencyKey, id);
		} catch (err) {
			console.error(`Failed to release idempotency reservation for puzzle ${id}:`, err);
		}
	}

	// Best-effort cleanup of the D1 ownership row (see admin.worker.ts for the
	// full rationale). Logged, not fatal — filesystem deletion above is the
	// source of truth for puzzle existence in the Bun runtime. getDb() is a
	// lazy init that can throw on first call; wrap it in the same best-effort
	// handling so a DB init failure doesn't bubble a 500 after a successful
	// puzzle deletion.
	try {
		await deletePuzzleOwnership(getDb(), id).catch((err) =>
			console.error(`Failed to delete ownership row for puzzle ${id}:`, err)
		);
		// Best-effort cleanup of puzzle_stats rows (see admin.worker.ts).
		await deletePuzzleStats(getDb(), id).catch((err) =>
			console.error(`Failed to delete stats rows for puzzle ${id}:`, err)
		);
	} catch (err) {
		console.error(`Failed to init DB for ownership cleanup of puzzle ${id}:`, err);
	}

	return c.body(null, 204);
});

export default admin;
