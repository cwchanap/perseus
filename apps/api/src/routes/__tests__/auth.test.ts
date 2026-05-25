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

vi.mock('../../services/player-auth', () => ({
	getAllowlistEntry: vi.fn(),
	upsertPlayer: vi.fn(),
	createPlayerSession: vi.fn(),
	getPlayerSession: vi.fn(),
	revokePlayerSession: vi.fn()
}));

vi.mock('../../middleware/rate-limit', () => ({
	oauthRateLimit: async (_c: unknown, next: () => Promise<void>) => next()
}));

import auth from '../auth';
import * as sharedAuth from '../../services/player-auth.shared';
import * as playerAuth from '../../services/player-auth';

const baseEnv = {
	GOOGLE_CLIENT_ID: 'google-client-id',
	GOOGLE_CLIENT_SECRET: 'google-client-secret',
	AUTH_REDIRECT_BASE_URL: 'https://app.example.com',
	ALLOWED_ORIGINS: 'https://app.example.com',
	NODE_ENV: 'development',
	JWT_SECRET: 'test-jwt-secret'
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

function setEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): void {
	for (const key of Object.keys(baseEnv)) {
		process.env[key] = baseEnv[key as keyof typeof baseEnv];
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function expectProductionCookieAttributes(setCookie: string): void {
	expect(setCookie).toContain('Secure');
	expect(setCookie).toContain('HttpOnly');
	expect(setCookie).toContain('SameSite=Lax');
	expect(setCookie).toContain('Path=/');
}

async function expectServerMisconfigured(
	path: string,
	overrides: Partial<NodeJS.ProcessEnv>
): Promise<void> {
	setEnv(overrides);

	const res = await auth.fetch(request(path));

	expect(res.status).toBe(500);
	expect(res.headers.get('Cache-Control')).toBe('no-store');
	expect(await res.json()).toEqual({
		error: 'server_misconfigured',
		message: 'Server configuration error'
	});
}

describe('Bun player auth routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.setSystemTime(1_716_500_000_000);
		setEnv();
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
		for (const key of Object.keys(baseEnv)) {
			delete process.env[key];
		}
	});

	it('returns unauthenticated when no player session cookie exists', async () => {
		const res = await auth.fetch(request('/session'));

		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ authenticated: false });
		expect(playerAuth.getPlayerSession).not.toHaveBeenCalled();
	});

	it('returns authenticated user for a valid session', async () => {
		const res = await auth.fetch(
			request('/session', { headers: { Cookie: 'perseus_player_session=player-session-token' } })
		);

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ authenticated: true, user: player });
		expect(playerAuth.getPlayerSession).toHaveBeenCalledWith('player-session-token');
	});

	it('redirects Google starts, encrypts state data, and sets cookies', async () => {
		const res = await auth.fetch(request('/google/start?returnTo=/puzzle/abc?piece=1'));
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
		expect(setCookieHeader).toContain('HttpOnly');
		expect(setCookieHeader).toContain('Max-Age=600');
		expect(setCookieHeader).toContain('perseus_oauth_data=');
	});

	it('sets Secure on OAuth cookies when NODE_ENV is unset', async () => {
		setEnv({ NODE_ENV: undefined });

		const res = await auth.fetch(request('/google/start'));
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(setCookie).toContain('perseus_oauth_state=oauth-state-token');
		expect(setCookie).toContain('Secure');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('sanitizes unsafe start returnTo values to root', async () => {
		await auth.fetch(request('/google/start?returnTo=https://evil.example/puzzle/abc'));

		expect(sharedAuth.encryptOAuthState).toHaveBeenCalledWith('test-jwt-secret', {
			codeVerifier: 'pkce-verifier',
			returnTo: '/',
			createdAt: 1_716_500_000_000
		});
	});

	it('stores absolute start returnTo values for allowed origins', async () => {
		setEnv({ ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:4692' });
		const returnToEncoded = encodeURIComponent('http://localhost:4692/puzzle/abc?piece=1');

		await auth.fetch(request(`/google/start?returnTo=${returnToEncoded}`));

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
		setEnv({ ALLOWED_ORIGINS: undefined as unknown as string });

		await auth.fetch(request('/google/start?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fgallery'));

		expect(sharedAuth.resolveAllowedOrigins).toHaveBeenCalledWith(undefined, 'development');
		expect(sharedAuth.parseReturnTo).toHaveBeenCalledWith(
			'http://localhost:5173/gallery',
			'http://localhost:5173,http://localhost:4173,http://localhost:4692'
		);
	});

	it('returns server_misconfigured when auth env is missing only on auth routes', async () => {
		await expectServerMisconfigured('/session', {
			GOOGLE_CLIENT_ID: '',
			GOOGLE_CLIENT_SECRET: '',
			AUTH_REDIRECT_BASE_URL: ''
		});
	});

	it('returns server_misconfigured for invalid production auth redirect bases', async () => {
		await expectServerMisconfigured('/google/start', {
			NODE_ENV: 'production',
			ALLOWED_ORIGINS: 'https://app.example.com',
			AUTH_REDIRECT_BASE_URL: 'https://user:pass@app.example.com'
		});
		await expectServerMisconfigured('/google/start', {
			NODE_ENV: 'production',
			ALLOWED_ORIGINS: 'https://other.example.com',
			AUTH_REDIRECT_BASE_URL: 'https://app.example.com'
		});
	});

	it('allows local HTTP auth redirect bases outside production', async () => {
		setEnv({ AUTH_REDIRECT_BASE_URL: 'http://127.0.0.1:5173' });

		const res = await auth.fetch(request('/google/start'));
		const location = new URL(res.headers.get('Location') ?? '');

		expect(res.status).toBe(302);
		expect(location.searchParams.get('redirect_uri')).toBe(
			'http://127.0.0.1:5173/api/auth/google/callback'
		);
	});

	it('treats unset NODE_ENV as production for auth redirect base validation', async () => {
		await expectServerMisconfigured('/session', {
			NODE_ENV: undefined,
			AUTH_REDIRECT_BASE_URL: 'http://localhost:5173'
		});
	});

	it('returns server_misconfigured for malformed auth redirect bases', async () => {
		await expectServerMisconfigured('/session', {
			AUTH_REDIRECT_BASE_URL: 'not a valid url'
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
		const res = await auth.fetch(request(path, { headers: { Cookie: cookie } }));
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
			})
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
			})
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
			})
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=access_denied');
	});

	it('redirects to login on access_denied without decrypting state when cookie mismatches', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&error=access_denied', {
				headers: { Cookie: 'perseus_oauth_state=other-state' }
			})
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/login?error=access_denied');
		expect(sharedAuth.decryptOAuthState).not.toHaveBeenCalled();
	});

	it('creates a player session for allowlisted verified users', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			})
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
		expect(playerAuth.upsertPlayer).toHaveBeenCalledWith(claims);
		expect(playerAuth.createPlayerSession).toHaveBeenCalledWith(player);
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

	it('rejects callback when data cookie is missing', async () => {
		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: { Cookie: 'perseus_oauth_state=oauth-state-token' }
			})
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
			})
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
			})
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(playerAuth.getAllowlistEntry).toHaveBeenCalledWith('player@example.com');
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
			})
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://localhost:5173/login?error=not_allowed');
	});

	it('redirects Google callback errors to login', async () => {
		vi.mocked(sharedAuth.exchangeGoogleCode).mockRejectedValue(new Error('token exchange failed'));

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			})
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
			})
		);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://localhost:5173/login?error=google_error');
	});

	it('sets production attributes on player session cookies', async () => {
		setEnv({ NODE_ENV: 'production' });

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			})
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(setCookie).toContain('perseus_player_session=player-session-token');
		expectProductionCookieAttributes(setCookie);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('sets Secure on player session cookies when NODE_ENV is unset', async () => {
		setEnv({ NODE_ENV: undefined });

		const res = await auth.fetch(
			request('/google/callback?state=oauth-state-token&code=auth-code', {
				headers: {
					Cookie: `perseus_oauth_state=oauth-state-token; perseus_oauth_data=${encryptedStateData}`
				}
			})
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.status).toBe(302);
		expect(setCookie).toContain('perseus_player_session=player-session-token');
		expect(setCookie).toContain('Secure');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('clears stale cookies for invalid sessions', async () => {
		vi.mocked(playerAuth.getPlayerSession).mockResolvedValue(null);

		const res = await auth.fetch(
			request('/session', { headers: { Cookie: 'perseus_player_session=stale-token' } })
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ authenticated: false });
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('revokes sessions on logout and clears the cookie', async () => {
		const res = await auth.fetch(
			request('/logout', {
				method: 'POST',
				headers: { Cookie: 'perseus_player_session=player-session-token' }
			})
		);
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ success: true });
		expect(playerAuth.revokePlayerSession).toHaveBeenCalledWith('player-session-token');
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});

	it('clears the cookie on logout without a session token', async () => {
		const res = await auth.fetch(request('/logout', { method: 'POST' }));
		const setCookie = res.headers.get('set-cookie') ?? '';

		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ success: true });
		expect(playerAuth.revokePlayerSession).not.toHaveBeenCalled();
		expect(setCookie).toContain('perseus_player_session=');
		expect(setCookie).toContain('Max-Age=0');
	});
});
