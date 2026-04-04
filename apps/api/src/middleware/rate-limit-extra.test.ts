/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for rate-limit.ts (Bun runtime).
 * Covers: cleanupOldEntries (lines 96-104) via fake timers installed before
 * the module is loaded, and the block-expiry path in applyWindow.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { Hono } from 'hono';

// Install fake timers BEFORE rate-limit.ts is imported so the module-level
// setInterval(cleanupOldEntries, 30 * 60 * 1000) registers with fake timers.
vi.useFakeTimers();

const { loginRateLimit, resetLoginAttempts } = await import('./rate-limit');

// Verify the module-level setInterval was registered with the fake-timer
// infrastructure (not with real timers that we can't control).
expect(vi.getTimerCount()).toBe(1);

afterAll(() => {
	vi.useRealTimers();
});

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
		const ip = uniqueIp();
		const app = makeApp(401);

		// Make 4 failed requests to build up attempts (but not trigger the block at 5+)
		for (let i = 0; i < 4; i++) {
			await app.fetch(req(ip));
		}

		// Spy on Map.prototype.delete before advancing time so we can prove that
		// cleanupOldEntries actually removes the entry from the map — the same
		// status code would result from applyWindow merely resetting attempts in place.
		const deleteSpy = vi.spyOn(Map.prototype, 'delete');

		// Advance past the 1-hour max-age threshold; cleanup fires at 30 and 60-min
		// marks (entries not old enough yet), then again at 91 min (entry deleted).
		vi.advanceTimersByTime(61 * 60 * 1000);
		vi.advanceTimersByTime(30 * 60 * 1000);

		// Verify cleanupOldEntries called delete() during the timer advancement.
		expect(deleteSpy).toHaveBeenCalled();
		deleteSpy.mockRestore();

		// After cleanup the entry is gone — a fresh request counts as attempt #1, not #5
		const res = await app.fetch(req(ip));
		expect(res.status).toBe(401); // not 429; still below the attempt threshold
	});

	it('cleans up entries older than 1 hour that had an expired block (covers blockedUntil < now branch)', async () => {
		const ip = uniqueIp();
		const app = makeApp(401);

		// Trigger a block (6 requests → 6th exceeds MAX_ATTEMPTS)
		for (let i = 0; i < 6; i++) {
			await app.fetch(req(ip));
		}

		// Spy before advancing time to verify cleanupOldEntries deletes the entry,
		// not just the block-clear branch in loginRateLimit.
		const deleteSpy = vi.spyOn(Map.prototype, 'delete');

		// Advance 91 min — entry is >1 hour old AND the 15-min block has long expired
		vi.advanceTimersByTime(91 * 60 * 1000);

		expect(deleteSpy).toHaveBeenCalled();
		deleteSpy.mockRestore();

		// The entry should have been removed by cleanup.
		// A fresh request is treated as attempt #1 (not blocked).
		const freshRes = await app.fetch(req(ip));
		expect(freshRes.status).toBe(401);
	});
});

describe('rate-limit.ts - block expires automatically after BLOCK_DURATION_MS', () => {
	it('request is allowed through once the block duration has elapsed', async () => {
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
	});
});
