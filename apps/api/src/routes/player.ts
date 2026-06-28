import { Hono } from 'hono';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '../db';
import {
	getProfileOverride,
	updateProfileDisplayName,
	updateProfileAvatarUrl,
	getPlayerSummary,
	listPlayerPuzzles,
	listPlayerStats
} from '@perseus/shared';
import type { PlayerProfile } from '@perseus/types';
import { requirePlayerAuth } from '../middleware/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';

const player = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Sniff image MIME from magic bytes so the served Content-Type is correct
// regardless of the (extension-less) avatar path. Mirrors R2 httpMetadata.
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
	const db = getDb();
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
	const db = getDb();
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
	// displayName is required: a missing field is a client error, not a silent
	// reset to null. null explicitly clears the override back to the Google name.
	if (displayName === undefined) {
		return c.json({ error: 'bad_request', message: 'displayName is required' }, 400);
	}
	if (displayName !== null && typeof displayName !== 'string') {
		return c.json({ error: 'bad_request', message: 'displayName must be a string or null' }, 400);
	}
	// Field-specific update writes only displayName and preserves avatarUrl,
	// avoiding a read-modify-write race with concurrent POST /avatar requests.
	await updateProfileDisplayName(db, playerId, displayName);
	return c.json({ ok: true });
});

// Upload the authenticated player's avatar to the filesystem and record its
// serving path in the profile override (writes only avatarUrl; displayName is
// preserved by the field-specific repository update).
player.post('/avatar', requirePlayerAuth, async (c) => {
	const session = c.get('playerSession');
	const playerId = session.user.id;
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
	const dataDir = process.env.DATA_DIR || './data';
	const dir = join(dataDir, 'avatars');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, playerId), Buffer.from(await file.arrayBuffer()));

	const db = getDb();
	// Field-specific update writes only avatarUrl and preserves displayName,
	// avoiding a read-modify-write race with concurrent PATCH /profile requests.
	await updateProfileAvatarUrl(db, playerId, `/api/player/${playerId}/avatar`);
	return c.json({ avatarUrl: `/api/player/${playerId}/avatar` });
});

// Serve a player's avatar. Public (no auth) so avatars render anywhere.
player.get('/:playerId/avatar', async (c) => {
	const playerId = c.req.param('playerId');
	const dataDir = process.env.DATA_DIR || './data';
	const dir = join(dataDir, 'avatars');
	const filePath = join(dir, playerId);
	// Guard against path traversal: the resolved path must stay inside the
	// avatars directory (playerId comes from an untrusted URL segment).
	if (!filePath.startsWith(dir + '/') && filePath !== dir) {
		return c.json({ error: 'bad_request', message: 'Invalid player id' }, 400);
	}
	let buf: Buffer;
	try {
		buf = await readFile(filePath);
	} catch {
		return c.json({ error: 'not_found', message: 'Avatar not found' }, 404);
	}
	const mime = sniffImageType(new Uint8Array(buf)) ?? 'application/octet-stream';
	return new Response(buf, { headers: { 'Content-Type': mime } });
});

player.get('/puzzles', requirePlayerAuth, async (c) => {
	const db = getDb();
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
	const db = getDb();
	const session = c.get('playerSession');
	const limit = Number(c.req.query('limit') ?? '20');
	const { rows } = await listPlayerStats(db, session.user.id, {
		limit: Number.isFinite(limit) ? limit : 20
	});
	return c.json({ stats: rows });
});

export default player;
