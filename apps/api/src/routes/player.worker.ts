import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	clearProfileAvatarUrlIfOwned,
	getPlayerSummary,
	listPlayerPuzzles,
	listPlayerStats,
	sniffImageType,
	parseImageDimensions,
	validateImageEndMarker
} from '@perseus/shared';
import type { PlayerProfile, PlayerPuzzleSummary, PlayerStatRow } from '@perseus/types';
import {
	coercePuzzleStatus,
	isPlayerProfile,
	isPlayerPuzzleSummary,
	isPlayerStatRow
} from '@perseus/types';
import { requirePlayerAuth } from '../middleware/player-auth.worker';
import { avatarRateLimit, resetAvatarAttempts } from '../middleware/rate-limit.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

const player = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Cap avatar dimensions well above the 64x64 display size (retina-safe at 8x)
// but reject pathologically large images that would burn client render budget
// and R2 storage. The puzzle path enforces MAX_IMAGE_DIMENSION (4096) in the
// workflow; avatars have no server-side processing step, so the cap lives here.
const MAX_AVATAR_DIMENSION = 512;
// Matches the puzzle-name cap (admin routes). Bounds storage and prevents
// trivially large payloads from reaching D1.
const MAX_DISPLAY_NAME_LENGTH = 255;

player.get('/profile', requirePlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const playerId = session.user.id;
	// Independent reads — run concurrently to cut profile latency. Both hit
	// D1; awaiting sequentially would serialize two round-trips.
	const [override, summary] = await Promise.all([
		getProfileOverride(db, playerId),
		getPlayerSummary(db, playerId)
	]);

	const profile: PlayerProfile = {
		id: session.user.id,
		email: session.user.email,
		name: override?.displayName ?? session.user.name ?? session.user.email,
		picture: override?.avatarUrl ?? session.user.picture ?? null,
		createdAt: session.user.createdAt,
		lastLoginAt: session.user.lastLoginAt,
		summary
	};
	// Defense-in-depth: the profile is assembled from typed sources (session +
	// repository), but validate the final shape so a schema/contract drift
	// surfaces as a 500 rather than silently serving malformed data.
	if (!isPlayerProfile(profile)) {
		console.error(`Profile response failed validation for player ${playerId}`);
		return c.json({ error: 'internal_error', message: 'Failed to build profile' }, 500);
	}
	return c.json(profile);
});

player.patch('/profile', requirePlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const playerId = session.user.id;
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const raw =
		body && typeof body === 'object' && 'displayName' in body
			? (body as { displayName: unknown }).displayName
			: undefined;
	// displayName is required: a missing field is a client error, not a silent
	// reset to null. null explicitly clears the override back to the Google name.
	if (raw === undefined) {
		return c.json({ error: 'bad_request', message: 'displayName is required' }, 400);
	}
	if (raw !== null && typeof raw !== 'string') {
		return c.json({ error: 'bad_request', message: 'displayName must be a string or null' }, 400);
	}
	// Trim surrounding whitespace and reject empty/blank values so a profile
	// name can never be set to nothing (mirrors puzzle-name handling). null is
	// unaffected and still clears the override back to the Google name.
	let displayName = raw;
	if (typeof displayName === 'string') {
		displayName = displayName.trim();
		if (displayName === '') {
			return c.json({ error: 'bad_request', message: 'displayName must not be empty' }, 400);
		}
		if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
			return c.json(
				{ error: 'bad_request', message: 'displayName must be 255 characters or fewer' },
				400
			);
		}
	}
	// Field-specific update writes only displayName and preserves avatarUrl,
	// avoiding a read-modify-write race with concurrent POST /avatar requests.
	await updateProfileDisplayName(db, playerId, displayName);
	return c.json({ ok: true });
});

