import { describe, it, expect, vi, beforeEach } from 'vitest';
import leaderboard from './leaderboard.worker';
import * as playerAuth from '../services/player-auth.worker';
import type { Env } from '../worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';
import type { OverallLeaderboardResponse } from '@perseus/types';

const mocks = vi.hoisted(() => ({
	listOverallLeaderboard: vi.fn(),
	resolveLeaderboardIdentities: vi.fn()
}));

vi.mock('../db.worker', () => ({
	getWorkerDb: vi.fn(() => ({}))
}));

vi.mock('@perseus/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/shared')>();
	return {
		...actual,
		listOverallLeaderboard: mocks.listOverallLeaderboard,
		resolveLeaderboardIdentities: mocks.resolveLeaderboardIdentities
	};
});

vi.mock('../services/player-auth.worker', () => ({
	getPlayerSession: vi.fn(),
	PLAYER_SESSION_COOKIE: 'perseus_player_session'
}));

const TEST_ENV = { PUZZLE_METADATA: {} as KVNamespace } as unknown as Env;

const VIEWER_SESSION: PlayerSessionRecord = {
	sessionHash: 'tok',
	user: {
		id: 'viewer',
		email: 'viewer@example.com',
		name: 'Viewer',
		createdAt: 1,
		lastLoginAt: 2
	},
	createdAt: 1,
	expiresAt: 9999999999999
};

describe('GET /api/leaderboard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listOverallLeaderboard.mockResolvedValue({
			entries: [
				{
					rank: 1,
					playerId: 'p1',
					score: 500,
					easyClears: 2,
					normalClears: 1,
					hardClears: 0
				}
			]
		});
		mocks.resolveLeaderboardIdentities.mockResolvedValue(
			new Map([['p1', { id: 'p1', name: 'Ace', avatarUrl: null }]])
		);
	});

	it('returns overall leaderboard entries without email', async () => {
		const response = await leaderboard.fetch(new Request('http://localhost/'), TEST_ENV);
		expect(response.status).toBe(200);
		const body = (await response.json()) as OverallLeaderboardResponse;
		expect(body.entries[0]).toEqual({
			rank: 1,
			player: { id: 'p1', name: 'Ace', avatarUrl: null },
			score: 500,
			easyClears: 2,
			normalClears: 1,
			hardClears: 0
		});
		expect(body.entries[0].player).not.toHaveProperty('email');
	});

	it('includes viewer row when outside top 50', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(VIEWER_SESSION);
		mocks.listOverallLeaderboard.mockResolvedValue({
			entries: [],
			me: {
				rank: 51,
				playerId: 'viewer',
				score: 100,
				easyClears: 1,
				normalClears: 0,
				hardClears: 0
			}
		});
		mocks.resolveLeaderboardIdentities.mockResolvedValue(
			new Map([['viewer', { id: 'viewer', name: 'Viewer', avatarUrl: null }]])
		);
		const response = await leaderboard.fetch(
			new Request('http://localhost/', {
				headers: { Cookie: 'perseus_player_session=tok' }
			}),
			TEST_ENV
		);
		const body = (await response.json()) as OverallLeaderboardResponse;
		expect(body.me?.rank).toBe(51);
		expect(body.me?.player).not.toHaveProperty('email');
		expect(mocks.listOverallLeaderboard).toHaveBeenCalledWith({}, { viewerPlayerId: 'viewer' });
	});
});
