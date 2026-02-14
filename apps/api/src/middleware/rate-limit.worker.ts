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
let lastUntrustedXFFWarn = 0;

// Reset function for testing - clears all in-memory rate limit entries
export function __resetRateLimitStore(): void {
	rateLimitStore.clear();
	lastInMemoryFallbackWarn = 0;
	lastMissingIPWarn = 0;
	lastUntrustedXFFWarn = 0;
}

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

	// Check for trusted proxy configuration before accepting x-forwarded-for
	const trustXFF = c.env.TRUSTED_PROXY === 'true';
	const xff = c.req.header('x-forwarded-for');
	if (xff && trustXFF) {
		// x-forwarded-for format: "client, proxy1, proxy2, ..."
		const clientIP = xff.split(',')[0].trim();
		if (clientIP) {
			return clientIP;
		}
	}

	// Log warning when x-forwarded-for is present but not trusted
	if (xff && !trustXFF) {
		const now = Date.now();
		if (now - lastUntrustedXFFWarn >= WARN_INTERVAL_MS) {
			lastUntrustedXFFWarn = now;
			console.warn(
				'Rate limiting: Ignoring untrusted x-forwarded-for header (set TRUSTED_PROXY=true to enable). Rate limiting requires Cloudflare or a trusted proxy that sets CF-Connecting-IP.'
			);
		}
	}

	// Fall back to a generated UUID per request to avoid shared bucket
	// WARNING: This effectively disables rate limiting for clients without identifiable IPs,
	// as each request creates a new bucket. This is intentional to avoid DoS via shared bucket,
	// but means rate limiting is IP-dependent and degrades to per-request when IP unavailable.
	// Note: c.req.ip is not available in all Hono/Worker environments
	//
	// For effective rate limiting, ensure one of the following:
	// 1. Running on Cloudflare Workers (CF-Connecting-IP header set automatically)
	// 2. Using a trusted proxy that sets CF-Connecting-IP header
	// 3. Setting TRUSTED_PROXY=true to accept x-forwarded-for from a trusted source
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

// Merge two rate limit entries, choosing the most restrictive/most recent state
function mergeRateLimitEntries(kvEntry: RateLimitEntry, memEntry: RateLimitEntry): RateLimitEntry {
	const now = Date.now();

	// Determine which entry is more restrictive:
	// 1. If one is locked and the other isn't, prefer the locked one
	const kvLocked = kvEntry.lockedUntil !== null && kvEntry.lockedUntil > now;
	const memLocked = memEntry.lockedUntil !== null && memEntry.lockedUntil > now;

	if (kvLocked && !memLocked) return kvEntry;
	if (!kvLocked && memLocked) return memEntry;

	// Both locked or both unlocked - prefer the one with later lockout time
	if (kvLocked && memLocked) {
		return kvEntry.lockedUntil! >= memEntry.lockedUntil! ? kvEntry : memEntry;
	}

	// Both unlocked - prefer the one with more attempts or more recent activity
	if (kvEntry.attempts !== memEntry.attempts) {
		return kvEntry.attempts > memEntry.attempts ? kvEntry : memEntry;
	}

	// Same attempts - prefer the one with more recent activity
	return kvEntry.lastAttemptAt >= memEntry.lastAttemptAt ? kvEntry : memEntry;
}

// Get rate limit entry from KV or memory
async function getRateLimitEntry(
	kv: KVNamespace | undefined,
	key: string,
	env?: string
): Promise<RateLimitEntry | null> {
	let kvEntry: RateLimitEntry | null = null;

	if (kv) {
		try {
			const data = await kv.get(getKVKey(key), 'json');
			if (data !== null && isRateLimitEntry(data)) {
				kvEntry = data;
			} else if (data !== null) {
				console.warn('Invalid rate limit entry, resetting:', { key: getKVKey(key), data });
			}
		} catch (error) {
			if (env === 'production') {
				console.error(`[CRITICAL] KV read failed for ${getKVKey(key)}:`, error);
			} else {
				console.warn(`KV read failed for ${getKVKey(key)}:`, error);
			}
			// Continue to check in-memory store even on KV error
		}
	}

	// Always check in-memory store for potentially newer data
	cleanupExpiredEntries();
	const memEntry = rateLimitStore.get(key) || null;

	// If we have both entries, merge them (most restrictive wins)
	if (kvEntry && memEntry) {
		return mergeRateLimitEntries(kvEntry, memEntry);
	}

	// If we only have one, return it
	if (kvEntry) return kvEntry;

	// Log warning about in-memory fallback only when KV is not configured
	if (!kv && memEntry) {
		return memEntry;
	}

	if (!kv) {
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
	}

	return memEntry;
}

// Set rate limit entry in KV or memory (write-through caching)
async function setRateLimitEntry(
	kv: KVNamespace | undefined,
	key: string,
	entry: RateLimitEntry,
	env?: string
): Promise<void> {
	if (kv) {
		try {
			// Set with TTL slightly longer than lockout duration to auto-cleanup
			const ttl = Math.ceil(LOCKOUT_DURATION_MS / 1000) + 60;
			await kv.put(getKVKey(key), JSON.stringify(entry), { expirationTtl: ttl });
			// Write-through: also update in-memory cache for read consistency
			rateLimitStore.set(key, entry);
		} catch (error) {
			if (env === 'production') {
				console.error(
					'[CRITICAL] KV write failed in production, falling back to in-memory:',
					error
				);
			} else {
				console.error('KV write failed, falling back to in-memory:', error);
			}
			rateLimitStore.set(key, entry);
		}
	} else {
		rateLimitStore.set(key, entry);
	}
}

// Delete rate limit entry from KV and memory
async function deleteRateLimitEntry(
	kv: KVNamespace | undefined,
	key: string,
	env?: string
): Promise<void> {
	if (kv) {
		try {
			await kv.delete(getKVKey(key));
		} catch (error) {
			if (env === 'production') {
				console.error('[CRITICAL] KV delete failed in production:', error);
			} else {
				console.error('KV delete failed, continuing:', error);
			}
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
	await setRateLimitEntry(kv, key, newEntry, env);

	if (newEntry.lockedUntil && newEntry.lockedUntil > now) {
		const remainingSeconds = Math.ceil((newEntry.lockedUntil - now) / 1000);
		return { shouldBlock: true, remainingSeconds };
	}

	return { shouldBlock: false };
}

export async function loginRateLimit(c: Context<{ Bindings: Env }>, next: Next): Promise<Response> {
	const key = getRateLimitKey(c);
	const kv = c.env.PUZZLE_METADATA;
	const env = c.env.NODE_ENV;

	// Check current lockout status before auth handler runs.
	const result = await checkAndIncrement(kv, key, Date.now(), env, false);
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

	// Let request proceed
	await next();

	// Post-auth rate limit tracking — wrapped in try-catch so KV failures
	// don't mask the original auth response
	try {
		if (c.res.status === 200) {
			await deleteRateLimitEntry(kv, key, env);
		} else if (c.res.status === 401 || c.res.status === 403) {
			// Only count failed authentication attempts.
			await checkAndIncrement(kv, key, Date.now(), env, true);
		}
	} catch (error) {
		console.error('Rate limit post-auth tracking failed:', error);
	}

	return c.res;
}

export async function resetLoginAttempts(c: Context<{ Bindings: Env }>): Promise<void> {
	const key = getRateLimitKey(c);
	const kv = c.env.PUZZLE_METADATA;
	const env = c.env.NODE_ENV;
	await deleteRateLimitEntry(kv, key, env);
}
