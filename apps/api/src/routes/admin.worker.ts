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
	originalImageExists,
	getPuzzle,
	listPuzzles,
	puzzleExists,
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
import type { AppDb } from '@perseus/shared';

const admin = new Hono<{ Bindings: Env }>();

/**
 * Run a best-effort D1 operation that must never bubble a 500 after a
 * successful KV/R2 mutation. getWorkerDb is a lazy init that can throw on
 * first call; the outer catch handles that (logging initLabel), while the
 * inner .catch handles the operation itself failing (logging operationLabel).
 * Both are logged, not fatal — KV/R2 are the source of truth for admin
 * puzzle existence (see the per-call-site comments for the full rationale).
 * Mirrors the same best-effort pattern in admin.ts.
 */
async function withDbBestEffort(
	env: Env,
	operationLabel: string,
	initLabel: string,
	fn: (db: AppDb) => Promise<unknown>
): Promise<void> {
	try {
		await fn(getWorkerDb(env)).catch((err) => console.error(operationLabel, err));
	} catch (err) {
		console.error(initLabel, err);
	}
}

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

// Bounded retry/backoff for the idempotency commit transition. The commit is a
// strongly-consistent DO call that should rarely fail; these retries absorb
// transient DO errors. If all attempts fail, the handler returns 500 (not 201)
// so the client retries the POST — which hits the existing-puzzle branch and
// returns the original puzzle (200) once KV propagates, while best-effort
// committing the still-pending reservation. Returning 201 with a pending
// reservation would let the pending TTL expire into a reclaimable state,
// allowing a duplicate workflow on a later retry.
const IDEMPOTENCY_COMMIT_MAX_ATTEMPTS = 3;
const IDEMPOTENCY_COMMIT_BASE_DELAY_MS = 100;

