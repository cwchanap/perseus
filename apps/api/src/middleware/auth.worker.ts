// Worker-compatible authentication middleware using WebCrypto

import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../worker';

const SESSION_COOKIE_NAME = 'perseus_session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_JWT_SECRET_LENGTH = 32;
const SESSION_STORE_PREFIX = 'session:';
// In-memory fallback for local development ONLY. Not safe for production use —
// state is not shared across Worker isolates and is lost on restart.
const sessionFallbackStore = new Map<string, number>();
const SESSION_WARN_INTERVAL_MS = 5 * 60 * 1000; // Re-log warnings every 5 minutes
let lastSessionStoreFallbackWarn = 0;

function cleanupExpiredSessions(): void {
	const now = Date.now();
	for (const [key, expMs] of sessionFallbackStore) {
		if (expMs <= now) {
			sessionFallbackStore.delete(key);
		}
	}
}

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

function bytesToBase64URL(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64URLToBytes(b64url: string): Uint8Array {
	const padded =
		b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function assertJwtSecret(env: Env): string {
	const secret = env.JWT_SECRET;
	if (!secret || secret.length < MIN_JWT_SECRET_LENGTH) {
		throw new Error('JWT_SECRET missing or too short');
	}
	// Warn if secret contains leading/trailing whitespace (may indicate accidental whitespace in secrets manager)
	if (secret !== secret.trim()) {
		console.warn('JWT_SECRET contains leading or trailing whitespace - ensure this is intentional');
	}
	return secret;
}

async function getSessionStoreKey(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hexDigest = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${SESSION_STORE_PREFIX}${hexDigest}`;
}

async function persistSession(env: Env, token: string, expMs: number): Promise<void> {
	const key = await getSessionStoreKey(token);
	const ttlSeconds = Math.max(60, Math.ceil((expMs - Date.now()) / 1000));
	if (env.PUZZLE_METADATA) {
		try {
			await env.PUZZLE_METADATA.put(key, '1', { expirationTtl: ttlSeconds });
			return;
		} catch (error) {
			console.error('Failed to persist session, falling back to in-memory store:', error);
		}
	}
	// In-memory fallback is only allowed in development; fail fast in production.
	if (env.NODE_ENV !== 'development') {
		throw new Error(
			'KV namespace PUZZLE_METADATA is not configured. Session storage requires KV in production.'
		);
	}
	const warnNow = Date.now();
	if (warnNow - lastSessionStoreFallbackWarn >= SESSION_WARN_INTERVAL_MS) {
		lastSessionStoreFallbackWarn = warnNow;
		console.warn(
			'[DEV ONLY] Session storage using in-memory fallback — not distributed, not persisted across restarts'
		);
	}
	cleanupExpiredSessions();
	sessionFallbackStore.set(key, expMs);
}

async function isSessionActive(env: Env, token: string): Promise<boolean> {
	const key = await getSessionStoreKey(token);
	if (env.PUZZLE_METADATA) {
		let lastError: Error | undefined;
		const maxRetries = 3;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const stored = await env.PUZZLE_METADATA.get(key);
				// KV is authoritative — if it returns null, session is not active
				return stored !== null;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				console.error(
					`Failed to read session store (attempt ${attempt + 1}/${maxRetries}):`,
					lastError
				);
				if (attempt < maxRetries - 1) {
					const delay = 100 * Math.pow(2, attempt);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}
		// All retries failed - in production, surface the error; in development, fall through
		if (env.NODE_ENV !== 'development' && lastError) {
			throw lastError;
		}
		// In development, fall through to in-memory fallback
		console.warn('KV read failed after retries, falling back to in-memory store');
	}
	// In-memory fallback is only available in development
	if (env.NODE_ENV !== 'development') {
		return false;
	}
	cleanupExpiredSessions();
	const expMs = sessionFallbackStore.get(key);
	if (expMs === undefined) return false;
	if (expMs > Date.now()) return true;
	sessionFallbackStore.delete(key);
	return false;
}

export async function revokeSession(env: Env, token: string): Promise<void> {
	const key = await getSessionStoreKey(token);
	if (env.PUZZLE_METADATA) {
		try {
			await env.PUZZLE_METADATA.delete(key);
		} catch (error) {
			console.error('Failed to delete session from store:', error);
			// In production, re-throw so callers know the session wasn't revoked
			if (env.NODE_ENV !== 'development') {
				throw error;
			}
		}
	}
	// Always clean up fallback store regardless of environment (idempotent)
	cleanupExpiredSessions();
	sessionFallbackStore.delete(key);
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
	const payloadB64 = bytesToBase64URL(payloadBytes);

	const secret = assertJwtSecret(env);
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
	const signatureB64 = bytesToBase64URL(new Uint8Array(signature));

	const token = `${payloadB64}.${signatureB64}`;
	await persistSession(env, token, payload.exp);
	return token;
}

// Verify session token
export async function verifySession(env: Env, token: string): Promise<SessionPayload | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 2) return null;
		const [payloadB64, signatureB64] = parts;
		if (!payloadB64 || !signatureB64) return null;

		const secret = assertJwtSecret(env);
		const encoder = new TextEncoder();

		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);

		const signatureBytes = base64URLToBytes(signatureB64);
		const isValid = await crypto.subtle.verify(
			'HMAC',
			key,
			signatureBytes.buffer as ArrayBuffer,
			encoder.encode(payloadB64)
		);

		if (!isValid) return null;

		// Parse and validate payload
		const payloadBytes = base64URLToBytes(payloadB64);
		const payloadJson = new TextDecoder().decode(payloadBytes);
		const parsed = JSON.parse(payloadJson);

		// Validate payload structure
		if (!isValidSessionPayload(parsed)) return null;

		// Check expiration
		if (parsed.exp < Date.now()) return null;
		const payload = parsed;

		const active = await isSessionActive(env, token);
		if (!active) return null;

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
		maxAge: SESSION_DURATION_MS / 1000 // maxAge is in seconds
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
