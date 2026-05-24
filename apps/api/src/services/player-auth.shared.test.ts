import { describe, expect, it, vi } from 'vitest';
import {
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	hashToken,
	normalizeEmail,
	parseReturnTo,
	validateGoogleClaims
} from './player-auth.shared';

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
		expect(parseReturnTo('admin')).toBe('/');
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

	it('validates Google claims for the configured audience', () => {
		vi.setSystemTime(1_716_500_000_000);
		const claims = validateGoogleClaims(
			{
				iss: 'https://accounts.google.com',
				aud: 'client-id',
				exp: Math.floor(Date.now() / 1000) + 60,
				sub: 'google-sub-123',
				email: 'Player@Example.COM',
				email_verified: true,
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

	it('rejects unverified Google emails', () => {
		expect(() =>
			validateGoogleClaims(
				{
					iss: 'https://accounts.google.com',
					aud: 'client-id',
					exp: Math.floor(Date.now() / 1000) + 60,
					sub: 'google-sub-123',
					email: 'player@example.com',
					email_verified: false
				},
				'client-id'
			)
		).toThrow('Google email is not verified');
	});
});