// When a committed reservation has no metadata on the first KV read, retry
// once after this delay before treating the puzzle as deleted. KV is
// eventually consistent — a committed reservation means the create succeeded
// (commit runs after the KV write), so a missing read is usually propagation
// lag, not a missing puzzle. Only after the retry do we conclude the puzzle
// was deleted with a failed reservation release and reclaim the key.
const IDEMPOTENCY_KV_RETRY_MS = 500;
// Extra KV probes with exponential backoff before treating committed+missing
// as deleted. Global KV lag can exceed a single 500ms retry.
const IDEMPOTENCY_KV_EXTRA_RETRIES = 3;
const IDEMPOTENCY_KV_EXTRA_BASE_DELAY_MS = 250;

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
	// Mark the reservation failed (not released) when metadata cleanup fails
	// and the puzzle's KV metadata + image may remain as orphans. Releasing
	// would let a same-key retry mint a replacement puzzle alongside the
	// orphaned one; failing keeps the reservation in a recoverable state so
	// a retry reclaims through the DO's serialized path, and the orphan is
	// explicit for operator force-delete instead of being silently left
	// behind a released key.
	const failReservation = async () => {
		if (!reservedIdempotencyKey || !id) return;
		const key = reservedIdempotencyKey;
		const puzzleId = id;
		reservedIdempotencyKey = undefined;
		try {
			await failIdempotencyKey(c.env.PUZZLE_METADATA_DO, key, puzzleId);
		} catch (err) {
			console.error('Failed to mark idempotency reservation failed:', err);
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
					// metadata is available and not failed. A committed
					// reservation whose workflow later failed is reclaimed so
					// this request can create a replacement instead of
					// returning the failed metadata as 200 (which would make
					// the seed uploader skip the failed puzzle permanently).
					// When metadata is missing, the reservation status
					// distinguishes the two cases: a pending reservation means
					// an in-flight create (metadata not yet written) or KV
					// propagation lag — signal transient (409) for retry. A
					// committed reservation with no metadata means the puzzle
					// was deleted but the reservation release failed (e.g. DO
					// outage during admin delete) — after a KV propagation
					// retry, release the stale reservation and re-reserve so
					// the key isn't permanently bricked mapping to a deleted
					// puzzle (which would 409 every future upload with that
					// key).
					let existing = await getPuzzle(c.env.PUZZLE_METADATA, reserved.puzzleId);
					// A committed reservation should have metadata (commit
					// runs after the KV write). A missing first read is usually
					// KV propagation lag — retry with backoff before concluding
					// the puzzle was deleted with a failed release.
					if (!existing && reserved.status === 'committed') {
						await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_KV_RETRY_MS));
						existing = await getPuzzle(c.env.PUZZLE_METADATA, reserved.puzzleId);
						for (let attempt = 0; !existing && attempt < IDEMPOTENCY_KV_EXTRA_RETRIES; attempt++) {
							await new Promise((resolve) =>
								setTimeout(resolve, IDEMPOTENCY_KV_EXTRA_BASE_DELAY_MS * 2 ** attempt)
							);
							existing = await getPuzzle(c.env.PUZZLE_METADATA, reserved.puzzleId);
						}
					}
					if (existing) {
						if (existing.status === 'failed') {
							try {
								await failIdempotencyKey(
									c.env.PUZZLE_METADATA_DO,
									idempotencyKey,
									reserved.puzzleId
								);
							} catch (err) {
								console.error('Failed to reclaim failed idempotency reservation:', err);
								return c.json(
									{
										error: 'internal_error',
										message: 'Failed to reclaim failed idempotency reservation'
									},
									500
								);
							}
							// Re-reserve with our minted UUID. The failed
							// reservation is now reclaimable, so this should
							// win as first caller. A concurrent retry could
							// reclaim first — in that case defer to its puzzle.
							try {
								const reclaimed = await reserveIdempotencyKey(
									c.env.PUZZLE_METADATA_DO,
									idempotencyKey,
									id
								);
								if (reclaimed.existing) {
									const raceExisting = await getPuzzle(c.env.PUZZLE_METADATA, reclaimed.puzzleId);
									if (raceExisting && raceExisting.status !== 'failed') {
										return c.json(raceExisting, 200);
									}
									if (raceExisting === null && reclaimed.status === 'committed') {
										// Concurrent winner's committed reservation
										// has no metadata. If R2 still has the
										// original, treat as KV lag (409), not a
										// deleted puzzle — releasing would mint a
										// duplicate of a live puzzle. R2 probe
										// errors are also treated as 409
										// (transient) — fail closed rather than
										// guessing "object gone" and minting a
										// duplicate of a live puzzle on a
										// transient `head` failure.
										let originalStillThere: boolean;
										try {
											originalStillThere = await originalImageExists(
												c.env.PUZZLES_BUCKET,
												reclaimed.puzzleId
											);
										} catch (probeErr) {
											console.error(
												`R2 probe failed for puzzle ${reclaimed.puzzleId} during reclaim:`,
												probeErr
											);
											return c.json(
												{
													error: 'conflict',
													message:
														'Idempotency-Key may map to an existing puzzle; R2 probe failed, retry'
												},
												409
											);
										}
										if (originalStillThere) {
											return c.json(
												{
													error: 'conflict',
													message:
														'Idempotency-Key maps to an existing puzzle whose metadata is still propagating; retry'
												},
												409
											);
										}
										try {
											await releaseIdempotencyKey(
												c.env.PUZZLE_METADATA_DO,
												idempotencyKey,
												reclaimed.puzzleId
											);
										} catch (releaseErr) {
											console.error(
												'Failed to release stale committed reservation on reclaim:',
												releaseErr
											);
											return c.json(
												{
													error: 'internal_error',
													message: 'Failed to release stale reservation'
												},
												500
											);
										}
										try {
											const rereserved = await reserveIdempotencyKey(
												c.env.PUZZLE_METADATA_DO,
												idempotencyKey,
												id
											);
											if (rereserved.existing) {
												const reRaceExisting = await getPuzzle(
													c.env.PUZZLE_METADATA,
													rereserved.puzzleId
												);
												if (reRaceExisting && reRaceExisting.status !== 'failed') {
													return c.json(reRaceExisting, 200);
												}
												return c.json(
													{
														error: 'conflict',
														message: 'Idempotency key reclaimed by another request'
													},
													409
												);
											}
											id = rereserved.puzzleId;
											reservedIdempotencyKey = idempotencyKey;
											// Fall through to normal create flow.
										} catch (rereserveErr) {
											console.error(
												'Failed to re-reserve after stale release on reclaim:',
												rereserveErr
											);
											return c.json(
												{
													error: 'internal_error',
													message: 'Failed to re-reserve idempotency key'
												},
												500
											);
										}
									} else {
										return c.json(
											{
												error: 'conflict',
												message: 'Idempotency key reclaimed by another request'
											},
											409
										);
									}
								}
								id = reclaimed.puzzleId;
								reservedIdempotencyKey = idempotencyKey;
								// Fall through to normal create flow with the
								// reclaimed key to build a replacement puzzle.
							} catch (err) {
								console.error('Failed to re-reserve reclaimed idempotency key:', err);
								return c.json(
									{
										error: 'internal_error',
										message: 'Failed to re-reserve reclaimed idempotency key'
									},
									500
								);
							}
						} else {
							// If the original create's commit failed, the
							// reservation may still be pending. Best-effort
							// commit it now so the key doesn't expire into a
							// reclaimable state that could spawn a duplicate
							// workflow while the original is still alive.
							if (reserved.status === 'pending') {
								try {
									await commitIdempotencyKey(
										c.env.PUZZLE_METADATA_DO,
										idempotencyKey,
										reserved.puzzleId
									);
								} catch (err) {
									console.error('Failed to commit pending reservation on retry:', err);
								}
							}
							return c.json(existing, 200);
						}
					} else {
						// Metadata is missing. A committed reservation should
						// have metadata (commit happens after the KV write) —
						// its absence usually means the puzzle was deleted but
						// the reservation release failed. Before releasing,
						// confirm via R2: if the original image still exists,
						// this is still KV lag (can be seconds–minutes globally)
						// — return 409 so the client retries instead of minting
						// a duplicate of a live puzzle. A pending reservation
						// means an in-flight create or KV propagation lag —
						// signal transient (409) for the client to retry.
						if (reserved.status === 'committed') {
							// R2 probe errors are treated as 409 (transient)
							// — fail closed rather than guessing "object gone"
							// and minting a duplicate of a live puzzle on a
							// transient `head` failure.
							let originalStillThere: boolean;
							try {
								originalStillThere = await originalImageExists(
									c.env.PUZZLES_BUCKET,
									reserved.puzzleId
								);
							} catch (probeErr) {
								console.error(
									`R2 probe failed for puzzle ${reserved.puzzleId} during stale reservation release:`,
									probeErr
								);
								return c.json(
									{
										error: 'conflict',
										message: 'Idempotency-Key may map to an existing puzzle; R2 probe failed, retry'
									},
									409
								);
							}
							if (originalStillThere) {
								return c.json(
									{
										error: 'conflict',
										message:
											'Idempotency-Key maps to an existing puzzle whose metadata is still propagating; retry'
									},
									409
								);
							}
							try {
								await releaseIdempotencyKey(
									c.env.PUZZLE_METADATA_DO,
									idempotencyKey,
									reserved.puzzleId
								);
							} catch (releaseErr) {
								console.error('Failed to release stale committed reservation:', releaseErr);
								return c.json(
									{
										error: 'internal_error',
										message: 'Failed to release stale reservation'
									},
									500
								);
							}
							try {
								const reclaimed = await reserveIdempotencyKey(
									c.env.PUZZLE_METADATA_DO,
									idempotencyKey,
									id
								);
								if (reclaimed.existing) {
									const raceExisting = await getPuzzle(c.env.PUZZLE_METADATA, reclaimed.puzzleId);
									if (raceExisting && raceExisting.status !== 'failed') {
										return c.json(raceExisting, 200);
									}
									return c.json(
										{
											error: 'conflict',
											message: 'Idempotency key reclaimed by another request'
										},
										409
									);
								}
								id = reclaimed.puzzleId;
								reservedIdempotencyKey = idempotencyKey;
								// Fall through to normal create flow.
							} catch (rereserveErr) {
								console.error('Failed to re-reserve after stale release:', rereserveErr);
								return c.json(
									{
										error: 'internal_error',
										message: 'Failed to re-reserve idempotency key'
									},
									500
								);
							}
						} else {
							return c.json(
								{
									error: 'conflict',
									message: 'A request with this Idempotency-Key is already in progress'
								},
								409
							);
						}
					}
				} else {
					// First caller — use our minted UUID.
					id = reserved.puzzleId;
					reservedIdempotencyKey = idempotencyKey;
				}
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
			// Clean up the uploaded image. If cleanup SUCCEEDS, release the
			// reservation so a retry can create a fresh puzzle (no orphan).
			// If cleanup FAILS, fail the reservation instead of releasing —
			// the orphaned R2 original remains, and releasing would let a
			// retry mint a replacement alongside the orphan. Failing keeps
			// the key in a recoverable state for operator force-delete.
			const cleanupResult = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!cleanupResult.success) {
				console.error(
					'Failed to cleanup original image after metadata creation failure:',
					cleanupResult.error
				);
				await failReservation();
			} else {
				await releaseReservation();
			}
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
		await withDbBestEffort(
			c.env,
			`Failed to record admin puzzle ownership for ${id}:`,
			`Failed to init DB for ownership insert of puzzle ${id}:`,
			(db) =>
				insertPuzzleOwnership(db, {
					id,
					ownerId: SYSTEM_OWNER_ID,
					name: trimmedName,
					pieceCount,
					...(category ? { category } : {}),
					status: 'processing',
					createdAt: puzzleMetadata.createdAt
				})
		);

		// Step 3: Trigger workflow for puzzle generation
		if (!c.env.PUZZLE_WORKFLOW || typeof c.env.PUZZLE_WORKFLOW.create !== 'function') {
			const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
			if (!metadataCleanup.success) {
				// Metadata cleanup failed — the processing metadata remains in
				// KV as an orphan. Fail (not release) the reservation so a
				// retry reclaims through the DO's serialized path instead of
				// releasing the key and minting a replacement alongside the
				// orphaned puzzle. The orphan is explicit for operator
				// force-delete.
				console.error(
					'Failed to cleanup puzzle metadata after missing workflow binding:',
					metadataCleanup.error
				);
				await failReservation();
				return c.json(
					{
						error: 'internal_error',
						message:
							'Puzzle may be stuck in processing; metadata cleanup failed after workflow misconfiguration'
					},
					500
				);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!imageCleanup.success) {
				// Image cleanup failed — the original R2 object remains as an
				// orphan. Fail (not release) the reservation so a retry reclaims
				// through the DO's serialized path instead of releasing the key
				// and minting a replacement alongside the orphaned image.
				console.error(
					'Failed to cleanup original image after missing workflow binding:',
					imageCleanup.error
				);
				await failReservation();
				return c.json(
					{
						error: 'internal_error',
						message:
							'Puzzle may be stuck in processing; image cleanup failed after workflow misconfiguration'
					},
					500
				);
			}
			await withDbBestEffort(
				c.env,
				'Failed to cleanup ownership after missing workflow binding:',
				`Failed to init DB for ownership cleanup of puzzle ${id}:`,
				(db) => deletePuzzleOwnership(db, id)
			);
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
				// Metadata cleanup failed — the processing metadata remains in
				// KV as an orphan. Fail (not release) the reservation so a
				// retry reclaims through the DO's serialized path instead of
				// releasing the key and minting a replacement alongside the
				// orphaned puzzle. The orphan is explicit for operator
				// force-delete.
				console.error(
					'Failed to cleanup puzzle metadata after workflow trigger failure:',
					metadataCleanup.error
				);
				await failReservation();
				return c.json(
					{
						error: 'internal_error',
						message:
							'Puzzle may be stuck in processing; metadata cleanup failed after workflow trigger failure'
					},
					500
				);
			}
			const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
			if (!imageCleanup.success) {
				// Image cleanup failed — the original R2 object remains as an
				// orphan. Fail (not release) the reservation so a retry reclaims
				// through the DO's serialized path instead of releasing the key
				// and minting a replacement alongside the orphaned image.
				console.error(
					'Failed to cleanup original image after workflow trigger failure:',
					imageCleanup.error
				);
				await failReservation();
				return c.json(
					{
						error: 'internal_error',
						message:
							'Puzzle may be stuck in processing; image cleanup failed after workflow trigger failure'
					},
					500
				);
			}
			await withDbBestEffort(
				c.env,
				'Failed to cleanup ownership after workflow trigger failure:',
				`Failed to init DB for ownership cleanup of puzzle ${id}:`,
				(db) => deletePuzzleOwnership(db, id)
			);
			await releaseReservation();
			return c.json({ error: 'internal_error', message: 'Failed to start puzzle processing' }, 500);
		}

		if (reservedIdempotencyKey) {
			const commitKey = reservedIdempotencyKey;
			const commitPuzzleId = id;
			let committed = false;
			for (let attempt = 0; attempt < IDEMPOTENCY_COMMIT_MAX_ATTEMPTS; attempt++) {
				try {
					await commitIdempotencyKey(c.env.PUZZLE_METADATA_DO, commitKey, commitPuzzleId);
					committed = true;
					break;
				} catch (err) {
					console.error(
						`Failed to commit idempotency reservation (attempt ${attempt + 1}/${IDEMPOTENCY_COMMIT_MAX_ATTEMPTS}):`,
						err
					);
					if (attempt < IDEMPOTENCY_COMMIT_MAX_ATTEMPTS - 1) {
						await new Promise((resolve) =>
							setTimeout(resolve, IDEMPOTENCY_COMMIT_BASE_DELAY_MS * 2 ** attempt)
						);
					}
				}
			}
			if (!committed) {
				// The puzzle and workflow already exist, but the reservation is
				// still pending. Returning 201 would let the pending TTL expire
				// into a reclaimable state, allowing a duplicate workflow.
				// Return 500 instead so the client retries the POST — the retry
				// hits the existing-puzzle branch and returns the original
				// puzzle (200) once KV propagates, and best-effort commits the
				// reservation.
				console.error('CRITICAL: idempotency commit failed after all retries — returning 500');
				reservedIdempotencyKey = undefined;
				return c.json(
					{
						error: 'internal_error',
						message: 'Puzzle created but idempotency commit failed; retry to verify'
					},
					500
				);
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
		//
		// Best-effort read: if metadata is corrupt/unreadable (getPuzzle
		// throws on validation failure), fall back to puzzleExists so an
		// existing puzzle can still be deleted instead of 500-ing. The
		// processing-status check and idempotency release are skipped (no
		// status/key available); piece cleanup uses pieceCount=0 so only the
		// original + thumbnail are deleted (pieces may be orphaned — rare
		// corrupt-metadata case, operator can clean up via R2 console).
		let puzzle: Awaited<ReturnType<typeof getPuzzle>> = null;
		let pieceCount = 0;
		try {
			puzzle = await getPuzzle(c.env.PUZZLE_METADATA, id);
			if (puzzle) pieceCount = puzzle.pieceCount;
		} catch (err) {
			console.error(
				`Failed to read metadata for puzzle ${id}, attempting best-effort cleanup:`,
				err
			);
		}

		if (puzzle === null) {
			// Either getPuzzle returned null (truly missing) or threw (corrupt).
			// Fall back to puzzleExists so a corrupt-but-present puzzle can
			// still be deleted instead of 500-ing.
			const exists = await puzzleExists(c.env.PUZZLE_METADATA, id);
			if (!exists) {
				return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
			}
			// puzzle stays null — proceed with deletion; processing-status
			// check and idempotency release are skipped. pieceCount stays 0.
		}

		// Block deletion if puzzle is still processing unless force=true
		// Force delete allows cleanup of stuck puzzles where workflow failed to mark them as failed
		// Skipped when metadata was corrupt (status unknown — allow deletion).
		if (puzzle?.status === 'processing' && !force) {
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

		// Best-effort release of the idempotency reservation so the key can be
		// reused after deletion. Without this, a deleted seeded puzzle
		// permanently maps its key to the deleted ID, and the next upload with
		// the same key gets a permanent 409. Owner-checked and 404-tolerant
		// (release is a cleanup operation). Logged, not fatal — KV deletion
		// above is the source of truth for puzzle existence. Skipped when
		// metadata was corrupt (no idempotency key available).
		if (puzzle?.idempotencyKey) {
			try {
				await releaseIdempotencyKey(c.env.PUZZLE_METADATA_DO, puzzle.idempotencyKey, id);
			} catch (err) {
				console.error(`Failed to release idempotency reservation for puzzle ${id}:`, err);
			}
		}

		// Best-effort cleanup of the D1 ownership row so a deleted puzzle doesn't
		// keep appearing in the uploader's "My Puzzles" list (404 on click) or
		// inflate their puzzlesUploaded count. KV/R2 deletion above is the source
		// of truth for puzzle existence, so a failed ownership delete is logged,
		// not fatal. (Admin-created puzzles are mirrored with a system sentinel
		// owner; this removes that row too.) getWorkerDb is a lazy init that can
		// throw on first call; wrap both cleanup calls so a DB init failure
		// doesn't bubble a 500 after a successful KV delete (mirrors admin.ts).
		await withDbBestEffort(
			c.env,
			`Failed to delete ownership row for puzzle ${id}:`,
			`Failed to init DB for ownership cleanup of puzzle ${id}:`,
			(db) => deletePuzzleOwnership(db, id)
		);
		// Best-effort cleanup of any puzzle_stats rows referencing this puzzle
		// so deleted puzzles don't linger in players' best-times lists with a
		// null name. Logged, not fatal — same rationale as ownership cleanup.
		await withDbBestEffort(
			c.env,
			`Failed to delete stats rows for puzzle ${id}:`,
			`Failed to init DB for ownership cleanup of puzzle ${id}:`,
			(db) => deletePuzzleStats(db, id)
		);

		// Delete assets from R2. pieceCount is 0 when metadata was corrupt
		// (only original + thumbnail are deleted; pieces may be orphaned).
		const deleteResult = await deletePuzzleAssets(c.env.PUZZLES_BUCKET, id, pieceCount);

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
