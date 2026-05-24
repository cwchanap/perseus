import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	exchangeGoogleCode,
	hashToken,
	normalizeEmail,
	parseReturnTo,
	validateGoogleClaims,
	verifyGoogleIdToken
} from './player-auth.shared';

const validGoogleClaims = {
	iss: 'https://accounts.google.com',
	aud: 'client-id',
	exp: Math.floor(Date.now() / 1000) + 60,
	sub: 'google-sub-123',
	email: 'Player@Example.COM',
	email_verified: true
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('player auth shared helpers', () => {
	it('normalizes emails by trimming and lowercasing', () => {
		expect(normalizeEmail('  Player@Example.COM  ')).toBe('player@example.com');
	});

	it.each(['missing-at', '@example.com', 'player@', 'player@example'])(
		'rejects invalid email %s',
		(email) => {
			expect(() => normalizeEmail(email)).toThrow('Invalid email');
		}
	);

	it('accepts only same-origin return paths', () => {
		expect(parseReturnTo('/puzzle/abc')).toBe('/puzzle/abc');
		expect(parseReturnTo(null)).toBe('/');
		expect(parseReturnTo('https://evil.example')).toBe('/');
		expect(parseReturnTo('//evil.example')).toBe('/');
		expect(parseReturnTo('/\\evil.example/path')).toBe('/');
		expect(parseReturnTo('admin')).toBe('/');
	});

	it('falls back when return path parsing fails', () => {
		vi.stubGlobal(
			'URL',
			class {
				constructor() {
					throw new Error('Invalid URL');
				}
			}
		);

		expect(parseReturnTo('/puzzle/abc')).toBe('/');
	});

	it('creates PKCE verifier and challenge strings', async () => {
		const pair = await createPkcePair();
		expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
		expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(pair.challenge).not.toBe(pair.verifier);
	});

	it('hashes tokens without returning the raw token', async () => {
		const hash = await hashToken('raw-session-token');
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(hash).not.toContain('raw-session-token');
	});

	it('builds a Google authorization URL with required params', async () => {
		const state = createOAuthState();
		const pkce = await createPkcePair();
		const url = buildGoogleAuthUrl({
			clientId: 'client-id',
			redirectUri: 'https://app.example.com/api/auth/google/callback',
			state,
			codeChallenge: pkce.challenge
		});

		expect(url.origin).toBe('https://accounts.google.com');
		expect(url.pathname).toBe('/o/oauth2/v2/auth');
		expect(url.searchParams.get('client_id')).toBe('client-id');
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://app.example.com/api/auth/google/callback'
		);
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('scope')).toBe('openid email profile');
		expect(url.searchParams.get('state')).toBe(state);
		expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	});

	it('exchanges Google authorization codes for token responses', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ id_token: 'google-id-token', access_token: 'access-token' }), {
				status: 200
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const tokenResponse = await exchangeGoogleCode({
			code: 'auth-code',
			clientId: 'client-id',
			clientSecret: 'client-secret',
			redirectUri: 'https://app.example.com/api/auth/google/callback',
			codeVerifier: 'pkce-verifier'
		});

		expect(tokenResponse).toEqual({
			id_token: 'google-id-token',
			access_token: 'access-token'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://oauth2.googleapis.com/token',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
			})
		);
		const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
		expect(body.get('code')).toBe('auth-code');
		expect(body.get('client_id')).toBe('client-id');
		expect(body.get('client_secret')).toBe('client-secret');
		expect(body.get('redirect_uri')).toBe('https://app.example.com/api/auth/google/callback');
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code_verifier')).toBe('pkce-verifier');
	});

	it('rejects failed or malformed Google token exchanges', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 400 })));

		await expect(
			exchangeGoogleCode({
				code: 'auth-code',
				clientId: 'client-id',
				clientSecret: 'client-secret',
				redirectUri: 'https://app.example.com/api/auth/google/callback',
				codeVerifier: 'pkce-verifier'
			})
		).rejects.toThrow('Google token exchange failed with 400');

		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access-token' })))
		);

		await expect(
			exchangeGoogleCode({
				code: 'auth-code',
				clientId: 'client-id',
				clientSecret: 'client-secret',
				redirectUri: 'https://app.example.com/api/auth/google/callback',
				codeVerifier: 'pkce-verifier'
			})
		).rejects.toThrow('Google token response missing id_token');
	});

	it('validates Google claims for the configured audience', () => {
		vi.setSystemTime(1_716_500_000_000);
		const claims = validateGoogleClaims(
			{
				...validGoogleClaims,
				exp: Math.floor(Date.now() / 1000) + 60,
				name: 'Player One',
				picture: 'https://example.com/avatar.png'
			},
			'client-id'
		);

		expect(claims).toEqual({
			sub: 'google-sub-123',
			email: 'player@example.com',
			name: 'Player One',
			picture: 'https://example.com/avatar.png'
		});
	});

	it('validates Google claims without optional profile fields', () => {
		const claims = validateGoogleClaims(
			{
				...validGoogleClaims,
				iss: 'accounts.google.com'
			},
			'client-id'
		);

		expect(claims).toEqual({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
	});

	it('verifies Google ID tokens through tokeninfo', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					...validGoogleClaims,
					exp: Math.floor(Date.now() / 1000) + 60
				})
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		const claims = await verifyGoogleIdToken('id token with spaces', 'client-id');

		expect(claims).toEqual({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://oauth2.googleapis.com/tokeninfo?id_token=id%20token%20with%20spaces'
		);
	});

	it('rejects failed Google ID token verification responses', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

		await expect(verifyGoogleIdToken('bad-token', 'client-id')).rejects.toThrow(
			'Google ID token verification failed with 401'
		);
	});

	it.each([
		['issuer', { iss: 'https://evil.example' }, 'Invalid Google token issuer'],
		['audience', { aud: 'other-client-id' }, 'Invalid Google token audience'],
		['expiry', { exp: Math.floor(Date.now() / 1000) - 60 }, 'Google token expired'],
		['subject', { sub: '' }, 'Google token missing subject'],
		['email', { email: '' }, 'Google token missing email']
	])('rejects Google claims with invalid %s', (_field, override, message) => {
		expect(() =>
			validateGoogleClaims(
				{
					...validGoogleClaims,
					...override
				},
				'client-id'
			)
		).toThrow(message);
	});

	it('rejects unverified Google emails', () => {
		expect(() =>
			validateGoogleClaims(
				{
					...validGoogleClaims,
					email_verified: false
				},
				'client-id'
			)
		).toThrow('Google email is not verified');
	});
});
