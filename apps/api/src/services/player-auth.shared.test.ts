import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	bytesToBase64Url,
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

interface TestGoogleJwk extends JsonWebKey {
	kid?: string;
	alg?: string;
	use?: string;
}

function base64UrlJson(value: unknown): string {
	return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function createSignedGoogleIdToken(params: {
	kid: string;
	payload?: Record<string, unknown>;
}): Promise<{
	token: string;
	publicJwk: TestGoogleJwk;
}> {
	const keyPair = (await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as TestGoogleJwk;
	publicJwk.kid = params.kid;
	publicJwk.alg = 'RS256';
	publicJwk.use = 'sig';

	const header = base64UrlJson({ alg: 'RS256', kid: params.kid, typ: 'JWT' });
	const payload = base64UrlJson({
		...validGoogleClaims,
		exp: Math.floor(Date.now() / 1000) + 60,
		...params.payload
	});
	const signingInput = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		keyPair.privateKey,
		new TextEncoder().encode(signingInput)
	);

	return {
		token: `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`,
		publicJwk
	};
}

function createUncheckedGoogleIdToken(header: Record<string, unknown>): string {
	return [
		base64UrlJson(header),
		base64UrlJson({
			...validGoogleClaims,
			exp: Math.floor(Date.now() / 1000) + 60
		}),
		'not-a-real-signature'
	].join('.');
}

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

	it('verifies Google ID tokens locally against Google JWKS', async () => {
		const { token, publicJwk } = await createSignedGoogleIdToken({ kid: 'test-key-1' });
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ keys: [publicJwk] }), {
				headers: { 'Cache-Control': 'public, max-age=600' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const claims = await verifyGoogleIdToken(token, 'client-id');

		expect(claims).toEqual({
			sub: 'google-sub-123',
			email: 'player@example.com'
		});
		expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v3/certs');
	});

	it('rejects Google ID tokens with invalid signatures', async () => {
		const valid = await createSignedGoogleIdToken({ kid: 'test-key-invalid-signature' });
		const other = await createSignedGoogleIdToken({ kid: 'other-key' });
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ keys: [valid.publicJwk] }), {
				headers: { 'Cache-Control': 'public, max-age=600' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const [header, payload] = valid.token.split('.');
		const [, , otherSignature] = other.token.split('.');

		await expect(
			verifyGoogleIdToken(`${header}.${payload}.${otherSignature}`, 'client-id')
		).rejects.toThrow('Google ID token signature is invalid');
	});

	it('rejects Google ID tokens with malformed token structure before fetching JWKS', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(verifyGoogleIdToken('not-a-jwt', 'client-id')).rejects.toThrow(
			'Google ID token is malformed'
		);
		await expect(verifyGoogleIdToken('one.two.three.four', 'client-id')).rejects.toThrow(
			'Google ID token is malformed'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects Google ID tokens with malformed header JSON before fetching JWKS', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			verifyGoogleIdToken(
				['not-json', base64UrlJson(validGoogleClaims), 'not-a-real-signature'].join('.'),
				'client-id'
			)
		).rejects.toThrow('Google ID token is malformed');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects Google ID tokens with malformed payload JSON before fetching JWKS', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			verifyGoogleIdToken(
				[base64UrlJson({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }), 'not-json', 'sig'].join('.'),
				'client-id'
			)
		).rejects.toThrow('Google ID token is malformed');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects Google ID tokens with unsupported algorithms before fetching JWKS', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			verifyGoogleIdToken(
				createUncheckedGoogleIdToken({ alg: 'HS256', kid: 'test-key', typ: 'JWT' }),
				'client-id'
			)
		).rejects.toThrow('Google ID token uses unsupported algorithm');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects Google ID tokens missing a string kid before fetching JWKS', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			verifyGoogleIdToken(createUncheckedGoogleIdToken({ alg: 'RS256', typ: 'JWT' }), 'client-id')
		).rejects.toThrow('Google ID token missing key id');
		await expect(
			verifyGoogleIdToken(
				createUncheckedGoogleIdToken({ alg: 'RS256', kid: 123, typ: 'JWT' }),
				'client-id'
			)
		).rejects.toThrow('Google ID token missing key id');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('caches Google JWKS before max-age expires', async () => {
		const { token, publicJwk } = await createSignedGoogleIdToken({ kid: 'test-key-cache' });
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ keys: [publicJwk] }), {
				headers: { 'Cache-Control': 'public, max-age=600' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await verifyGoogleIdToken(token, 'client-id');
		await verifyGoogleIdToken(token, 'client-id');

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('caps Google JWKS cache max-age to 24 hours', async () => {
		const now = Date.now();
		vi.setSystemTime(now);
		const { token, publicJwk } = await createSignedGoogleIdToken({
			kid: 'test-key-cache-cap',
			payload: { exp: Math.floor((now + 3 * 24 * 60 * 60 * 1000) / 1000) }
		});
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ keys: [publicJwk] }), {
					headers: { 'Cache-Control': 'public, max-age=999999' }
				})
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await verifyGoogleIdToken(token, 'client-id');
		vi.setSystemTime(now + 24 * 60 * 60 * 1000 + 1);
		await verifyGoogleIdToken(token, 'client-id');

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('ignores matching Google JWK kids that are not RSA signing keys', async () => {
		const { token, publicJwk } = await createSignedGoogleIdToken({
			kid: 'test-key-wrong-jwk-type'
		});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					keys: [
						{ ...publicJwk, use: 'enc' },
						{ ...publicJwk, alg: 'RS512' },
						{ ...publicJwk, kty: 'EC' }
					]
				}),
				{ headers: { 'Cache-Control': 'public, max-age=600' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(verifyGoogleIdToken(token, 'client-id')).rejects.toThrow(
			'Google ID token signing key not found'
		);
	});

	it('rejects Google ID tokens when JWKS fetch fails or key is missing', async () => {
		const { token } = await createSignedGoogleIdToken({ kid: 'test-key-fetch-fails' });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

		await expect(verifyGoogleIdToken(token, 'client-id')).rejects.toThrow(
			'Google JWKS fetch failed with 503'
		);

		const missingKeyToken = await createSignedGoogleIdToken({ kid: 'test-key-missing' });
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ keys: [] }), {
					headers: { 'Cache-Control': 'public, max-age=600' }
				})
			)
		);

		await expect(verifyGoogleIdToken(missingKeyToken.token, 'client-id')).rejects.toThrow(
			'Google ID token signing key not found'
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
