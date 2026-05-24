import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUser } from '@perseus/types';

vi.mock('../../services/player-auth.shared', async () => {
	return {
		PLAYER_SESSION_DURATION_MS: 30 * 24 * 60 * 60 * 1000,
		createOAuthState: vi.fn(() => 'oauth-state-token'),
		createPkcePair: vi.fn(() =>
			Promise.resolve({
				verifier: 'pkce-verifier',
				challenge: 'pkce-challenge'
			})
		),
		parseReturnTo: vi.fn((value: string | null | undefined) => {
			if (!value) return '/';
			if (!value.startsWith('/') || value.startsWith('//')) return '/';
			try {
				const parsed = new URL(value, 'https://perseus.local');
				if (parsed.origin !== 'https://perseus.local') return '/';
				return `${parsed.pathname}${parsed.search}${parsed.hash}`;
			} catch {
				return '/';
			}
		}),
		buildGoogleAuthUrl: vi.fn(
			(params: { clientId: string; redirectUri: string; state: string; codeChallenge: string }) => {
				const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
				url.searchParams.set('client_id', params.clientId);
				url.searchParams.set('redirect_uri', params.redirectUri);
				url.searchParams.set('response_type', 'code');
				url.searchParams.set('scope', 'openid email profile');
				url.searchParams.set('state', params.state);
				url.searchParams.set('code_challenge', params.codeChallenge);
				url.searchParams.set('code_challenge_method', 'S256');
				return url;
			}
		),
		exchangeGoogleCode: vi.fn(),
		verifyGoogleIdToken: vi.fn()
	};
});

vi.mock('../../services/player-auth.worker', () => ({
	storeOAuthState: vi.fn(),
	consumeOAuthState: vi.fn(),
	getAllowlistEntry: vi.fn(),
	upsertPlayer: vi.fn(),
	createPlayerSession: vi.fn(),
	getPlayerSession: vi.fn(),
	revokePlayerSession: vi.fn()
}));

import auth from '../auth.worker';
import * as sharedAuth from '../../services/player-auth.shared';
import * as playerAuth from '../../services/player-auth.worker';

const kv = {} as KVNamespace;
const env = {
	PUZZLE_METADATA: kv,
	GOOGLE_CLIENT_ID: 'google-client-id',
	GOOGLE_CLIENT_SECRET: 'google-client-secret',
	AUTH_REDIRECT_BASE_URL: 'https://app.example.com',
	NODE_ENV: 'development'
};

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

function request(path: string, init: RequestInit = {}): Request {
	return new Request(`https://app.example.com${path}`, init);
}

