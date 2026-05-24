const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PLAYER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface PkcePair {
	verifier: string;
	challenge: string;
}

export interface GoogleIdentityClaims {
	sub: string;
	email: string;
	name?: string;
	picture?: string;
}

export interface GoogleTokenResponse {
	id_token: string;
	access_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
}

export interface StoredOAuthState {
	state: string;
	codeVerifier: string;
	returnTo: string;
	createdAt: number;
}

interface GoogleClaimsPayload {
	iss?: unknown;
	aud?: unknown;
	exp?: unknown;
	sub?: unknown;
	email?: unknown;
	email_verified?: unknown;
	name?: unknown;
	picture?: unknown;
}

export function normalizeEmail(email: string): string {
	const normalized = email.trim().toLowerCase();
	if (!EMAIL_PATTERN.test(normalized)) {
		throw new Error('Invalid email');
	}
	return normalized;
}

export function parseReturnTo(value: string | null | undefined): string {
	if (!value) return '/';
	if (!value.startsWith('/') || value.startsWith('//')) return '/';
	try {
		const parsed = new URL(value, 'https://perseus.local');
		if (parsed.origin !== 'https://perseus.local') return '/';
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return '/';
	}
}

function randomBytes(byteLength: number): Uint8Array {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createOAuthState(): string {
	return bytesToBase64Url(randomBytes(32));
}

export async function createPkcePair(): Promise<PkcePair> {
	const verifier = bytesToBase64Url(randomBytes(32));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return {
		verifier,
		challenge: bytesToBase64Url(new Uint8Array(digest))
	};
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export function buildGoogleAuthUrl(params: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): URL {
	const url = new URL(GOOGLE_AUTH_URL);
	url.searchParams.set('client_id', params.clientId);
	url.searchParams.set('redirect_uri', params.redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', 'openid email profile');
	url.searchParams.set('state', params.state);
	url.searchParams.set('code_challenge', params.codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url;
}

export async function exchangeGoogleCode(params: {
	code: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	codeVerifier: string;
}): Promise<GoogleTokenResponse> {
	const body = new URLSearchParams();
	body.set('code', params.code);
	body.set('client_id', params.clientId);
	body.set('client_secret', params.clientSecret);
	body.set('redirect_uri', params.redirectUri);
	body.set('grant_type', 'authorization_code');
	body.set('code_verifier', params.codeVerifier);

	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!response.ok) {
		throw new Error(`Google token exchange failed with ${response.status}`);
	}

	const tokenResponse = (await response.json()) as Partial<GoogleTokenResponse>;
	if (typeof tokenResponse.id_token !== 'string' || tokenResponse.id_token.length === 0) {
		throw new Error('Google token response missing id_token');
	}
	return tokenResponse as GoogleTokenResponse;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function validateGoogleClaims(
	payload: GoogleClaimsPayload,
	expectedAudience: string
): GoogleIdentityClaims {
	const issuer = readString(payload.iss);
	if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
		throw new Error('Invalid Google token issuer');
	}
	if (payload.aud !== expectedAudience) {
		throw new Error('Invalid Google token audience');
	}
	if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
		throw new Error('Google token expired');
	}
	const sub = readString(payload.sub);
	if (!sub) {
		throw new Error('Google token missing subject');
	}
	const rawEmail = readString(payload.email);
	if (!rawEmail) {
		throw new Error('Google token missing email');
	}
	if (payload.email_verified !== true) {
		throw new Error('Google email is not verified');
	}

	const claims: GoogleIdentityClaims = {
		sub,
		email: normalizeEmail(rawEmail)
	};
	const name = readString(payload.name);
	const picture = readString(payload.picture);
	if (name) claims.name = name;
	if (picture) claims.picture = picture;
	return claims;
}

export async function verifyGoogleIdToken(
	idToken: string,
	clientId: string
): Promise<GoogleIdentityClaims> {
	const response = await fetch(
		`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
	);
	if (!response.ok) {
		throw new Error(`Google ID token verification failed with ${response.status}`);
	}
	return validateGoogleClaims((await response.json()) as GoogleClaimsPayload, clientId);
}
