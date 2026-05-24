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
