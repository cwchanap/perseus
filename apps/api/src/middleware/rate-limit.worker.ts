// Worker-compatible rate limiting middleware
// Uses KV for production (shared across isolates) with in-memory fallback for development

import type { Context, Next } from 'hono';
import type { Env } from '../worker';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_KEY_PREFIX = 'ratelimit:';

interface RateLimitEntry {
	attempts: number;
	lockedUntil: number | null;
}

// In-memory rate limit store (fallback for development/testing)
const rateLimitStore = new Map<string, RateLimitEntry>();

function getClientIP(c: Context): string {
	// Cloudflare provides the client IP in CF-Connecting-IP header (preferred)
	const cfIP = c.req.header('cf-connecting-ip');
	if (cfIP) {
		return cfIP;
	}

	// Fall back to x-forwarded-for, but parse the leftmost (original client) IP
	const xff = c.req.header('x-forwarded-for');
	if (xff) {
		// x-forwarded-for format: "client, proxy1, proxy2, ..."
		const clientIP = xff.split(',')[0].trim();
		if (clientIP) {
			return clientIP;
		}
	}

	// Fall back to a generated UUID per request to avoid shared bucket
	// WARNING: This effectively disables rate limiting for clients without identifiable IPs,
	// as each request creates a new bucket. This is intentional to avoid DoS via shared bucket,
	// but means rate limiting is IP-dependent and degrades to per-request when IP unavailable.
	// Note: c.req.ip is not available in all Hono/Worker environments
	console.warn(
		'Rate limiting: No client IP available, using per-request UUID (rate limiting ineffective)'
	);
	return crypto.randomUUID();
}

function getRateLimitKey(c: Context): string {
	return `login:${getClientIP(c)}`;
}

function getKVKey(key: string): string {
	return `${RATE_LIMIT_KEY_PREFIX}${key}`;
}

// Get rate limit entry from KV or memory
async function getRateLimitEntry(
	kv: KVNamespace | undefined,
	key: string,
	env?: string
): Promise<RateLimitEntry | null> {
	if (kv) {
		const data = await kv.get(getKVKey(key), 'json');
		return data as RateLimitEntry | null;
	}
	// Log warning about in-memory fallback
	// PRODUCTION IMPACT: In-memory storage is not distributed across workers,
	// so rate limiting will only work within a single worker instance.
	// Multiple worker instances can each have their own rate limit counters.
	if (env === 'production') {
		console.error(
			'[CRITICAL] Rate limiting using in-memory storage in production - KV namespace not configured. Rate limiting is per-worker, not distributed.'
		);
	} else {
		console.warn(
			'Rate limiting using in-memory storage (not distributed) - KV namespace not configured'
		);
	}
	return rateLimitStore.get(key) || null;
}

// Set rate limit entry in KV or memory
async function setRateLimitEntry(
	kv: KVNamespace | undefined,
	key: string,
	entry: RateLimitEntry
): Promise<void> {
	if (kv) {
		try {
			// Set with TTL slightly longer than lockout duration to auto-cleanup
			const ttl = Math.ceil(LOCKOUT_DURATION_MS / 1000) + 60;
			await kv.put(getKVKey(key), JSON.stringify(entry), { expirationTtl: ttl });
		} catch (error) {
			console.error('KV write failed, falling back to in-memory:', error);
			rateLimitStore.set(key, entry);
		}
	} else {
		rateLimitStore.set(key, entry);
	}
}

// Delete rate limit entry from KV or memory
async function deleteRateLimitEntry(kv: KVNamespace | undefined, key: string): Promise<void> {
	if (kv) {
		try {
			await kv.delete(getKVKey(key));
		} catch (error) {
			console.error('KV delete failed, continuing:', error);
		}
	} else {
		rateLimitStore.delete(key);
	}
}

// Atomic increment attempt with backoff to mitigate race conditions
async function incrementAttempts(
	kv: KVNamespace | undefined,
	key: string,
	now: number,
	env?: string
): Promise<{ shouldBlock: boolean; remainingSeconds?: number }> {
	const maxRetries = 3;
	const baseDelay = 50; // ms

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const entry = await getRateLimitEntry(kv, key, env);

		// Check if locked out
		if (entry?.lockedUntil && entry.lockedUntil > now) {
			const remainingSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
			return { shouldBlock: true, remainingSeconds };
		}

		// Reset if lockout expired
		let newEntry: RateLimitEntry;
		if (entry?.lockedUntil && entry.lockedUntil <= now) {
			newEntry = { attempts: 1, lockedUntil: null };
		} else if (!entry) {
			newEntry = { attempts: 1, lockedUntil: null };
		} else {
			newEntry = { ...entry, attempts: entry.attempts + 1 };
		}

		// Check if should lock out
		if (newEntry.attempts > MAX_LOGIN_ATTEMPTS) {
			newEntry.lockedUntil = now + LOCKOUT_DURATION_MS;
		}

		// Write back
		await setRateLimitEntry(kv, key, newEntry);

		// Verify our write took effect (detect race condition)
		const current = await getRateLimitEntry(kv, key, env);
		if (current?.attempts === newEntry.attempts) {
			// Our write succeeded
			if (current.lockedUntil && current.lockedUntil > now) {
				const remainingSeconds = Math.ceil((current.lockedUntil - now) / 1000);
				return { shouldBlock: true, remainingSeconds };
			}
			return { shouldBlock: false };
		}

		// Race condition detected, retry with exponential backoff
		if (attempt < maxRetries - 1) {
			const delay = baseDelay * Math.pow(2, attempt);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	// If all retries failed, be conservative and block
	return { shouldBlock: true, remainingSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000) };
}

export async function loginRateLimit(c: Context<{ Bindings: Env }>, next: Next): Promise<Response> {
	const key = getRateLimitKey(c);
	const now = Date.now();
	const kv = c.env.PUZZLE_METADATA;
	const env = c.env.NODE_ENV;

	// First check if already locked out
	const entry = await getRateLimitEntry(kv, key, env);
	if (entry?.lockedUntil && entry.lockedUntil > now) {
		const remainingSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
		return c.json(
			{
				error: 'too_many_requests',
				message: `Too many login attempts. Try again in ${remainingSeconds} seconds`
			},
			429
		);
	}

	// Let request proceed
	await next();

	// Only increment on failed authentication (401/403 responses)
	if (c.res.status === 401 || c.res.status === 403) {
		const result = await incrementAttempts(kv, key, now, env);
		if (result.shouldBlock) {
			// Create a new 429 response with rate limit info
			return c.json(
				{
					error: 'too_many_requests',
					message:
						result.remainingSeconds !== undefined
							? `Too many login attempts. Try again in ${result.remainingSeconds} seconds`
							: 'Too many login attempts. Please try again later'
				},
				429
			);
		}
	} else if (c.res.status === 200) {
		// Successful login, reset attempts
		await deleteRateLimitEntry(kv, key);
	}

	return c.res as Response;
}

export async function resetLoginAttempts(c: Context<{ Bindings: Env }>): Promise<void> {
	const key = getRateLimitKey(c);
	const kv = c.env.PUZZLE_METADATA;
	await deleteRateLimitEntry(kv, key);
}
