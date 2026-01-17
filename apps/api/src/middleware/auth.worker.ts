// Worker-compatible authentication middleware using WebCrypto

import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../worker';

const SESSION_COOKIE_NAME = 'perseus_session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionPayload {
	userId: string;
	username: string;
	role: string;
	exp: number;
	iat: number;
}

// Runtime validation for session payload
function isValidSessionPayload(obj: unknown): obj is SessionPayload {
	if (typeof obj !== 'object' || obj === null) return false;
	const payload = obj as Record<string, unknown>;
	return (
		typeof payload.userId === 'string' &&
		typeof payload.username === 'string' &&
		typeof payload.role === 'string' &&
		typeof payload.exp === 'number' &&
		typeof payload.iat === 'number'
	);
}

// Create a JWT-like session token using WebCrypto
export async function createSession(
	env: Env,
	user: { userId: string; username: string; role: string }
): Promise<string> {
	const now = Date.now();
	const payload: SessionPayload = {
		...user,
		iat: now,
		exp: now + SESSION_DURATION_MS
	};

	const encoder = new TextEncoder();
	const payloadJson = JSON.stringify(payload);
	const payloadB64 = btoa(payloadJson);

	// Create HMAC signature
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(env.JWT_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
	const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

	return `${payloadB64}.${signatureB64}`;
}

// Verify session token
export async function verifySession(env: Env, token: string): Promise<SessionPayload | null> {
	try {
		const [payloadB64, signatureB64] = token.split('.');
		if (!payloadB64 || !signatureB64) return null;

		const encoder = new TextEncoder();

		// Verify signature
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(env.JWT_SECRET),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);

		const signature = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
		const isValid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payloadB64));

		if (!isValid) return null;

		// Parse and validate payload
		const payloadJson = atob(payloadB64);
		const parsed = JSON.parse(payloadJson);

		// Validate payload structure
		if (!isValidSessionPayload(parsed)) return null;

		// Check expiration
		if (parsed.exp < Date.now()) return null;
		const payload = parsed;

		return payload;
	} catch (error) {
		// Log unexpected errors for debugging (malformed tokens are expected and not logged)
		if (error instanceof SyntaxError) {
			// Invalid JSON in token payload - expected for tampered tokens
			return null;
		}
		console.error('Unexpected error during session verification:', error);
		return null;
	}
}

// Get session token from cookie
export function getSessionToken(c: Context): string | undefined {
	return getCookie(c, SESSION_COOKIE_NAME);
}

// Set session cookie
export function setSessionCookie(c: Context, token: string): void {
	setCookie(c, SESSION_COOKIE_NAME, token, {
		httpOnly: true,
		secure: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: SESSION_DURATION_MS / 1000
	});
}

// Clear session cookie
export function clearSessionCookie(c: Context): void {
	deleteCookie(c, SESSION_COOKIE_NAME, {
		path: '/'
	});
}

// Authentication middleware
export async function requireAuth(
	c: Context<{ Bindings: Env }>,
	next: Next
): Promise<Response | void> {
	const token = getSessionToken(c);

	if (!token) {
		return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
	}

	const session = await verifySession(c.env, token);

	if (!session) {
		clearSessionCookie(c);
		return c.json({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
	}

	await next();
}