// Upload the authenticated player's avatar to R2 and record its serving path
// in the profile override (writes only avatarUrl; displayName is preserved by
// the field-specific repository update).
player.post('/avatar', requirePlayerAuth, avatarRateLimit, async (c) => {
	const session = c.get('playerSession');
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid form data' }, 400);
	}
	const file = formData.get('avatar');
	if (!(file instanceof File)) {
		return c.json({ error: 'bad_request', message: 'avatar file is required' }, 400);
	}
	if (file.size > AVATAR_MAX_BYTES) {
		return c.json({ error: 'bad_request', message: 'Avatar must be 5MB or less' }, 400);
	}
	// Validate via magic bytes instead of trusting file.type, matching the
	// puzzle upload path and the Bun player route. The sniffed type is stored
	// as R2 httpMetadata so the serve route returns the correct Content-Type.
	const bytes = new Uint8Array(await file.arrayBuffer());
	const detected = sniffImageType(bytes);
	if (!detected || !AVATAR_MIME.has(detected)) {
		return c.json({ error: 'bad_request', message: 'Unsupported image type' }, 400);
	}
	// Validate the image is not truncated/corrupted by parsing its dimensions.
	// sniffImageType only checks magic bytes (4 for JPEG, 8 for PNG, 12 for
	// WebP), so a file with just a valid header prefix but no image data would
	// pass the type check. parseImageDimensions returns null for truncated or
	// malformed headers, rejecting incomplete uploads before they reach R2.
	const dimensions = await parseImageDimensions(file, detected);
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
		return c.json({ error: 'bad_request', message: 'Image is corrupted or truncated' }, 400);
	}
	if (dimensions.width > MAX_AVATAR_DIMENSION || dimensions.height > MAX_AVATAR_DIMENSION) {
		return c.json(
			{
				error: 'bad_request',
				message: `Avatar dimensions must be ${MAX_AVATAR_DIMENSION}px or less in each axis`
			},
			400
		);
	}
	// Validate the image is structurally complete by checking for the format's
	// end marker (IEND for PNG, EOI for JPEG, RIFF size for WebP).
	// parseImageDimensions only validates the header; without this check a
	// file with a valid header but missing body/trailer would pass and be
	// stored as a corrupt avatar that renders broken for the player.
	const hasEndMarker = await validateImageEndMarker(file, detected);
	if (!hasEndMarker) {
		return c.json({ error: 'bad_request', message: 'Image is corrupted or truncated' }, 400);
	}
	const liveKey = `avatars/${session.user.id}`;
	// Write to a unique staging key first, then promote to the live key only
	// after the DB override write succeeds. This avoids two problems:
	//  1. Orphaned bytes: writing directly to the live key before the DB
	//     write would leave a publicly-reachable object at a predictable URL
	//     even when the request returns 500 (the serve route is public and
	//     reads the key without checking D1).
	//  2. TOCTOU on rollback: a blind delete of the live key after a DB
	//     failure could remove a concurrent upload's object. The staging key
	//     is unique to this upload, so deleting it on failure is always safe.
	const stagingKey = `avatars/staging/${session.user.id}/${crypto.randomUUID()}`;
	await c.env.PUZZLES_BUCKET.put(stagingKey, bytes, {
		httpMetadata: { contentType: detected }
	});

	const db = getWorkerDb(c.env);
	// Field-specific update writes only avatarUrl and preserves displayName,
	// avoiding a read-modify-write race with concurrent PATCH /profile requests.
	// Capture the updatedAt timestamp so the live-put-failure rollback can be
	// owner-checked: only null avatarUrl if no concurrent upload has since
	// overwritten the row (detected via updatedAt mismatch). An unconditional
	// clear would clobber a concurrent winner's avatar.
	const avatarUpdatedAt = Date.now();
	try {
		await updateProfileAvatarUrl(
			db,
			session.user.id,
			`/api/player/${session.user.id}/avatar`,
			avatarUpdatedAt
		);
	} catch (err) {
		console.error('Avatar DB write failed; cleaning up staged R2 object:', err);
		// Safe to delete unconditionally: stagingKey is unique to this upload.
		// No concurrent upload can write to or claim this key.
		await c.env.PUZZLES_BUCKET.delete(stagingKey);
		return c.json({ error: 'internal_error', message: 'Failed to update avatar' }, 500);
	}
	// DB succeeded — promote the staged bytes to the live key. We hold the
	// bytes in memory, so re-put to the canonical key. A concurrent upload
	// may also put to this key; last write wins (both are valid avatars).
	//
	// If the live put fails (transient R2/quota error), the DB now points at
	// a serve route that 404s for first-time avatars. Roll back the avatarUrl
	// flag so the profile doesn't reference a missing object, and clean up
	// the staged object. For a re-upload of an existing avatar, the old live
	// object still serves (no 404); clearing the flag is a cosmetic
	// regression only on this rare transient-failure path. The rollback is
	// owner-checked on avatarUpdatedAt: if a concurrent upload's DB write
	// has since overwritten this row (its updatedAt differs), the clear is
	// a no-op and that upload's avatar is preserved.
	try {
		await c.env.PUZZLES_BUCKET.put(liveKey, bytes, {
			httpMetadata: { contentType: detected }
		});
	} catch (err) {
		console.error('Avatar live R2 put failed; rolling back DB avatarUrl:', err);
		await clearProfileAvatarUrlIfOwned(db, session.user.id, avatarUpdatedAt).catch((rollbackErr) =>
			console.error('Failed to roll back avatarUrl after live put failure:', rollbackErr)
		);
		await c.env.PUZZLES_BUCKET.delete(stagingKey).catch(() => {});
		return c.json({ error: 'internal_error', message: 'Failed to store avatar' }, 500);
	}
	// Best-effort cleanup of the staging object. If this delete fails the
	// staging key lingers (it is not reachable by the serve route, which
	// reads only the live key, so this is a storage-cost concern, not a
	// correctness one). There is no automated sweep — see
	// docs/OPERATOR_RUNBOOK.md §6 "Out of scope: avatar staging orphans" for
	// manual cleanup. Swallow transient failures so a cleanup error does not
	// turn an already-successful upload (live R2 object + DB override in
	// place) into a 500 before the success response and rate-limit reset
	// reach the client.
	await c.env.PUZZLES_BUCKET.delete(stagingKey).catch((err) => {
		console.error('Failed to clean up staging avatar object:', err);
	});
	// Reset the rate-limit counter on success so repeated successful uploads
	// don't accumulate toward an unnecessary lockout. The middleware increments
	// before the handler runs; this deletes that increment.
	await resetAvatarAttempts(c);
	return c.json({ avatarUrl: `/api/player/${session.user.id}/avatar` });
});

