import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUser } from '@perseus/types';

vi.mock('../../services/player-auth.shared', async () => {
	return {
		OAUTH_STATE_TTL_SECONDS: 10 * 60,
		PLAYER_SESSION_DURATION_MS: 30 * 24 * 60 * 60 * 1000,
		createOAuthState: vi.fn(() => 'oauth-state-token'),
		createPkcePair: vi.fn(() =>
			Promise.resolve({
				verifier: 'pkce-verifier',
				challenge: 'pkce-challenge'
			})
		),
		encryptOAuthState: vi.fn(async (_secret: string, data: unknown) => {
			return `enc:${btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
		}),
		decryptOAuthState: vi.fn(async (_secret: string, encrypted: string) => {
			try {
				if (!encrypted.startsWith('enc:')) return null;
				const raw = encrypted.slice(4).replace(/-/g, '+').replace(/_/g, '/');
				const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
				return JSON.parse(atob(padded));
			} catch {
				return null;
			}
		}),
		resolveAllowedOrigins: vi.fn((allowedOrigins: string | undefined, nodeEnv?: string) => {
			const trimmed = (allowedOrigins || '')
				.split(',')
				.filter((o: string) => o.trim().length > 0)
				.join(',');
			if (trimmed.length > 0) return trimmed;
			if (nodeEnv === 'development')
				return 'http://localhost:5173,http://localhost:4173,http://localhost:4692';
			return undefined;
		}),
		parseReturnTo: vi.fn((value: string | null | undefined, allowedOrigins?: string) => {
			if (!value) return '/';
			if (value.startsWith('/') && !value.startsWith('//')) {
				try {
					const parsed = new URL(value, 'https://perseus.local');
					if (parsed.origin !== 'https://perseus.local') return '/';
					return `${parsed.pathname}${parsed.search}${parsed.hash}`;
				} catch {
					return '/';
				}
			}
			const origins = new Set(
				(allowedOrigins || '')
					.split(',')
					.map((origin) => origin.trim())
					.filter(Boolean)
					.map((origin) => new URL(origin).origin)
			);
			const parsed = new URL(value);
			return origins.has(parsed.origin) && parsed.username === '' && parsed.password === ''
				? parsed.toString()
				: '/';
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
	getAllowlistEntry: vi.fn(),
	upsertPlayer: vi.fn(),
	createPlayerSession: vi.fn(),
	getPlayerSession: vi.fn(),
	revokePlayerSession: vi.fn()
}));

vi.mock('../../middleware/rate-limit.worker', () => ({
	oauthRateLimit: async (_c: unknown, next: () => Promise<void>) => next()
}));

import auth from '../auth.worker';
import * as sharedAuth from '../../services/player-auth.shared';
import * as playerAuth from '../../services/player-auth.worker';

const kv = {} as KVNamespace;
const env = {
	PUZZLE_METADATA: kv,
	JWT_SECRET: 'test-jwt-secret',
	GOOGLE_CLIENT_ID: 'google-client-id',
	GOOGLE_CLIENT_SECRET: 'google-client-secret',
	AUTH_REDIRECT_BASE_URL: 'https://app.example.com',
	ALLOWED_ORIGINS: 'https://app.example.com',
	NODE_ENV: 'development'
};

const productionEnv = {
	...env,
	NODE_ENV: 'production'
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

const defaultStateData = {
	codeVerifier: 'pkce-verifier',
	returnTo: '/puzzle/abc',
	createdAt: 1_716_500_000_000
};

function toEnc(data: unknown): string {
	return `enc:${btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const encryptedStateData = toEnc(defaultStateData);

function request(path: string, init: RequestInit = {}): Request {
	return new Request(`https://app.example.com${path}`, init);
}

function expectProductionCookieAttributes(setCookie: string): void {
	expect(setCookie).toContain('Secure');
	expect(setCookie).toContain('HttpOnly');
	expect(setCookie).toContain('SameSite=Lax');
	expect(setCookie).toContain('Path=/');
}

async function expectServerMisconfigured(path: string, testEnv: typeof env): Promise<void> {
	const res = await auth.fetch(request(path), testEnv);

	expect(res.status).toBe(500);
	expect(res.headers.get('Cache-Control')).toBe('no-store');
	expect(await res.json()).toEqual({
		error: 'server_misconfigured',
		message: 'Server configuration error'
	});
}

describe('Worker player auth routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.setSystemTime(1_716_500_000_000);
		vi.mocked(sharedAuth.exchangeGoogleCode).mockResolvedValue({ id_token: 'google-id-token' });
		vi.mocked(sharedAuth.verifyGoogleIdToken).mockResolvedValue(claims);
		vi.mocked(sharedAuth.encryptOAuthState).mockImplementation(
			async (_s: string, data: unknown) => {
				return `enc:${btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
			}
		);
		vi.mocked(sharedAuth.decryptOAuthState).mockImplementation(async (_s: string, enc: string) => {
			try {
				if (!enc.startsWith('enc:')) return null;
				const raw = enc.slice(4).replace(/-/g, '+').replace(/_/g, '/');
				const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
				return JSON.parse(atob(padded));
			} catch {
				return null;
			}
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

	it('redirects Google starts, encrypts state data, and sets cookies', async () => {
		const res = await auth.fetch(request('/google/start?returnTo=/puzzle/abc?piece=1'), env);
		const location = new URL(res.headers.get('Location') ?? '');
		const setCookieHeader = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(location.origin).toBe('https://accounts.google.com');
		expect(location.pathname).toBe('/o/oauth2/v2/auth');
		expect(location.searchParams.get('client_id')).toBe('google-client-id');
		expect(location.searchParams.get('redirect_uri')).toBe(
			'https://app.example.com/api/auth/google/callback'
		);
		expect(location.searchParams.get('state')).toBe('oauth-state-token');
		expect(location.searchParams.get('code_challenge')).toBe('pkce-challenge');
		expect(sharedAuth.encryptOAuthState).toHaveBeenCalledWith('test-jwt-secret', {
			codeVerifier: 'pkce-verifier',
			returnTo: '/puzzle/abc?piece=1',
			createdAt: 1_716_500_000_000
		});
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookieHeader).toContain('perseus_oauth_state=oauth-state-token');
		expect(setCookieHeader).toContain('Max-Age=600');
		expect(setCookieHeader).toContain('perseus_oauth_data=');
		expect(setCookieHeader).toContain('HttpOnly');
	});

	it('sets production attributes on the OAuth cookies', async () => {
		const res = await auth.fetch(request('/google/start'), productionEnv);
		const setCookieHeader = res.headers.get('set-cookie') ?? '';

		expect(setCookieHeader).toContain('perseus_oauth_state=oauth-state-token');
		expect(setCookieHeader).toContain('perseus_oauth_data=');
		expectProductionCookieAttributes(setCookieHeader);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('returns unauthenticated for /session when OAuth env is missing', async () => {
		const res = await auth.fetch(request('/session'), {
			...productionEnv,
			GOOGLE_CLIENT_ID: '',
			GOOGLE_CLIENT_SECRET: '',
			AUTH_REDIRECT_BASE_URL: ''
		});

		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ authenticated: false });
	});

	it('still returns server_misconfigured for /google/start when OAuth env is missing', async () => {
		await expectServerMisconfigured('/google/start', {
			...productionEnv,
			GOOGLE_CLIENT_ID: '',
			GOOGLE_CLIENT_SECRET: '',
			AUTH_REDIRECT_BASE_URL: ''
		});
	});

	it('returns server_misconfigured for invalid production auth redirect bases', async () => {
		await expectServerMisconfigured('/google/start', {
			...productionEnv,
			ALLOWED_ORIGINS: 'https://app.example.com',
			AUTH_REDIRECT_BASE_URL: 'https://user:pass@app.example.com'
		});
		await expectServerMisconfigured('/google/start', {
			...productionEnv,
			ALLOWED_ORIGINS: 'https://other.example.com',
			AUTH_REDIRECT_BASE_URL: 'https://app.example.com'
		});
	});

	it('sanitizes unsafe start returnTo values to root', async () => {
		await auth.fetch(request('/google/start?returnTo=https://evil.example/puzzle/abc'), env);

		expect(sharedAuth.encryptOAuthState).toHaveBeenCalledWith('test-jwt-secret', {
			codeVerifier: 'pkce-verifier',
			returnTo: '/',
			createdAt: 1_716_500_000_000
		});
	});

	it('stores absolute start returnTo values for allowed origins', async () => {
		const splitOriginEnv = {
			...env,
			ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:4692'
		};
		const returnToEncoded = encodeURIComponent('http://localhost:4692/puzzle/abc?piece=1');

		await auth.fetch(request(`/google/start?returnTo=${returnToEncoded}`), splitOriginEnv);

		expect(sharedAuth.resolveAllowedOrigins).toHaveBeenCalledWith(
			'https://app.example.com, http://localhost:4692',
			'development'
		);
		expect(sharedAuth.parseReturnTo).toHaveBeenCalledWith(
			'http://localhost:4692/puzzle/abc?piece=1',
			'https://app.example.com, http://localhost:4692'
		);
		expect(sharedAuth.encryptOAuthState).toHaveBeenCalledWith('test-jwt-secret', {
			codeVerifier: 'pkce-verifier',
			returnTo: 'http://localhost:4692/puzzle/abc?piece=1',
			createdAt: 1_716_500_000_000
		});
	});

	it('falls back to dev origins for absolute returnTo when ALLOWED_ORIGINS is unset', async () => {
		const devEnv = {
			...env,
			ALLOWED_ORIGINS: undefined as string | undefined
		};

		await auth.fetch(
			request('/google/start?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fgallery'),
			devEnv
		);

		expect(sharedAuth.resolveAllowedOrigins).toHaveBeenCalledWith(undefined, 'development');
		expect(sharedAuth.parseReturnTo).toHaveBeenCalledWith(
			'http://localhost:5173/gallery',
			'http://localhost:5173,http://localhost:4173,http://localhost:4692'
		);
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
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
		expect(setCookie).toContain('perseus_oauth_data=');
		expect(setCookie).toContain('Max-Age=0');
		expect(sharedAuth.decryptOAuthState).not.toHaveBeenCalled();
	});

	it('redirects to login with access_denied and decrypts state for webOrigin', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&error=access_denied', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=access_denied');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
		expect(setCookie).toContain('perseus_oauth_data=');
		expect(setCookie).toContain('Max-Age=0');
		expect(sharedAuth.decryptOAuthState).toHaveBeenCalledWith(
			'test-jwt-secret',
			encryptedStateData
		);
	});

	it('preserves web origin on access_denied when returnTo is absolute', async () => {
		const absStateData = {
			codeVerifier: 'pkce-verifier',
			returnTo: 'http://localhost:5173/puzzle/abc',
			createdAt: 1_716_500_000_000
		};
		const absEncrypted = toEnc(absStateData);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&error=access_denied', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${absEncrypted}`
				}
			}),
			env
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://localhost:5173/login?error=access_denied');
	});

	it('falls back to relative redirect on access_denied when state decryption fails', async () => {
		vi.mocked(sharedAuth.decryptOAuthState).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&error=access_denied', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=bad-data`
				}
			}),
			env
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=access_denied');
	});

	it('redirects to login on access_denied without decrypting state when cookie mismatches', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&error=access_denied', {
				headers: { Cookie: 'perseus_oauth_state=other-state' }
			}),
			env
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=access_denied');
		expect(sharedAuth.decryptOAuthState).not.toHaveBeenCalled();
	});

	it('rejects callback when data cookie is missing', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: { Cookie: 'perseus_oauth_state=oauth-state-token' }
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=session_expired');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('rejects callback when decrypted state is null', async () => {
		vi.mocked(sharedAuth.decryptOAuthState).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=bad-data`
				}
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=session_expired');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('redirects not-allowlisted callback users to login', async () => {
		vi.mocked(playerAuth.getAllowlistEntry).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(playerAuth.getAllowlistEntry).toHaveBeenCalledWith(kv, 'player@example.com');
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=not_allowed');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('redirects not-allowlisted callback to web origin when returnTo is absolute', async () => {
		vi.mocked(playerAuth.getAllowlistEntry).mockResolvedValue(null);
		const absStateData = {
			codeVerifier: 'pkce-verifier',
			returnTo: 'http://localhost:5173/puzzle/abc',
			createdAt: 1_716_500_000_000
		};
		const absEncrypted = toEnc(absStateData);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${absEncrypted}`
				}
			}),
			env
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://localhost:5173/login?error=not_allowed');
	});

	it('creates a player session for allowlisted verified users', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
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
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookie).toContain('perseus_player_session=player-session-token');
		expect(setCookie).toContain('Max-Age=2592000');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
		expect(setCookie).toContain('perseus_oauth_data=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('sets production attributes on the player session cookie after callback success', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			}),
			productionEnv
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(setCookie).toContain('perseus_player_session=player-session-token');
		expectProductionCookieAttributes(setCookie);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('redirects Google callback errors to login', async () => {
		vi.mocked(sharedAuth.exchangeGoogleCode).mockRejectedValue(new Error('token exchange failed'));

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			}),
			env
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=google_error');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(setCookie).toContain('perseus_oauth_state=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('redirects Google callback errors to web origin when returnTo is absolute', async () => {
		vi.mocked(sharedAuth.exchangeGoogleCode).mockRejectedValue(new Error('token exchange failed'));
		const absStateData = {
			codeVerifier: 'pkce-verifier',
			returnTo: 'http://localhost:5173/puzzle/abc',
			createdAt: 1_716_500_000_000
		};
		const absEncrypted = toEnc(absStateData);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${absEncrypted}`
				}
			}),
			env
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://localhost:5173/login?error=google_error');
	});

	it('rejects callback when encrypted state is expired', async () => {
		const expiredData = {
			codeVerifier: 'pkce-verifier',
			returnTo: '/puzzle/abc',
			createdAt: 1_716_500_000_000 - 10 * 60 * 1000 - 1
		};
		const expiredEncrypted = toEnc(expiredData);

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${expiredEncrypted}`
				}
			}),
			env
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=session_expired');
	});

	it('returns unauthenticated when no player session cookie exists', async () => {
		const res = await auth.fetch(request('/session'), env);

		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ authenticated: false });
		expect(playerAuth.getPlayerSession).not.toHaveBeenCalled();
	});

	it('returns authenticated user for a valid session', async () => {
		const res = await auth.fetch(
			request('/session', { headers: { Cookie: 'perseus_player_session=player-session-token' } }),
			env
		);

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ authenticated: true, user: player });
		expect(playerAuth.getPlayerSession).toHaveBeenCalledWith(kv, 'player-session-token');
	});

	it('returns unauthenticated without clearing cookie on KV miss', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/session', { headers: { Cookie: 'perseus_player_session=stale-token' } }),
			env
		);

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ authenticated: false });
		// Cookie should not be cleared — KV eventual consistency may cause transient misses
		expect(res.headers.get('set-cookie')).toBeNull();
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

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ success: true });
		expect(playerAuth.revokePlayerSession).toHaveBeenCalledWith(kv, 'player-session-token');
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('clears the cookie on logout without a session token', async () => {
		const res = await auth.fetch(request('/logout', { method: 'POST' }), env);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ success: true });
		expect(playerAuth.revokePlayerSession).not.toHaveBeenCalled();
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});
});
