import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_CONTEXT_KEY = 'loginRateLimitKey';

type AttemptRecord = {
	attempts: number;
	windowStart: number;
	blockedUntil?: number;
};

const loginAttempts = new Map<string, AttemptRecord>();

function getClientKey(c: Context): string {
	const forwardedFor = c.req.header('x-forwarded-for');
	const realIp = c.req.header('x-real-ip');
	const rawForwarded = c.req.raw.headers.get('x-forwarded-for');
	const ip =
		(forwardedFor && forwardedFor.split(',')[0].trim()) ||
		(realIp && realIp.trim()) ||
		(rawForwarded && rawForwarded.split(',')[0].trim()) ||
		'unknown';
	const userAgent = c.req.header('user-agent') || 'unknown';
	return `${ip}|${userAgent}`;
}

function applyWindow(entry: AttemptRecord, now: number): void {
	if (now - entry.windowStart > ATTEMPT_WINDOW_MS) {
		entry.attempts = 0;
		entry.windowStart = now;
		entry.blockedUntil = undefined;
	}
}

function calculateRetryAfterMs(entry: AttemptRecord, now: number): number {
	if (entry.blockedUntil && entry.blockedUntil > now) {
		return entry.blockedUntil - now;
	}
	return BLOCK_DURATION_MS;
}

export const loginRateLimit = createMiddleware(async (c, next) => {
	const key = getClientKey(c);
	const now = Date.now();

	let entry = loginAttempts.get(key);
	if (!entry) {
		entry = { attempts: 0, windowStart: now };
		loginAttempts.set(key, entry);
	}

	// Clear expired block
	if (entry.blockedUntil && entry.blockedUntil <= now) {
		entry.attempts = 0;
		entry.blockedUntil = undefined;
		entry.windowStart = now;
	}

	applyWindow(entry, now);

	if (entry.blockedUntil && entry.blockedUntil > now) {
		const retryAfterSec = Math.ceil((entry.blockedUntil - now) / 1000);
		c.header('Retry-After', retryAfterSec.toString());
		return c.json(
			{ error: 'too_many_requests', message: 'Too many login attempts. Try again later.' },
			429
		);
	}

	entry.attempts += 1;

	if (entry.attempts > MAX_ATTEMPTS) {
		entry.blockedUntil = now + BLOCK_DURATION_MS;
		const retryAfterSec = Math.ceil(calculateRetryAfterMs(entry, now) / 1000);
		c.header('Retry-After', retryAfterSec.toString());
		return c.json(
			{ error: 'too_many_requests', message: 'Too many login attempts. Try again later.' },
			429
		);
	}

	c.set(RATE_LIMIT_CONTEXT_KEY, key);

	await next();
});

export function resetLoginAttempts(c: Context): void {
	const key = c.get(RATE_LIMIT_CONTEXT_KEY) as string | undefined;
	if (!key) return;
	loginAttempts.delete(key);
}
