import { Hono } from 'hono';
import { getDb } from '../db';
import { getProfileOverride, upsertProfileOverride, getPlayerSummary } from '@perseus/shared';
import type { PlayerProfile } from '@perseus/types';
import { requirePlayerAuth } from '../middleware/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';

const player = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();

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

export default player;
