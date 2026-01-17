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
	// Cloudflare provides the client IP in CF-Connecting-IP header
	return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
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
	key: string
): Promise<RateLimitEntry | null> {
	if (kv) {
		const data = await kv.get(getKVKey(key), 'json');
		return data as RateLimitEntry | null;
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
		// Set with TTL slightly longer than lockout duration to auto-cleanup
		const ttl = Math.ceil(LOCKOUT_DURATION_MS / 1000) + 60;
		await kv.put(getKVKey(key), JSON.stringify(entry), { expirationTtl: ttl });
	} else {
		rateLimitStore.set(key, entry);
	}
}

// Delete rate limit entry from KV or memory
async function deleteRateLimitEntry(kv: KVNamespace | undefined, key: string): Promise<void> {
	if (kv) {
		await kv.delete(getKVKey(key));
	} else {
		rateLimitStore.delete(key);
	}
}

export async function loginRateLimit(
	c: Context<{ Bindings: Env }>,
	next: Next
): Promise<Response | void> {
	const key = getRateLimitKey(c);
	const now = Date.now();
	const kv = c.env.PUZZLE_METADATA;

	let entry = await getRateLimitEntry(kv, key);

	// Check if locked out
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

	// Reset if lockout expired
	if (entry?.lockedUntil && entry.lockedUntil <= now) {
		entry = { attempts: 0, lockedUntil: null };
		await setRateLimitEntry(kv, key, entry);
	}

	// Initialize if no entry
	if (!entry) {
		entry = { attempts: 0, lockedUntil: null };
	}

	// Increment attempts
	entry.attempts++;

	// Check if should lock out
	if (entry.attempts > MAX_LOGIN_ATTEMPTS) {
		entry.lockedUntil = now + LOCKOUT_DURATION_MS;
		await setRateLimitEntry(kv, key, entry);
		return c.json(
			{
				error: 'too_many_requests',
				message: 'Too many login attempts. Please try again later'
			},
			429
		);
	}

	// Save updated attempts
	await setRateLimitEntry(kv, key, entry);

	await next();
}

export async function resetLoginAttempts(c: Context<{ Bindings: Env }>): Promise<void> {
	const key = getRateLimitKey(c);
	const kv = c.env.PUZZLE_METADATA;
	await deleteRateLimitEntry(kv, key);
}
