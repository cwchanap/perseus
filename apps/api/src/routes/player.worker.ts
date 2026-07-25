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
	const hasEndMarker = await validateImageEndMarker(file, detected, {
		requireFullDecode: true
	});
	if (!hasEndMarker) {
		return c.json({ error: 'bad_request', message: 'Image is corrupted or truncated' }, 400);
	}
	const playerId = session.user.id;
	const avatarUpdateToken = crypto.randomUUID();
	// Capture the previous avatarUpdateToken BEFORE uploading, so we can
	// delete the superseded versioned R2 object after the new upload's D1
	// write succeeds. Without this, repeated successful uploads accumulate
	// up to 5 MB each indefinitely (every upload writes a unique versioned
	// key; the serve route only reads the D1-selected one, so superseded
	// objects are unreachable storage waste).
	//
	// The legacy unversioned key (avatars/{playerId}, used before the
	// versioned-key migration) is intentionally NOT captured here — it
	// serves as a fallback when D1 is unavailable (see the serve route), so
	// deleting it would remove that safety net. Only previous versioned
	// keys (with a token) are reclaimed.
	const db = getWorkerDb(c.env);
	let previousToken: string | null = null;
	try {
		const existingOverride = await getProfileOverride(db, playerId);
		previousToken = existingOverride?.avatarUpdateToken ?? null;
	} catch (err) {
		// D1 read failed — we can't know the previous token, so we skip
		// cleanup. The old versioned object (if any) lingers, but the
		// upload still succeeds. This is no worse than the previous
		// behavior (which never cleaned up).
		console.error('Avatar upload: failed to read previous override for cleanup:', err);
	}
	// Write to a versioned R2 key (avatars/{playerId}/{token}) instead of a
	// fixed key (avatars/{playerId}). This eliminates the concurrent-upload
	// race where two uploads both write to the same key and the last R2
	// write wins regardless of which D1 row is authoritative. With versioned
	// keys, each upload writes to a unique key, and D1's avatarUpdateToken
	// selects which version the serve route reads.
	const versionedKey = `avatars/${playerId}/${avatarUpdateToken}`;
	try {
		await c.env.PUZZLES_BUCKET.put(versionedKey, bytes, {
			httpMetadata: { contentType: detected }
		});
	} catch (err) {
		console.error('Avatar R2 put failed:', err);
		return c.json({ error: 'internal_error', message: 'Failed to store avatar' }, 500);
	}

	// Field-specific update writes only avatarUrl and preserves displayName,
	// avoiding a read-modify-write race with concurrent PATCH /profile requests.
	// The avatarUpdateToken stored here is what the serve route reads to
	// determine which versioned R2 key to serve — D1 is the source of truth
	// for which upload's avatar is currently live.
	const avatarUpdatedAt = Date.now();
	try {
		await updateProfileAvatarUrl(
			db,
			playerId,
			`/api/player/${playerId}/avatar`,
			avatarUpdatedAt,
			avatarUpdateToken
		);
	} catch (err) {
		console.error('Avatar DB write failed; cleaning up versioned R2 object:', err);
		// Safe to delete unconditionally: versionedKey is unique to this
		// upload (token is a UUID). No concurrent upload can write to or
		// claim this key.
		await c.env.PUZZLES_BUCKET.delete(versionedKey).catch(() => {});
		return c.json({ error: 'internal_error', message: 'Failed to update avatar' }, 500);
	}
	// Reclaim the superseded versioned R2 object. Re-read D1 to determine
	// which token is now authoritative, then delete whichever object is
	// definitively no longer reachable:
	//   - If our token is still authoritative, delete the previous token's
	//     object (our write replaced it).
	//   - If another upload's token overwrote ours, delete OUR versionedKey
	//     — it is unreachable storage waste (the serve route reads the
	//     winning token's key). Without this branch, two overlapping uploads
	//     that both read the same previousToken O would leave the losing
	//     upload's object orphaned: A reads O, B reads O, A writes token A,
	//     B writes token B (overwriting A), A re-reads and sees B (does
	//     nothing under the old logic), B deletes O — token A's object
	//     lingers forever.
	// R2 delete is idempotent, so a concurrent upload that captured the
	// same previousToken and also deletes it is harmless (a no-op on a
	// missing key). Each upload only ever deletes a key it can prove is
	// not the currently-served one, so two concurrent uploads cannot delete
	// each other's just-written authoritative key.
	if (previousToken && previousToken !== avatarUpdateToken) {
		try {
			const currentOverride = await getProfileOverride(db, playerId);
			if (currentOverride?.avatarUpdateToken === avatarUpdateToken) {
				await c.env.PUZZLES_BUCKET.delete(`avatars/${playerId}/${previousToken}`).catch((err) =>
					console.error('Avatar upload: failed to delete superseded R2 object:', err)
				);
			} else {
				// Another upload overwrote our token — our versionedKey is
				// definitively no longer authoritative. Delete it to avoid
				// an unreachable orphan. The winning upload cleans up its
				// own previousToken (which may be ours — the idempotent R2
				// delete makes the double-delete harmless).
				await c.env.PUZZLES_BUCKET.delete(versionedKey).catch((err) =>
					console.error('Avatar upload: failed to delete losing R2 object:', err)
				);
			}
		} catch (err) {
			console.error('Avatar upload: failed to re-read override for cleanup:', err);
		}
	}
	// Reset the rate-limit counter on success so repeated successful uploads
	// don't accumulate toward an unnecessary lockout. The middleware increments
	// before the handler runs; this deletes that increment.
	await resetAvatarAttempts(c);
	return c.json({ avatarUrl: `/api/player/${playerId}/avatar` });
});

// Serve a player's avatar from R2. Public (no auth) so avatars render anywhere.
// Reads D1 to determine which versioned R2 key to serve (avatars/{playerId}/{token}),
// so the D1-selected upload's avatar is always served regardless of concurrent
// upload ordering. Falls back to the legacy unversioned key (avatars/{playerId})
// for avatars uploaded before the versioned-key migration.
player.get('/:playerId/avatar', async (c) => {
	const playerId = c.req.param('playerId');
	// D1 lookup is best-effort: if D1 is unavailable (outage, migrations not
	// yet applied, query error), fall back to the legacy unversioned R2 key
	// rather than 500-ing. Avatars uploaded before the versioned-key
	// migration live at the legacy key, so this fallback preserves
	// availability during D1 degradation. Every request still incurs a D1
	// query when D1 is healthy (the token selects which versioned key to
	// serve), but a failure must not block serving a legacy avatar.
	let override: Awaited<ReturnType<typeof getProfileOverride>> = null;
	try {
		const db = getWorkerDb(c.env);
		override = await getProfileOverride(db, playerId);
	} catch (err) {
		console.error(
			`Avatar serve: D1 override lookup failed for ${playerId}, falling back to legacy key:`,
			err
		);
	}
	// If the override has an avatarUpdateToken, serve from the versioned key.
	// If not (null — pre-migration avatar, no avatar, or D1 lookup failed),
	// fall back to the legacy unversioned key for backward compatibility.
	const r2Key = override?.avatarUpdateToken
		? `avatars/${playerId}/${override.avatarUpdateToken}`
		: `avatars/${playerId}`;
	const obj = await c.env.PUZZLES_BUCKET.get(r2Key);
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