// Serve a player's avatar from R2. Public (no auth) so avatars render anywhere.
player.get('/:playerId/avatar', async (c) => {
	const playerId = c.req.param('playerId');
	const obj = await c.env.PUZZLES_BUCKET.get(`avatars/${playerId}`);
	if (!obj) return c.json({ error: 'not_found', message: 'Avatar not found' }, 404);
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	// Defense-in-depth: R2 httpMetadata sets Content-Type from the sniffed
	// value at upload time, but nosniff prevents a browser from second-guessing
	// and executing a disguised payload as a different content type.
	headers.set('X-Content-Type-Options', 'nosniff');
	return new Response(obj.body, { headers });
});

player.get('/puzzles', requirePlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const cursor = c.req.query('cursor') || undefined;
	const { rows, nextCursor } = await listPlayerPuzzles(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20,
		cursor
	});
	// Project DB rows to the public PlayerPuzzleSummary contract, stripping
	// internal columns (e.g. ownerId) that the client doesn't need.
	const puzzles: PlayerPuzzleSummary[] = rows.map((r) => ({
		id: r.id,
		name: r.name,
		pieceCount: r.pieceCount,
		status: coercePuzzleStatus(r.status),
		createdAt: r.createdAt,
		...(r.category ? { category: r.category } : {})
	}));
	// Validate each projected row so a schema/contract drift surfaces as a 500
	// rather than silently serving malformed data to the client.
	if (!puzzles.every(isPlayerPuzzleSummary)) {
		console.error(`Player puzzles response failed validation for player ${session.user.id}`);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
	return c.json({ puzzles, nextCursor });
});

player.get('/stats', requirePlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const cursor = c.req.query('cursor') || undefined;
	const { rows, nextCursor } = await listPlayerStats(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20,
		...(cursor !== undefined ? { cursor } : {})
	});
	// Project DB rows to the public PlayerStatRow contract, stripping playerId
	// (the client already knows its own ID from the auth session).
	const stats: PlayerStatRow[] = rows.map((r) => ({
		puzzleId: r.puzzleId,
		puzzleName: r.puzzleName,
		bestTimeSeconds: r.bestTimeSeconds,
		totalCompletions: r.totalCompletions,
		firstCompletedAt: r.firstCompletedAt,
		lastCompletedAt: r.lastCompletedAt
	}));
	// Validate each projected row so a schema/contract drift surfaces as a 500
	// rather than silently serving malformed data to the client.
	if (!stats.every(isPlayerStatRow)) {
		console.error(`Player stats response failed validation for player ${session.user.id}`);
		return c.json({ error: 'internal_error', message: 'Failed to list stats' }, 500);
	}
	return c.json({ stats, nextCursor });
});

export default player;
