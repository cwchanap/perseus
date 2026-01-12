// Worker-compatible rate limiting middleware
// Uses in-memory map (per-isolate) for simplicity
// For production with multiple instances, consider using KV or Durable Objects

import type { Context, Next } from 'hono';
import type { Env } from '../worker';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

interface RateLimitEntry {
	attempts: number;
	lockedUntil: number | null;
}

// In-memory rate limit store (per-isolate)
// Note: This resets when the isolate is recycled
const rateLimitStore = new Map<string, RateLimitEntry>();

function getClientIP(c: Context): string {
	// Cloudflare provides the client IP in CF-Connecting-IP header
	return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
}

function getRateLimitKey(c: Context): string {
	return `login:${getClientIP(c)}`;
}

export async function loginRateLimit(
	c: Context<{ Bindings: Env }>,
	next: Next
): Promise<Response | void> {
	const key = getRateLimitKey(c);
	const now = Date.now();

	let entry = rateLimitStore.get(key);

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
		rateLimitStore.set(key, entry);
	}

	// Initialize if no entry
	if (!entry) {
		entry = { attempts: 0, lockedUntil: null };
		rateLimitStore.set(key, entry);
	}

	// Increment attempts
	entry.attempts++;

	// Check if should lock out
	if (entry.attempts >= MAX_LOGIN_ATTEMPTS) {
		entry.lockedUntil = now + LOCKOUT_DURATION_MS;
		rateLimitStore.set(key, entry);
		return c.json(
			{
				error: 'too_many_requests',
				message: 'Too many login attempts. Please try again later'
			},
			429
		);
	}

	await next();
}

export function resetLoginAttempts(c: Context): void {
	const key = getRateLimitKey(c);
	rateLimitStore.delete(key);
}
