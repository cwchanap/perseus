// Worker-compatible rate limiting middleware
// Uses KV for production (shared across isolates) with in-memory fallback for development

import type { Context, Next } from 'hono';
import type { Env } from '../worker';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
// Rate limit keys share PUZZLE_METADATA namespace (puzzle keys use 'puzzle:' prefix)
const RATE_LIMIT_KEY_PREFIX = 'ratelimit:';

interface RateLimitEntry {
	attempts: number;
	lockedUntil: number | null;
	lastAttemptAt: number;
}

// In-memory rate limit store (fallback for development/testing)
const rateLimitStore = new Map<string, RateLimitEntry>();
const WARN_INTERVAL_MS = 5 * 60 * 1000; // Re-log warnings every 5 minutes
let lastInMemoryFallbackWarn = 0;
let lastMissingIPWarn = 0;

function cleanupExpiredEntries(): void {
	const now = Date.now();
	for (const [key, entry] of rateLimitStore) {
		if (entry.lockedUntil !== null && entry.lockedUntil <= now) {
			rateLimitStore.delete(key);
		} else if (entry.lockedUntil === null && now - entry.lastAttemptAt >= LOCKOUT_DURATION_MS) {
			// Expire stale entries that never reached lockout
			rateLimitStore.delete(key);
		}
	}
}

function isRateLimitEntry(value: unknown): value is RateLimitEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	const attempts = entry.attempts;
	const lockedUntil = entry.lockedUntil;
	const lastAttemptAt = entry.lastAttemptAt;
	if (typeof attempts !== 'number' || !Number.isFinite(attempts)) return false;
	if (typeof lastAttemptAt !== 'number' || !Number.isFinite(lastAttemptAt)) return false;
	if (lockedUntil !== null && (typeof lockedUntil !== 'number' || !Number.isFinite(lockedUntil))) {
		return false;
	}
	return true;
}

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
	const now = Date.now();
	if (now - lastMissingIPWarn >= WARN_INTERVAL_MS) {
		lastMissingIPWarn = now;
		console.warn(
			'Rate limiting: No client IP available, using per-request UUID (rate limiting ineffective)'
		);
	}
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
		try {
			const data = await kv.get(getKVKey(key), 'json');
			if (data === null) {
				return null;
			}
			if (!isRateLimitEntry(data)) {
				console.warn('Invalid rate limit entry, resetting:', { key: getKVKey(key), data });
				return null;
			}
			return data;
		} catch (error) {
			console.warn(`KV read failed for ${getKVKey(key)}, failing open:`, error);
			return null;
		}
	}
	// Log warning about in-memory fallback
	// PRODUCTION IMPACT: In-memory storage is not distributed across workers,
	// so rate limiting will only work within a single worker instance.
	// Multiple worker instances can each have their own rate limit counters.
	const warnNow = Date.now();
	if (warnNow - lastInMemoryFallbackWarn >= WARN_INTERVAL_MS) {
		lastInMemoryFallbackWarn = warnNow;
		if (env === 'production') {
			console.error(
				'[CRITICAL] Rate limiting using in-memory storage in production - KV namespace not configured. Rate limiting is per-worker, not distributed.'
			);
		} else {
			console.warn(
				'Rate limiting using in-memory storage (not distributed) - KV namespace not configured'
			);
		}
	}
	cleanupExpiredEntries();
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

// Delete rate limit entry from KV and memory
async function deleteRateLimitEntry(kv: KVNamespace | undefined, key: string): Promise<void> {
	if (kv) {
		try {
			await kv.delete(getKVKey(key));
		} catch (error) {
			console.error('KV delete failed, continuing:', error);
		}
	}
	// Always clean in-memory store to avoid stale entries from KV write fallback
	rateLimitStore.delete(key);
}

// Check lockout status and optionally increment attempts in a single read-modify-write.
// Note: KV does not support atomic compare-and-set, so there is an inherent TOCTOU window
// between get and put. For strict atomicity under high concurrency, use a Durable Object
// with an atomic incrementAndGet(key, ...) method. For login rate limiting, the small
// race window is acceptable — worst case an extra attempt slips through before lockout.
async function checkAndIncrement(
	kv: KVNamespace | undefined,
	key: string,
	now: number,
	env?: string,
	increment = false
): Promise<{ shouldBlock: boolean; remainingSeconds?: number }> {
	const entry = await getRateLimitEntry(kv, key, env);

	// Check if currently locked out
	if (entry?.lockedUntil && entry.lockedUntil > now) {
		const remainingSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
		return { shouldBlock: true, remainingSeconds };
	}

	// If not incrementing, just report not blocked
	if (!increment) {
		return { shouldBlock: false };
	}

	// Reset if lockout expired, create new, or increment existing
	let newEntry: RateLimitEntry;
	if (entry?.lockedUntil && entry.lockedUntil <= now) {
		newEntry = { attempts: 1, lockedUntil: null, lastAttemptAt: now };
	} else if (!entry) {
		newEntry = { attempts: 1, lockedUntil: null, lastAttemptAt: now };
	} else {
		newEntry = { ...entry, attempts: entry.attempts + 1, lastAttemptAt: now };
	}

	// Check if should lock out
	if (newEntry.attempts >= MAX_LOGIN_ATTEMPTS) {
		newEntry.lockedUntil = now + LOCKOUT_DURATION_MS;
	}

	// Write back immediately after read to minimize TOCTOU window
	await setRateLimitEntry(kv, key, newEntry);

	if (newEntry.lockedUntil && newEntry.lockedUntil > now) {
		const remainingSeconds = Math.ceil((newEntry.lockedUntil - now) / 1000);
		return { shouldBlock: true, remainingSeconds };
	}

	return { shouldBlock: false };
}

export async function loginRateLimit(c: Context<{ Bindings: Env }>, next: Next): Promise<Response> {
	const key = getRateLimitKey(c);
	const now = Date.now();
	const kv = c.env.PUZZLE_METADATA;
	const env = c.env.NODE_ENV;

	// Single read to check lockout (no separate pre-read + increment to avoid double TOCTOU)
	const preCheck = await checkAndIncrement(kv, key, now, env, false);
	if (preCheck.shouldBlock) {
		return c.json(
			{
				error: 'too_many_requests',
				message: `Too many login attempts. Try again in ${preCheck.remainingSeconds} seconds`
			},
			429
		);
	}

	// Let request proceed
	await next();

	// Only increment on failed authentication (401/403 responses)
	if (c.res.status === 401 || c.res.status === 403) {
		const attemptTime = Date.now();
		const result = await checkAndIncrement(kv, key, attemptTime, env, true);
		if (result.shouldBlock) {
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
