const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_JWKS_MAX_CACHE_SECONDS = 24 * 60 * 60;

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PLAYER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * Default allowed origins used in development when ALLOWED_ORIGINS is unset.
 * Shared across CORS middleware and parseReturnTo to keep them consistent.
 */
export const DEFAULT_DEV_ORIGINS = [
	'http://localhost:5173',
	'http://localhost:4173',
	'http://localhost:4692'
];

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

interface GoogleJwksResponse {
	keys?: GoogleJwk[];
}

interface GoogleJwk extends JsonWebKey {
	kid?: string;
}

interface JwksCache {
	keys: GoogleJwk[];
	expiresAt: number;
}

let jwksCache: JwksCache | null = null;

export function normalizeEmail(email: string): string {
	const normalized = email.trim().toLowerCase();
	if (!EMAIL_PATTERN.test(normalized)) {
		throw new Error('Invalid email');
	}
	return normalized;
}

function allowedReturnOriginSet(allowedOrigins: string | undefined): Set<string> {
	const origins = new Set<string>();
	for (const origin of (allowedOrigins || '').split(',')) {
		const trimmed = origin.trim();
		if (!trimmed) continue;
		try {
			origins.add(new URL(trimmed).origin);
		} catch {
			// Invalid configured origins are ignored and will fail return URL matching.
		}
	}
	return origins;
}

/**
 * Resolves the effective allowed origins string for parseReturnTo.
 * Falls back to DEFAULT_DEV_ORIGINS in development when ALLOWED_ORIGINS is unset.
 */
export function resolveAllowedOrigins(
	allowedOrigins: string | undefined,
	nodeEnv?: string
): string | undefined {
	const trimmed = (allowedOrigins || '')
		.split(',')
		.filter((o) => o.trim().length > 0)
		.join(',');
	if (trimmed.length > 0) return trimmed;
	if (nodeEnv === 'development') return DEFAULT_DEV_ORIGINS.join(',');
	return undefined;
}

export function parseReturnTo(value: string | null | undefined, allowedOrigins?: string): string {
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

	try {
		const parsed = new URL(value);
		const allowedOriginsSet = allowedReturnOriginSet(allowedOrigins);
		if (
			(parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
			parsed.username === '' &&
			parsed.password === '' &&
			allowedOriginsSet.has(parsed.origin)
		) {
			return parsed.toString();
		}
	} catch {
		// Fall through to the safe root fallback below.
	}

	return '/';
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

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function decodeJwtJson(value: string): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
	} catch {
		throw new Error('Google ID token is malformed');
	}
}

function readMaxAge(cacheControl: string | null): number {
	if (!cacheControl) return 0;
	const match = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(cacheControl);
	return match ? Math.min(Number.parseInt(match[1], 10), GOOGLE_JWKS_MAX_CACHE_SECONDS) : 0;
}

function isGoogleSigningJwk(jwk: GoogleJwk): boolean {
	return (
		jwk.kty === 'RSA' &&
		(jwk.use === undefined || jwk.use === 'sig') &&
		(jwk.alg === undefined || jwk.alg === 'RS256')
	);
}

async function fetchGoogleJwks(): Promise<GoogleJwk[]> {
	const response = await fetch(GOOGLE_JWKS_URL);
	if (!response.ok) {
		throw new Error(`Google JWKS fetch failed with ${response.status}`);
	}

	const payload = (await response.json()) as GoogleJwksResponse;
	const keys = Array.isArray(payload.keys) ? payload.keys : [];
	const maxAgeSeconds = readMaxAge(response.headers.get('Cache-Control'));
	jwksCache = {
		keys,
		expiresAt: Date.now() + maxAgeSeconds * 1000
	};
	return keys;
}

async function getGoogleJwks(forceRefresh = false): Promise<GoogleJwk[]> {
	if (!forceRefresh && jwksCache && jwksCache.expiresAt > Date.now()) {
		return jwksCache.keys;
	}
	return await fetchGoogleJwks();
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
	const parts = idToken.split('.');
	if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
		throw new Error('Google ID token is malformed');
	}

	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const header = decodeJwtJson(encodedHeader);
	if (typeof header !== 'object' || header === null) {
		throw new Error('Google ID token is malformed');
	}
	const alg = (header as { alg?: unknown }).alg;
	const kid = (header as { kid?: unknown }).kid;
	if (alg !== 'RS256') {
		throw new Error('Google ID token uses unsupported algorithm');
	}
	if (typeof kid !== 'string' || kid.length === 0) {
		throw new Error('Google ID token missing key id');
	}
	const payload = decodeJwtJson(encodedPayload);
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('Google ID token is malformed');
	}

	let keys = await getGoogleJwks();
	let jwk = keys.find((key) => key.kid === kid && isGoogleSigningJwk(key));
	if (!jwk) {
		keys = await getGoogleJwks(true);
		jwk = keys.find((key) => key.kid === kid && isGoogleSigningJwk(key));
	}
	if (!jwk) {
		throw new Error('Google ID token signing key not found');
	}

	const publicKey = await crypto.subtle.importKey(
		'jwk',
		jwk,
		{
			name: 'RSASSA-PKCS1-v1_5',
			hash: 'SHA-256'
		},
		false,
		['verify']
	);
	const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
	const signature = base64UrlToBytes(encodedSignature);
	const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signingInput);
	if (!valid) {
		throw new Error('Google ID token signature is invalid');
	}

	return validateGoogleClaims(payload as GoogleClaimsPayload, clientId);
}
