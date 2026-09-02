import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUser } from '@perseus/types';

vi.mock('../../services/player-auth.shared', () => ({
	OAUTH_STATE_TTL_SECONDS: 10 * 60,
	PLAYER_SESSION_DURATION_MS: 30 * 24 * 60 * 60 * 1000,
	createOAuthState: vi.fn(),
	createPkcePair: vi.fn(),
	encryptOAuthState: vi.fn(),
	decryptOAuthState: vi.fn(),
	resolveAllowedOrigins: vi.fn(),
	parseReturnTo: vi.fn(),
	buildGoogleAuthUrl: vi.fn(),
	exchangeGoogleCode: vi.fn(),
	verifyGoogleIdToken: vi.fn()
}));

vi.mock('../../services/player-auth.worker', () => ({
	getAllowlistEntry: vi.fn(),
	upsertPlayer: vi.fn(),
	createPlayerSession: vi.fn(),
	revokePlayerSession: vi.fn()
}));

// NOTE: the rate-limit middleware is deliberately NOT mocked here — this file
// pins that POST /mobile/google is wired to the real oauthRateLimit and
// rejects with 429 once the shared OAuth bucket trips.

import auth from '../auth.worker';
import { __resetRateLimitStore } from '../../middleware/rate-limit.worker';
import * as sharedAuth from '../../services/player-auth.shared';
import * as playerAuth from '../../services/player-auth.worker';

const claims = {
	sub: 'google-sub-123',
	email: 'player@example.com',
	name: 'Player One',
	picture: 'https://example.com/avatar.png'
};

const player: PlayerUser = {
	id: 'google-sub-123',
	email: 'player@example.com',
	name: 'Player One',
	picture: 'https://example.com/avatar.png',
	createdAt: 1_716_500_000_000,
	lastLoginAt: 1_716_500_000_000
};

function createMockKV() {
	const store = new Map<string, string>();
	return {
		get: async (key: string, type?: string) => {
			const value = store.get(key);
			if (!value) return null;
			if (type === 'json') return JSON.parse(value);
			return value;
		},
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
		_store: store
	};
}

function mobileExchangeRequest(): Request {
	return new Request('https://app.example.com/mobile/google', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'cf-connecting-ip': '192.0.2.10'
		},
		body: JSON.stringify({ idToken: 'native-google-id-token' })
	});
}

describe('mobile token exchange rate limiting', () => {
	beforeEach(() => {
		__resetRateLimitStore();
		vi.clearAllMocks();
		vi.mocked(sharedAuth.verifyGoogleIdToken).mockResolvedValue(claims);
		vi.mocked(playerAuth.getAllowlistEntry).mockResolvedValue({
			email: 'player@example.com',
			createdAt: 1_716_400_000_000,
			addedBy: 'admin'
		});
		vi.mocked(playerAuth.upsertPlayer).mockResolvedValue(player);
		vi.mocked(playerAuth.createPlayerSession).mockResolvedValue({
			token: 'player-session-token',
			expiresAt: 1_719_092_000_000
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('allows the first ten exchanges and rejects the eleventh with 429', async () => {
		const env = { PUZZLE_METADATA: createMockKV(), GOOGLE_CLIENT_ID: 'google-client-id' };

		for (let i = 0; i < 10; i++) {
			const res = await auth.fetch(mobileExchangeRequest(), env);
			expect(res.status).toBe(200);
		}

		const blocked = await auth.fetch(mobileExchangeRequest(), env);

		expect(blocked.status).toBe(429);
		expect(blocked.headers.get('Retry-After')).toBe('900');
		expect(await blocked.json()).toMatchObject({ error: 'too_many_requests' });
		expect(playerAuth.createPlayerSession).toHaveBeenCalledTimes(10);
	});
});