describe('Worker player auth routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.setSystemTime(1_716_500_000_000);
		vi.mocked(sharedAuth.exchangeGoogleCode).mockResolvedValue({ id_token: 'google-id-token' });
		vi.mocked(sharedAuth.verifyGoogleIdToken).mockResolvedValue(claims);
		vi.mocked(playerAuth.storeOAuthState).mockResolvedValue(undefined);
		vi.mocked(playerAuth.consumeOAuthState).mockResolvedValue({
			state: 'oauth-state-token',
			codeVerifier: 'pkce-verifier',
			returnTo: '/puzzle/abc',
			createdAt: 1_716_500_000_000
		});
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
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue({
			sessionHash: 'session-hash',
			user: player,
			createdAt: 1_716_500_000_000,
			expiresAt: 1_719_092_000_000
		});
		vi.mocked(playerAuth.revokePlayerSession).mockResolvedValue(undefined);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('redirects Google starts, stores state with returnTo, and sets the state cookie', async () => {
		const res = await auth.fetch(request('/google/start?returnTo=/puzzle/abc?piece=1'), env);
		const location = new URL(res.headers.get('Location') ?? '');
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(location.origin).toBe('https://accounts.google.com');
		expect(location.pathname).toBe('/o/oauth2/v2/auth');
		expect(location.searchParams.get('client_id')).toBe('google-client-id');
		expect(location.searchParams.get('redirect_uri')).toBe(
			'https://app.example.com/api/auth/google/callback'
		);
		expect(location.searchParams.get('state')).toBe('oauth-state-token');
		expect(location.searchParams.get('code_challenge')).toBe('pkce-challenge');
		expect(playerAuth.storeOAuthState).toHaveBeenCalledWith(kv, 'oauth-state-token', {
			codeVerifier: 'pkce-verifier',
			returnTo: '/puzzle/abc?piece=1'
		});
		expect(setCookie).toContain('perseus_oauth_state=oauth-state-token');
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Max-Age=600');
	});

	it('sanitizes unsafe start returnTo values to root', async () => {
		await auth.fetch(request('/google/start?returnTo=https://evil.example/puzzle/abc'), env);

		expect(playerAuth.storeOAuthState).toHaveBeenCalledWith(kv, 'oauth-state-token', {
			codeVerifier: 'pkce-verifier',
			returnTo: '/'
		});
	});

	it.each([
		['missing state', '/google/callback?code=auth-code', 'perseus_oauth_state=oauth-state-token'],
		[
			'missing code',
			'/google/callback?state=oauth-state-token',
			'perseus_oauth_state=oauth-state-token'
		],
		[
			'mismatched state cookie',
			'/google/callback?state=oauth-state-token&code=auth-code',
			'perseus_oauth_state=other-state'
		]
	])('rejects callback with %s', async (_name, path, cookie) => {
		const res = await auth.fetch(request(path, { headers: { Cookie: cookie } }), env);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=session_expired');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
		expect(playerAuth.consumeOAuthState).not.toHaveBeenCalled();
	});

	it('rejects callback when consumed state is missing', async () => {
		vi.mocked(playerAuth.consumeOAuthState).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: { Cookie: 'perseus_oauth_state=oauth-state-token' }
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=session_expired');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('redirects not-allowlisted callback users to login', async () => {
		vi.mocked(playerAuth.getAllowlistEntry).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: { Cookie: 'perseus_oauth_state=oauth-state-token' }
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(playerAuth.getAllowlistEntry).toHaveBeenCalledWith(kv, 'player@example.com');
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=not_allowed');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('creates a player session for allowlisted verified users', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: { Cookie: 'perseus_oauth_state=oauth-state-token' }
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(sharedAuth.exchangeGoogleCode).toHaveBeenCalledWith({
			code: 'auth-code',
			clientId: 'google-client-id',
			clientSecret: 'google-client-secret',
			redirectUri: 'https://app.example.com/api/auth/google/callback',
			codeVerifier: 'pkce-verifier'
		});
		expect(sharedAuth.verifyGoogleIdToken).toHaveBeenCalledWith(
			'google-id-token',
			'google-client-id'
		);
		expect(playerAuth.upsertPlayer).toHaveBeenCalledWith(kv, claims);
		expect(playerAuth.createPlayerSession).toHaveBeenCalledWith(kv, player);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/puzzle/abc');
		expect(setCookie).toContain('perseus_player_session=player-session-token');
		expect(setCookie).toContain('Max-Age=2592000');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('redirects Google callback errors to login', async () => {
		vi.mocked(sharedAuth.exchangeGoogleCode).mockRejectedValue(new Error('token exchange failed'));

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: { Cookie: 'perseus_oauth_state=oauth-state-token' }
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=google_error');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('returns unauthenticated when no player session cookie exists', async () => {
		const res = await auth.fetch(request('/session'), env);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ authenticated: false });
		expect(playerAuth.getPlayerSession).not.toHaveBeenCalled();
	});

	it('returns authenticated user for a valid session', async () => {
		const res = await auth.fetch(
			request('/session', { headers: { Cookie: 'perseus_player_session=player-session-token' } }),
			env
		);

		expect(await res.json()).toEqual({ authenticated: true, user: player });
		expect(playerAuth.getPlayerSession).toHaveBeenCalledWith(kv, 'player-session-token');
	});

	it('clears stale cookies for invalid sessions', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/session', { headers: { Cookie: 'perseus_player_session=stale-token' } }),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(await res.json()).toEqual({ authenticated: false });
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('revokes sessions on logout and clears the cookie', async () => {
		const res = await auth.fetch(
			request('/logout', {
				method: 'POST',
				headers: { Cookie: 'perseus_player_session=player-session-token' }
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(await res.json()).toEqual({ success: true });
		expect(playerAuth.revokePlayerSession).toHaveBeenCalledWith(kv, 'player-session-token');
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('clears the cookie on logout without a session token', async () => {
		const res = await auth.fetch(request('/logout', { method: 'POST' }), env);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(await res.json()).toEqual({ success: true });
		expect(playerAuth.revokePlayerSession).not.toHaveBeenCalled();
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});
});
