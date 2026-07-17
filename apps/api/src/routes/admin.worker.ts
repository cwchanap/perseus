// Worker-compatible admin routes for authentication and puzzle management

import { Hono } from 'hono';
import {
	DEFAULT_PUZZLE_ASPECT_RATIO,
	MAX_FILE_SIZE,
	MAX_PIECES,
	PUZZLE_CATEGORIES,
	ALLOWED_MIME_TYPES,
	aspectRatiosMatch,
	getGridDimensionsForAspectRatio,
	isPuzzleAspectRatio,
	isPuzzleId,
	isValidPieceCountForAspectRatio
} from '@perseus/types';
import type { PuzzleCategory } from '@perseus/types';
import type { Env } from '../worker';
import {
	commitIdempotencyKey,
	createPuzzleMetadata,
	deletePuzzleMetadata,
	deletePuzzleAssets,
	failIdempotencyKey,
	uploadOriginalImage,
	deleteOriginalImage,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey,
	reserveIdempotencyKey,
	type PuzzleMetadata
} from '../services/storage.worker';
import {
	createSession,
	setSessionCookie,
	clearSessionCookie,
	getSessionToken,
	revokeSession,
	verifySession,
	requireAuth
} from '../middleware/auth.worker';
import { loginRateLimit } from '../middleware/rate-limit.worker';
import {
	addAllowlistEntry,
	deleteAllowlistEntry,
	getPlayerByEmail,
	listAllowlistEntries,
	revokePlayerSessionsForEmail
} from '../services/player-auth.worker';
import { getWorkerDb } from '../db.worker';
import {
	deletePuzzleOwnership,
	deletePuzzleStats,
	detectImageType,
	insertPuzzleOwnership,
	parseImageDimensions,
	SYSTEM_OWNER_ID
} from '@perseus/shared';

const admin = new Hono<{ Bindings: Env }>();

// POST /api/admin/login - Admin login
admin.post('/login', loginRateLimit, async (c) => {
	try {
		let body;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
		}

		const { passkey } = body as { passkey?: string };

		if (!passkey || typeof passkey !== 'string') {
			return c.json({ error: 'bad_request', message: 'Passkey is required' }, 400);
		}

		// Validate ADMIN_PASSKEY is configured
		if (!c.env.ADMIN_PASSKEY) {
			console.error('ADMIN_PASSKEY environment variable is not configured');
			return c.json({ error: 'internal_error', message: 'Server configuration error' }, 500);
		}

		// Use WebCrypto for constant-time comparison
		const encoder = new TextEncoder();
		const passkeyBytes = encoder.encode(passkey);
		const expectedBytes = encoder.encode(c.env.ADMIN_PASSKEY);

		// Hash both for constant-time comparison
		const passkeyHash = await crypto.subtle.digest('SHA-256', passkeyBytes);
		const expectedHash = await crypto.subtle.digest('SHA-256', expectedBytes);

		// Constant-time comparison via XOR over fixed-length SHA-256 hashes
		const passkeyArr = new Uint8Array(passkeyHash);
		const expectedArr = new Uint8Array(expectedHash);

		let diff = passkeyArr.length ^ expectedArr.length;
		const maxLength = Math.max(passkeyArr.length, expectedArr.length);
		for (let i = 0; i < maxLength; i++) {
			const a = i < passkeyArr.length ? passkeyArr[i] : 0;
			const b = i < expectedArr.length ? expectedArr[i] : 0;
			diff |= a ^ b;
		}
		const isValid = diff === 0;

		if (!isValid) {
			return c.json({ error: 'unauthorized', message: 'Invalid passkey' }, 401);
		}

		const token = await createSession(c.env, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		setSessionCookie(c, token);
		// Rate limit reset is handled by loginRateLimit middleware on 200 response

		return c.json({ success: true });
	} catch (error) {
		console.error('Failed to process admin login', error);
		return c.json({ error: 'internal_error', message: 'Failed to process login' }, 500);
	}
});

// POST /api/admin/logout - Admin logout
admin.post('/logout', async (c) => {
	const token = getSessionToken(c);
	if (token) {
		try {
			await revokeSession(c.env, token);
		} catch (error) {
			// In production, session revocation failure is a security concern.
			// We must not silently suppress this - the client needs to know and retry.
			console.error('Failed to revoke session server-side:', error);
			// In production, return an error so the client can retry
			if (c.env.NODE_ENV !== 'development') {
				return c.json(
					{
						error: 'internal_error',
						message: 'Failed to revoke session. Please try again.'
					},
					500
				);
			}
			// In development, fall through to clear cookie for debugging convenience
		}
	}
	clearSessionCookie(c);
	return c.json({ success: true });
});

