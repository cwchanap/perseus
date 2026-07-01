import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	getPlayerSummary,
	listPlayerPuzzles,
	listPlayerStats,
	sniffImageType
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
	const key = `avatars/${session.user.id}`;
	// Capture the prior avatar (if any) so we can restore it if the DB
	// override write below fails. Without this, a DB failure would leave the
	// new bytes in R2 while the profile points at the same URL — orphaning the
	// overwrite and destroying the previously-working avatar.
	const prior = await c.env.PUZZLES_BUCKET.get(key);
	let priorBytes: ArrayBuffer | null = null;
	let priorContentType: string | null = null;
	if (prior) {
		priorBytes = await prior.arrayBuffer();
		priorContentType = prior.httpMetadata?.contentType ?? null;
	}
	// Capture the etag of our new put so the rollback can use a conditional
	// restore. If another concurrent upload overwrites this key before our
	// DB write fails, the conditional restore will not clobber the newer
	// upload's object.
	const putResult = await c.env.PUZZLES_BUCKET.put(key, bytes, {
		httpMetadata: { contentType: detected }
	});

	const db = getWorkerDb(c.env);
	// Field-specific update writes only avatarUrl and preserves displayName,
	// avoiding a read-modify-write race with concurrent PATCH /profile requests.
	try {
		await updateProfileAvatarUrl(db, session.user.id, `/api/player/${session.user.id}/avatar`);
	} catch (err) {
		console.error('Avatar DB write failed; rolling back R2 object:', err);
		if (priorBytes) {
			// Conditional restore: only overwrite if R2 still holds the bytes
			// we just put. If another upload has since overwritten the key,
			// this precondition fails (put returns null) and we leave the
			// newer upload intact rather than clobbering it.
			await c.env.PUZZLES_BUCKET.put(key, priorBytes, {
				httpMetadata: {
					contentType: priorContentType ?? detected
				},
				onlyIf: { etagMatches: putResult.etag }
			});
		}
		// If no prior avatar existed, leave the orphaned bytes in place rather
		// than deleting — the DB write failed so the profile doesn't point at
		// this key, and a blind delete could remove another concurrent
		// upload's object (TOCTOU: this upload read "no prior", put its bytes,
		// then a second upload put+committed its own bytes before this
		// rollback runs). The orphan is harmless and will be overwritten on
		// the next successful upload.
		return c.json({ error: 'internal_error', message: 'Failed to update avatar' }, 500);
	}
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
