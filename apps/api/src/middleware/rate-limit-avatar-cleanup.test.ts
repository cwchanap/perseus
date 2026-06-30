/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for rate-limit.ts (Bun runtime) avatar/oauth cleanup and
 * avatar block-expiry paths.
 *
 * Covers:
 * - cleanupOldEntries avatarAttempts loop (lines 160-164)
 * - cleanupOldEntries oauthAttempts loop (lines 155-159)
 * - avatarRateLimit block-clear branch (lines 192-196)
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { Hono } from 'hono';

// Install fake timers BEFORE rate-limit.ts is imported so the module-level
// setInterval(cleanupOldEntries, 30 * 60 * 1000) registers with fake timers.
vi.useFakeTimers();

const { avatarRateLimit, oauthRateLimit } = await import('./rate-limit');

expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

afterAll(() => {
	vi.useRealTimers();
});

// Each test uses a unique id to avoid cross-test state in the module-level Maps.
let counter = 0;
function uniqueId(): string {
	return `cleanup-test-${process.pid}-${counter++}`;
}

function makeSession(playerId: string): any {
	return { user: { id: playerId, googleName: null, hasDisplayNameOverride: false } };
}

// Avatar app: sets playerSession then mounts avatarRateLimit.
function makeAvatarApp(handlerStatus: number = 200) {
	const app = new Hono<{ Variables: { playerSession: any } }>();
	app.use('/avatar', async (c, next) => {
		c.set('playerSession', makeSession(c.req.header('x-player-id') || 'unknown'));
		await next();
	});
	app.use('/avatar', avatarRateLimit);
	app.post('/avatar', (c) => c.json({ status: handlerStatus }, handlerStatus as any));
	return app;
}

function avatarReq(playerId: string): Request {
	return new Request('http://localhost/avatar', {
		method: 'POST',
		headers: { 'x-player-id': playerId }
	});
}

// OAuth app: mounts oauthRateLimit (no session needed, keyed by IP).
function makeOauthApp() {
	const app = new Hono();
	app.use('/oauth', oauthRateLimit);
	app.post('/oauth', (c) => c.json({ ok: true }));
	return app;
}

function oauthReq(ip: string): Request {
	return new Request('http://localhost/oauth', {
		method: 'POST',
		headers: { 'x-forwarded-for': ip, 'user-agent': 'test-agent' }
	});
}

describe('cleanupOldEntries – avatarAttempts loop', () => {
	it('deletes avatar entries older than 1 hour when the cleanup interval fires', async () => {
		const playerId = uniqueId();
		const app = makeAvatarApp(200);

		// Build up attempts (below the block threshold of 20+1)
		for (let i = 0; i < 5; i++) {
			await app.fetch(avatarReq(playerId));
		}

		// Advance past the 1-hour max-age threshold; the 30-min cleanup interval
		// fires at 90min and removes the stale avatar entry (91min old > 60min).
		vi.advanceTimersByTime(91 * 60 * 1000);

		// After cleanup the entry is gone — a fresh request counts as attempt #1
		const res = await app.fetch(avatarReq(playerId));
		expect(res.status).toBe(200);
	});

	it('deletes avatar entries with an expired block when the cleanup interval fires', async () => {
		const playerId = uniqueId();
		const app = makeAvatarApp(200);

		// Trigger a block (21 requests → 21st exceeds AVATAR_MAX_ATTEMPTS)
		for (let i = 0; i < 21; i++) {
			await app.fetch(avatarReq(playerId));
		}

		const deleteSpy = vi.spyOn(Map.prototype, 'delete');

		// Advance 91 min — entry is >1 hour old AND the 15-min block has expired
		vi.advanceTimersByTime(91 * 60 * 1000);

		expect(deleteSpy).toHaveBeenCalled();
		deleteSpy.mockRestore();

		// Entry removed by cleanup — fresh request is allowed
		const res = await app.fetch(avatarReq(playerId));
		expect(res.status).toBe(200);
	});
});

describe('cleanupOldEntries – oauthAttempts loop', () => {
	it('deletes oauth entries older than 1 hour when the cleanup interval fires', async () => {
		const ip = uniqueId();
		const app = makeOauthApp();

		// Build up a few oauth attempts
		for (let i = 0; i < 3; i++) {
			await app.fetch(oauthReq(ip));
		}

		// Advance past the 1-hour max-age threshold; the 30-min cleanup interval
		// fires at 90min and removes the stale oauth entry (91min old > 60min).
		vi.advanceTimersByTime(91 * 60 * 1000);

		// After cleanup the entry is gone — a fresh request proceeds
		const res = await app.fetch(oauthReq(ip));
		expect(res.status).toBe(200);
	});
});

describe('avatarRateLimit – block-clear branch (expired block)', () => {
	it('clears an expired avatar block and allows the next request', async () => {
		const playerId = uniqueId();
		const app = makeAvatarApp(200);

		// Trigger a block (21 requests)
		for (let i = 0; i < 21; i++) {
			await app.fetch(avatarReq(playerId));
		}

		// Verify blocked
		const blockedRes = await app.fetch(avatarReq(playerId));
		expect(blockedRes.status).toBe(429);

		// Advance past the 15-minute block period
		vi.advanceTimersByTime(15 * 60 * 1000 + 1);

		// Now allowed — the block-expiry branch clears the entry on next request
		const allowedRes = await app.fetch(avatarReq(playerId));
		expect(allowedRes.status).toBe(200);
	});
});