// GET /api/admin/session - Check admin session
admin.get('/session', async (c) => {
	try {
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
	} catch (error) {
		// Unexpected error during session verification (e.g., JWT_SECRET misconfiguration)
		console.error('Session verification failed unexpectedly:', error);
		return c.json({ error: 'internal_error', message: 'Session verification failed' }, 500);
	}
});

// GET /api/admin/player-allowlist - List player allowlist entries (protected)
admin.get('/player-allowlist', requireAuth, async (c) => {
	try {
		const allowlistEntries = await listAllowlistEntries(c.env.PUZZLE_METADATA);
		const entries = await Promise.all(
			allowlistEntries.map(async (entry) => {
				const player = await getPlayerByEmail(c.env.PUZZLE_METADATA, entry.email);
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
		const entry = await addAllowlistEntry(c.env.PUZZLE_METADATA, email, 'admin');
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
		await revokePlayerSessionsForEmail(c.env.PUZZLE_METADATA, email);
		await deleteAllowlistEntry(c.env.PUZZLE_METADATA, email);
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

// GET /api/admin/puzzles - List all puzzles for admin (includes processing/failed)
admin.get('/puzzles', requireAuth, async (c) => {
	try {
		const { puzzles: puzzleList } = await listPuzzles(c.env.PUZZLE_METADATA);
		return c.json({ puzzles: puzzleList });
	} catch (error) {
		console.error('Failed to list puzzles for admin', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// POST /api/admin/puzzles - Create new puzzle (protected)
admin.post('/puzzles', requireAuth, async (c) => {
	let id = '';
	let reservedIdempotencyKey: string | undefined;
	const releaseReservation = async () => {
		if (!reservedIdempotencyKey || !id) return;
		const key = reservedIdempotencyKey;
		const puzzleId = id;
		reservedIdempotencyKey = undefined;
		try {
			await releaseIdempotencyKey(c.env.PUZZLE_METADATA_DO, key, puzzleId);
		} catch (err) {
			console.error('Failed to release idempotency reservation:', err);
			try {
				await failIdempotencyKey(c.env.PUZZLE_METADATA_DO, key, puzzleId);
			} catch (failErr) {
				console.error('Failed to mark idempotency reservation failed:', failErr);
			}
		}
	};

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

		// Validate name
		if (!name || typeof name !== 'string' || name.trim().length === 0) {
			return c.json({ error: 'bad_request', message: 'Name is required' }, 400);
		}

		const trimmedName = name.trim();
		if (trimmedName.length > 255) {
			return c.json({ error: 'bad_request', message: 'Name must be at most 255 characters' }, 400);
		}

		// Validate piece count for the selected fixed aspect ratio.
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
		if (!Number.isFinite(pieceCount) || !Number.isInteger(pieceCount)) {
			return c.json(
				{
					error: 'bad_request',
					message: `Invalid piece count for ${aspectRatio}`
				},
				400
			);
		}

		if (pieceCount < 4 || pieceCount > MAX_PIECES) {
			return c.json(
				{
					error: 'bad_request',
					message: `Piece count must be between 4 and ${MAX_PIECES}`
				},
				400
			);
		}

		if (!isValidPieceCountForAspectRatio(pieceCount, aspectRatio)) {
			return c.json(
				{
					error: 'bad_request',
					message: `Invalid piece count for ${aspectRatio}`
				},
				400
			);
		}

		// Validate image
		if (!image || !(image instanceof File)) {
			return c.json({ error: 'bad_request', message: 'Image file is required' }, 400);
		}

		// Validate optional category
		const categoryStr = formData.get('category');
		let category: PuzzleCategory | undefined;
		if (categoryStr && typeof categoryStr === 'string' && categoryStr.trim().length > 0) {
			const trimmedCategory = categoryStr.trim();
			const validCategories: readonly string[] = PUZZLE_CATEGORIES;
			if (!validCategories.includes(trimmedCategory)) {
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

		// Verify actual file type via magic bytes instead of trusting image.type
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
		// If dimensions can't be parsed, proceed — the workflow will use actual pixel dimensions

		// Server-side idempotency: if the client sends an Idempotency-Key
		// header, reserve it in PuzzleMetadataDO (strongly consistent) before
		// minting a UUID. A retried POST after a lost response hits the same
		// DO instance and gets the original puzzleId back instead of creating
		// a duplicate. Without the header, behavior is unchanged (fresh UUID
		// per POST). The reserve happens after all input validation so bad
		// requests don't consume an idempotency slot.
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
				const reserved = await reserveIdempotencyKey(c.env.PUZZLE_METADATA_DO, idempotencyKey, id);
				if (reserved.existing) {
					// Prior request owns this key. Return the puzzle when
					// metadata is available; otherwise non-200 so the client
					// can retry instead of accepting a fabricated body.
					const existing = await getPuzzle(c.env.PUZZLE_METADATA, reserved.puzzleId);
					if (existing) {
						return c.json(existing, 200);
					}
					const inProgress = reserved.status === 'pending' || reserved.status === undefined;
					return c.json(
						{
							error: inProgress ? 'conflict' : 'not_found',
							message: inProgress
								? 'A request with this Idempotency-Key is already in progress'
								: 'Idempotency reservation exists but puzzle metadata is missing'
						},
						inProgress ? 409 : 404
					);
				}
				// First caller — use our minted UUID.
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

		// Calculate grid dimensions (must match workflow calculation)
		const { rows: gridRows, cols: gridCols } = getGridDimensionsForAspectRatio(
			pieceCount,
			aspectRatio
		);

		// Prepare image buffer
		const imageBuffer = await image.arrayBuffer();

		// Step 1: Upload original image to R2 first
		try {
			await uploadOriginalImage(c.env.PUZZLES_BUCKET, id, imageBuffer, detectedType);
		} catch (error) {
			console.error('Failed to upload original image:', error);
			await releaseReservation();
			return c.json({ error: 'internal_error', message: 'Failed to upload image' }, 500);
		}

		// Step 2: Create puzzle metadata with processing status
		const puzzleMetadata: PuzzleMetadata = {
			id,
			name: trimmedName,
			...(category && { category }),
			aspectRatio,
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
			pieces: [],
			version: 0, // Initial version for optimistic concurrency
			...(idempotencyKey && { idempotencyKey })
		};

		try {
			// Store metadata in KV
			await createPuzzleMetadata(c.env.PUZZLE_METADATA, puzzleMetadata);
		} catch (error) {
			console.error('Failed to create puzzle metadata:', error);
			// Clean up the uploaded image
			const cleanupResult = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!cleanupResult.success) {
				console.error(
					'Failed to cleanup original image after metadata creation failure:',
					cleanupResult.error
				);
			}
			await releaseReservation();
			return c.json({ error: 'internal_error', message: 'Failed to create puzzle metadata' }, 500);
		}

		// Mirror the puzzle into the D1 ownership table with a system sentinel
		// owner so listPlayerStats can resolve its name when a signed-in player
		// solves it. Without this row, the Best Times UI falls back to showing
		// the puzzle UUID. Player profile lists/counts filter by a real player's
		// ownerId, so this system-owned row never leaks there.
		//
		// Best-effort: KV metadata above is the source of truth for admin puzzle
		// existence, so a failed ownership insert is logged, not fatal — matching
		// the Bun admin path. This keeps admin puzzle creation available during a
		// D1 outage or when the DB binding is absent. The player-owned upload
		// path (puzzles.worker.ts) keeps a hard D1 requirement because the
		// ownership row IS the source of truth for a player's puzzle list.
		try {
			await insertPuzzleOwnership(getWorkerDb(c.env), {
				id,
				ownerId: SYSTEM_OWNER_ID,
				name: trimmedName,
				pieceCount,
				...(category ? { category } : {}),
				status: 'processing',
				createdAt: puzzleMetadata.createdAt
			}).catch((err) => console.error(`Failed to record admin puzzle ownership for ${id}:`, err));
		} catch (err) {
			console.error(`Failed to init DB for ownership insert of puzzle ${id}:`, err);
		}

		// Step 3: Trigger workflow for puzzle generation
		if (!c.env.PUZZLE_WORKFLOW || typeof c.env.PUZZLE_WORKFLOW.create !== 'function') {
			const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
			if (!metadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle metadata after missing workflow binding:',
					metadataCleanup.error
				);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!imageCleanup.success) {
				console.error(
					'Failed to cleanup original image after missing workflow binding:',
					imageCleanup.error
				);
			}
			try {
				await deletePuzzleOwnership(getWorkerDb(c.env), id).catch((err) =>
					console.error('Failed to cleanup ownership after missing workflow binding:', err)
				);
			} catch (err) {
				console.error(`Failed to init DB for ownership cleanup of puzzle ${id}:`, err);
			}
			await releaseReservation();
			return c.json(
				{
					error: 'service_unavailable',
					message: 'Puzzle workflow is not configured for this environment'
				},
				503
			);
		}

		try {
			await c.env.PUZZLE_WORKFLOW.create({
				id,
				params: { puzzleId: id }
			});
		} catch (error) {
			console.error('Failed to trigger workflow:', error);
			// Clean up both metadata and image
			const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
			if (!metadataCleanup.success) {
				console.error(
					'Failed to cleanup puzzle metadata after workflow trigger failure:',
					metadataCleanup.error
				);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!imageCleanup.success) {
				console.error(
					'Failed to cleanup original image after workflow trigger failure:',
					imageCleanup.error
				);
			}
			try {
				await deletePuzzleOwnership(getWorkerDb(c.env), id).catch((err) =>
					console.error('Failed to cleanup ownership after workflow trigger failure:', err)
				);
			} catch (err) {
				console.error(`Failed to init DB for ownership cleanup of puzzle ${id}:`, err);
			}
			await releaseReservation();
			return c.json({ error: 'internal_error', message: 'Failed to start puzzle processing' }, 500);
		}

		if (reservedIdempotencyKey) {
			try {
				await commitIdempotencyKey(c.env.PUZZLE_METADATA_DO, reservedIdempotencyKey, id);
			} catch (err) {
				// Create already succeeded; log and continue. Reservation stays
				// pending but still maps to this puzzleId for retries.
				console.error('Failed to commit idempotency reservation:', err);
			}
			reservedIdempotencyKey = undefined;
		}

		return c.json(puzzleMetadata, 201);
	} catch (error) {
		console.error('Error creating puzzle:', error);
		await releaseReservation();
		return c.json({ error: 'internal_error', message: 'Failed to create puzzle' }, 500);
	}
});

// DELETE /api/admin/puzzles/:id - Delete puzzle (protected)
admin.delete('/puzzles/:id', requireAuth, async (c) => {
	const id = c.req.param('id');
	const force = c.req.query('force') === 'true';

	// Validate UUID format (shared with the completion route via @perseus/types)
	if (!isPuzzleId(id)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

	try {
		// Get puzzle to check status before deletion
		// Note: There is a small TOCTOU window between getPuzzle and deletePuzzleMetadata
		// where the puzzle status could change. This endpoint accepts that risk for simplicity.
		// The status check prevents deletion of processing puzzles, but a race could still occur
		// if processing completes between the check and the delete.
		const puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);

		if (!puzzle) {
			return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
		}

		// Block deletion if puzzle is still processing unless force=true
		// Force delete allows cleanup of stuck puzzles where workflow failed to mark them as failed
		if (puzzle.status === 'processing' && !force) {
			return c.json(
				{
					error: 'conflict',
					message:
						'Cannot delete puzzle while it is being processed. Please wait for processing to complete, or use force=true to delete a stuck puzzle.'
				},
				409
			);
		}

		// Delete metadata from KV first
		const metadataResult = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);

		if (!metadataResult.success) {
			console.error('Failed to delete puzzle metadata:', metadataResult.error);
			return c.json({ error: 'internal_error', message: 'Failed to delete puzzle' }, 500);
		}

		// Best-effort cleanup of the D1 ownership row so a deleted puzzle doesn't
		// keep appearing in the uploader's "My Puzzles" list (404 on click) or
		// inflate their puzzlesUploaded count. KV/R2 deletion above is the source
		// of truth for puzzle existence, so a failed ownership delete is logged,
		// not fatal. (Admin-created puzzles are mirrored with a system sentinel
		// owner; this removes that row too.) getWorkerDb is a lazy init that can
		// throw on first call; wrap both cleanup calls so a DB init failure
		// doesn't bubble a 500 after a successful KV delete (mirrors admin.ts).
		try {
			await deletePuzzleOwnership(getWorkerDb(c.env), id).catch((err) =>
				console.error(`Failed to delete ownership row for puzzle ${id}:`, err)
			);
			// Best-effort cleanup of any puzzle_stats rows referencing this puzzle
			// so deleted puzzles don't linger in players' best-times lists with a
			// null name. Logged, not fatal — same rationale as ownership cleanup.
			await deletePuzzleStats(getWorkerDb(c.env), id).catch((err) =>
				console.error(`Failed to delete stats rows for puzzle ${id}:`, err)
			);
		} catch (err) {
			console.error(`Failed to init DB for ownership cleanup of puzzle ${id}:`, err);
		}

		// Delete assets from R2
		const deleteResult = await deletePuzzleAssets(c.env.PUZZLES_BUCKET, id, puzzle.pieceCount);

		// If some assets failed to delete, return 207 Multi-Status
		if (!deleteResult.success) {
			console.error(`Failed to delete some assets for puzzle ${id}:`, deleteResult.failedKeys);
			return c.json(
				{
					success: false,
					partialSuccess: true,
					warning: 'Puzzle metadata deleted but some assets failed to delete',
					failedAssets: deleteResult.failedKeys
				},
				207
			);
		}

		return c.body(null, 204);
	} catch (error) {
		console.error(`Error deleting puzzle ${id}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to delete puzzle' }, 500);
	}
});

export default admin;
