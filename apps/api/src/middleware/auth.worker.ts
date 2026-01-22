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

// Auth variables for Hono context
export interface AuthVariables {
	session: Omit<SessionPayload, 'exp' | 'iat'>;
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

function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
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

	// Unicode-safe base64 encoding
	const payloadJson = JSON.stringify(payload);
	const payloadBytes = new TextEncoder().encode(payloadJson);
	const payloadB64 = bytesToBase64(payloadBytes);

	// Create HMAC signature
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(env.JWT_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
	const signatureB64 = bytesToBase64(new Uint8Array(signature));

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
		const payloadBytes = Uint8Array.from(atob(payloadB64), (c) => c.charCodeAt(0));
		const payloadJson = new TextDecoder().decode(payloadBytes);
		const parsed = JSON.parse(payloadJson);

		// Validate payload structure
		if (!isValidSessionPayload(parsed)) return null;

		// Check expiration
		if (parsed.exp < Date.now()) return null;
		const payload = parsed;

		return payload;
	} catch (error) {
		// Suppress logging for expected errors (invalid base64 or JSON in tampered tokens)
		const isExpectedError =
			error instanceof SyntaxError ||
			(error instanceof DOMException && error.name === 'InvalidCharacterError');
		if (isExpectedError) {
			return null;
		}
		// Unexpected errors should propagate for proper error handling
		console.error('Unexpected error during session verification:', error);
		throw error;
	}
}

// Get session token from cookie
export function getSessionToken(c: Context): string | undefined {
	return getCookie(c, SESSION_COOKIE_NAME);
}

// Set session cookie
export function setSessionCookie(c: Context<{ Bindings: Env }>, token: string): void {
	const isSecure = c.env.NODE_ENV === 'production';
	setCookie(c, SESSION_COOKIE_NAME, token, {
		httpOnly: true,
		secure: isSecure,
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
	c: Context<{ Bindings: Env; Variables: AuthVariables }>,
	next: Next
): Promise<Response | void> {
	const token = getSessionToken(c);

	if (!token) {
		return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
	}

	try {
		const session = await verifySession(c.env, token);

		if (!session) {
			// Invalid or expired session
			clearSessionCookie(c);
			return c.json({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
		}

		// Store session on context for downstream handlers
		c.set('session', {
			userId: session.userId,
			username: session.username,
			role: session.role
		});

		await next();
	} catch (error) {
		// Unexpected error during verification - return 500
		console.error('Session verification failed unexpectedly:', error);
		return c.json({ error: 'internal_error', message: 'Authentication system error' }, 500);
	}
}
