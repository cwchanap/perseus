import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import {
	getProfileOverride,
	upsertProfileOverride,
	getPlayerSummary,
	listPlayerPuzzles,
	listPlayerStats
} from '@perseus/shared';
import type { PlayerProfile } from '@perseus/types';
import { requirePlayerAuth } from '../middleware/player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

const player = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
	const displayName =
		body && typeof body === 'object' && 'displayName' in body
			? (body as { displayName: unknown }).displayName
			: undefined;
	if (displayName !== null && displayName !== undefined && typeof displayName !== 'string') {
		return c.json({ error: 'bad_request', message: 'displayName must be a string or null' }, 400);
	}
	// Preserve existing avatarUrl on a name-only PATCH.
	const existing = await getProfileOverride(db, playerId);
	await upsertProfileOverride(db, playerId, {
		displayName: (displayName as string | null) ?? null,
		avatarUrl: existing?.avatarUrl ?? null
	});
	return c.json({ ok: true });
});

// Upload the authenticated player's avatar to R2 and record its serving path
// in the profile override (existing displayName is preserved).
player.post('/avatar', requirePlayerAuth, async (c) => {
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
	if (!AVATAR_MIME.has(file.type)) {
		return c.json({ error: 'bad_request', message: 'Unsupported image type' }, 400);
	}
	if (file.size > AVATAR_MAX_BYTES) {
		return c.json({ error: 'bad_request', message: 'Avatar must be 5MB or less' }, 400);
	}
	const key = `avatars/${session.user.id}`;
	await c.env.PUZZLES_BUCKET.put(key, file.stream(), {
		httpMetadata: { contentType: file.type }
	});

	const db = getWorkerDb(c.env);
	const existing = await getProfileOverride(db, session.user.id);
	await upsertProfileOverride(db, session.user.id, {
		displayName: existing?.displayName ?? null,
		avatarUrl: `/api/player/${session.user.id}/avatar`
	});
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
	const cursorRaw = c.req.query('cursor');
	const cursor = cursorRaw ? Number(cursorRaw) : undefined;
	const { rows, nextCursor } = await listPlayerPuzzles(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20,
		cursor: Number.isFinite(cursor) ? cursor : undefined
	});
	return c.json({ puzzles: rows, nextCursor });
});

player.get('/stats', requirePlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const { rows } = await listPlayerStats(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20
	});
	return c.json({ stats: rows });
});

export default player;
