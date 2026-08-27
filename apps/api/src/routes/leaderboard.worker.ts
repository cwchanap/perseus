import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import {
	listOverallLeaderboard,
	resolveLeaderboardIdentities,
	type LeaderboardIdentityRow
} from '@perseus/shared';
import {
	isOverallLeaderboardEntry,
	type OverallLeaderboardEntry,
	type OverallLeaderboardResponse
} from '@perseus/types';
import { optionalPlayerAuth } from '../middleware/optional-player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

const leaderboard = new Hono<{
	Bindings: Env;
	Variables: { playerSession?: PlayerSessionRecord };
}>();

function toPublicIdentity(row: LeaderboardIdentityRow) {
	return {
		id: row.id,
		name: row.name,
		avatarUrl: row.avatarUrl
			? row.avatarUrl.startsWith('/')
				? row.avatarUrl
				: row.avatarUrl
			: null
	};
}

function resolveAvatarUrl(playerId: string, avatarUrl: string | null): string | null {
	if (!avatarUrl) return null;
	if (avatarUrl.startsWith('/api/player/')) return avatarUrl;
	return `/api/player/${playerId}/avatar`;
}

leaderboard.get('/', optionalPlayerAuth, async (c) => {
	const db = getWorkerDb(c.env);
	const viewerPlayerId = c.get('playerSession')?.user.id;
	const raw = await listOverallLeaderboard(db, { viewerPlayerId });
	const playerIds = [
		...raw.entries.map((entry) => entry.playerId),
		...(raw.me ? [raw.me.playerId] : [])
	];
	const identities = await resolveLeaderboardIdentities(db, playerIds);
	const entries: OverallLeaderboardEntry[] = raw.entries.map((entry) => {
		const identity = identities.get(entry.playerId)!;
		return {
			rank: entry.rank,
			player: {
				id: identity.id,
				name: identity.name,
				avatarUrl: resolveAvatarUrl(identity.id, identity.avatarUrl)
			},
			score: entry.score,
			easyClears: entry.easyClears,
			normalClears: entry.normalClears,
			hardClears: entry.hardClears
		};
	});
	const response: OverallLeaderboardResponse = { entries };
	if (raw.me) {
		const identity = identities.get(raw.me.playerId)!;
		response.me = {
			rank: raw.me.rank,
			player: {
				id: identity.id,
				name: identity.name,
				avatarUrl: resolveAvatarUrl(identity.id, identity.avatarUrl)
			},
			score: raw.me.score,
			easyClears: raw.me.easyClears,
			normalClears: raw.me.normalClears,
			hardClears: raw.me.hardClears
		};
	}
	if (!entries.every(isOverallLeaderboardEntry)) {
		return c.json({ error: 'internal_error', message: 'Failed to build leaderboard' }, 500);
	}
	return c.json(response);
});

export default leaderboard;
