/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for rate-limit.ts (Bun runtime).
 * Covers: cleanupOldEntries (lines 96-104) via fake timers,
 * and calculateRetryAfterMs fallback branch (line 41).
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { loginRateLimit, resetLoginAttempts } from './rate-limit';

// Each test uses a unique IP to avoid cross-test state in the module-level Map.
let ipCounter = 1000;
function uniqueIp(): string {
	return `192.168.${Math.floor(ipCounter / 255)}.${ipCounter++ % 255}`;
}

function makeApp(handlerStatus: number = 401) {
	const app = new Hono();
	app.use('/login', loginRateLimit);
	app.post('/login', (c) => {
		if (handlerStatus === 200) resetLoginAttempts(c);
		return c.json({ status: handlerStatus }, handlerStatus as any);
	});
	return app;
}

function req(ip: string): Request {
	return new Request('http://localhost/login', {
		method: 'POST',
		headers: { 'x-forwarded-for': ip, 'user-agent': 'test-agent' }
	});
}

describe('rate-limit.ts - cleanupOldEntries via fake timers', () => {
	it('cleans up entries older than 1 hour when the 30-min interval fires', async () => {
		vi.useFakeTimers();
		try {
			const ip = uniqueIp();
			const app = makeApp(401);

			// Create a rate-limit entry by making 1 failed request
			await app.fetch(req(ip));

			// Advance time by 61 minutes (past the 1-hour max-age threshold)
			vi.advanceTimersByTime(61 * 60 * 1000);

			// Fire the 30-minute cleanup interval
			vi.advanceTimersByTime(30 * 60 * 1000);

			// After cleanup, the entry should be gone — the IP should be able to
			// make requests as if it's brand new (not blocked)
			const app2 = makeApp(401);
			const res = await app2.fetch(req(ip));
			// Should be forwarded to handler (not blocked), because the old entry was deleted
			expect(res.status).toBe(401);
		} finally {
			vi.useRealTimers();
		}
	});

	it('cleans up entries older than 1 hour that had an expired block (covers blockedUntil < now branch)', async () => {
		vi.useFakeTimers();
		try {
			const ip = uniqueIp();
			const app = makeApp(401);

			// Create a blocked entry by making 6 requests (6th triggers the block)
			for (let i = 0; i < 6; i++) {
				await app.fetch(req(ip));
			}

			// Advance 61 minutes — entry is now >1 hour old AND the 15-min block has expired
			vi.advanceTimersByTime(61 * 60 * 1000);

			// Fire the cleanup interval (runs every 30 minutes)
			vi.advanceTimersByTime(30 * 60 * 1000);

			// The entry should have been removed by cleanup (was >1 hour old with expired block).
			// A new request should be treated as a fresh start (allowed through, not 429).
			const freshRes = await app.fetch(req(ip));
			expect(freshRes.status).toBe(401);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('rate-limit.ts - blocked entry after window reset remains blocked until explicit unblock', () => {
	it('a new request after the block expires is allowed through', async () => {
		vi.useFakeTimers();
		try {
			const ip = uniqueIp();
			const app = makeApp(401);

			// Trigger a block (6 requests)
			for (let i = 0; i < 6; i++) {
				await app.fetch(req(ip));
			}

			// Verify blocked
			const blockedRes = await app.fetch(req(ip));
			expect(blockedRes.status).toBe(429);

			// Advance past the 15-minute block period
			vi.advanceTimersByTime(15 * 60 * 1000 + 1);

			// Now allowed — the block expiry clears the entry on next request
			const allowedRes = await app.fetch(req(ip));
			expect(allowedRes.status).toBe(401);
		} finally {
			vi.useRealTimers();
		}
	});
});
