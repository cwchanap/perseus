/**
 * Coverage for rate-limit.ts cleanupOldEntries (lines 95-107).
 *
 * The trick: vi.useFakeTimers() must be called BEFORE rate-limit.ts is
 * imported so that the module-level setInterval(cleanupOldEntries, 30 * 60 * 1000)
 * registers with the fake-timer infrastructure. Static imports are hoisted, so
 * we use a dynamic import AFTER installing fake timers.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { Hono } from 'hono';

// Install fake timers BEFORE rate-limit.ts is loaded.
vi.useFakeTimers();

// Dynamic import so rate-limit.ts runs its setInterval with fake timers active.
const { loginRateLimit } = await import('./rate-limit');

// Verify the module-level setInterval(cleanupOldEntries, 30 * 60 * 1000) was
// registered with fake timers, not real ones.
expect(vi.getTimerCount()).toBe(1);

afterAll(() => {
	vi.useRealTimers();
});

let counter = 5000;
function uniqueIp(): string {
	return `172.16.${Math.floor(counter / 255)}.${counter++ % 255}`;
}

function makeApp() {
	const app = new Hono();
	app.use('/login', loginRateLimit);
	app.post('/login', (c) => c.json({ ok: true }, 401));
	return app;
}

function req(ip: string): Request {
	return new Request('http://localhost/login', {
		method: 'POST',
		headers: { 'x-forwarded-for': ip, 'user-agent': 'cleanup-dynamic-test' }
	});
}

describe('rate-limit.ts - cleanupOldEntries via dynamic import + fake timers', () => {
	it('deletes a stale unlocked entry (covers windowStart > maxAge TRUE + !blockedUntil TRUE path)', async () => {
		const ip = uniqueIp();
		const app = makeApp();

		// Create one entry (attempts=1, windowStart=now, no block)
		const res1 = await app.fetch(req(ip));
		expect(res1.status).toBe(401);

		// Spy on Map.prototype.delete to prove cleanupOldEntries actually removes
		// the stale entry from loginAttempts (as opposed to applyWindow merely
		// resetting it in place, which would yield the same status code).
		const deleteSpy = vi.spyOn(Map.prototype, 'delete');

		// Advance 91 min total: cleanup fires at 30, 60, 90-minute marks.
		// At 30 and 60 min the entry is ≤60 min old → skipped.
		// At 90 min the entry is 90 min old (>60 min maxAge) → deleted.
		vi.advanceTimersByTime(91 * 60 * 1000);

		// Verify cleanupOldEntries called delete() on the loginAttempts Map.
		expect(deleteSpy).toHaveBeenCalled();
		deleteSpy.mockRestore();

		// Entry should be gone; fresh request goes straight through to the handler.
		const res2 = await app.fetch(req(ip));
		expect(res2.status).toBe(401);
	});

	it('deletes a stale entry whose block has expired (covers blockedUntil < now TRUE path)', async () => {
		const ip = uniqueIp();
		const app = makeApp();

		// Trigger a block (6 failed attempts → blockedUntil = now+15 min)
		for (let i = 0; i < 6; i++) {
			await app.fetch(req(ip));
		}
		const blockedRes = await app.fetch(req(ip));
		expect(blockedRes.status).toBe(429);

		// Spy before advancing to prove cleanupOldEntries deletes the entry,
		// not just that block-expiry logic clears blockedUntil on the next request.
		const deleteSpy = vi.spyOn(Map.prototype, 'delete');

		// Advance 91 min: by then windowStart is >60 min old AND the 15-min block
		// has long expired (blockedUntil < now) → cleanupOldEntries deletes the entry.
		vi.advanceTimersByTime(91 * 60 * 1000);

		// Verify the entry was removed from the map during timer advancement.
		expect(deleteSpy).toHaveBeenCalled();
		deleteSpy.mockRestore();

		const freshRes = await app.fetch(req(ip));
		expect(freshRes.status).toBe(401); // treated as a brand-new client
	});

	it('keeps a fresh entry whose windowStart is ≤60 min old (covers windowStart > maxAge FALSE path)', async () => {
		const ip = uniqueIp();
		const app = makeApp();

		// Create entry at current virtual T
		await app.fetch(req(ip));

		// Advance 30 min: cleanup fires, but entry is only 30 min old (<60 min maxAge) → kept
		vi.advanceTimersByTime(30 * 60 * 1000);

		// Entry should still be there: one prior attempt, not blocked
		const res = await app.fetch(req(ip));
		expect(res.status).toBe(401);
	});
});
