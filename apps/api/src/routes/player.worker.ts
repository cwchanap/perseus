import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	getPlayerSummary,
	listPlayerPuzzles,
	listPlayerStats
} from '@perseus/shared';
import type { PlayerProfile, PlayerPuzzleSummary, PlayerStatRow } from '@perseus/types';
import { coercePuzzleStatus } from '@perseus/types';
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

// Sniff image MIME from magic bytes. Mirrors the Bun player route and the
// puzzle upload path: never trust the client-supplied Content-Type.
function sniffImageType(bytes: Uint8Array): string | null {
	if (bytes.length < 12) return null;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return 'image/png';
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return 'image/webp';
	return null;
}

player.get('/profile', requirePlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const playerId = session.user.id;
	const override = await getProfileOverride(db, playerId);
	const summary = await getPlayerSummary(db, playerId);

	const profile: PlayerProfile = {
		id: session.user.id,
		email: session.user.email,
		name: override?.displayName ?? session.user.name ?? session.user.email,
		picture: override?.avatarUrl ?? session.user.picture ?? null,
		createdAt: session.user.createdAt,
		lastLoginAt: session.user.lastLoginAt,
		summary
	};
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
	await c.env.PUZZLES_BUCKET.put(key, bytes, {
		httpMetadata: { contentType: detected }
	});

	const db = getWorkerDb(c.env);
	// Field-specific update writes only avatarUrl and preserves displayName,
	// avoiding a read-modify-write race with concurrent PATCH /profile requests.
	await updateProfileAvatarUrl(db, session.user.id, `/api/player/${session.user.id}/avatar`);
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
	return c.json({ puzzles, nextCursor });
});

player.get('/stats', requirePlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const cursor = c.req.query('cursor');
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
	return c.json({ stats, nextCursor });
});

export default player;
