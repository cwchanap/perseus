/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Avatar rate-limit tests for the Bun runtime (rate-limit.ts).
 * Pins the threshold (AVATAR_MAX_ATTEMPTS = 20) and reset-on-success behavior.
 * The middleware is keyed by player id (set via playerSession context) and
 * must be mounted after requirePlayerAuth.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { avatarRateLimit, resetAvatarAttempts } from './rate-limit';
import type { PlayerSessionRecord } from '../services/player-auth';

// Each test uses a unique player id to avoid cross-test state in the
// module-level avatarAttempts Map.
let playerCounter = 0;
function uniquePlayerId(): string {
	return `player-test-${process.pid}-${playerCounter++}`;
}

function makeSession(playerId: string): PlayerSessionRecord {
	return {
		user: { id: playerId, googleName: null, hasDisplayNameOverride: false }
	} as any;
}

// Build a minimal Hono app that sets playerSession (mimicking requirePlayerAuth),
// mounts avatarRateLimit, and optionally calls resetAvatarAttempts on success.
// Mirrors the real route: reset is called on the success path only (after
// validation passes), not by inspecting c.res.status.
function makeApp(opts: { resetOnSuccess?: boolean; handlerStatus?: number } = {}) {
	const { resetOnSuccess = false, handlerStatus = 200 } = opts;
	const app = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();
	app.use('/avatar', async (c, next) => {
		c.set('playerSession', makeSession(c.req.header('x-player-id') || 'unknown'));
		await next();
	});
	app.use('/avatar', avatarRateLimit);
	app.post('/avatar', (c) => {
		if (resetOnSuccess) {
			resetAvatarAttempts(c);
		}
		return c.json({ status: handlerStatus }, handlerStatus as any);
	});
	return app;
}

function req(playerId: string): Request {
	return new Request('http://localhost/avatar', {
		method: 'POST',
		headers: { 'x-player-id': playerId }
	});
}

describe('avatarRateLimit (Bun) – threshold', () => {
	it('allows the first AVATAR_MAX_ATTEMPTS (20) uploads', async () => {
		const playerId = uniquePlayerId();
		const app = makeApp({ handlerStatus: 200 });

		for (let i = 0; i < 20; i++) {
			const res = await app.fetch(req(playerId));
			expect(res.status).toBe(200);
		}
	});

	it('blocks the 21st upload with 429', async () => {
		const playerId = uniquePlayerId();
		const app = makeApp({ handlerStatus: 200 });

		for (let i = 0; i < 20; i++) {
			await app.fetch(req(playerId));
		}

		const res = await app.fetch(req(playerId));
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('too_many_requests');
	});

	it('includes Retry-After header when blocked', async () => {
		const playerId = uniquePlayerId();
		const app = makeApp({ handlerStatus: 200 });

		for (let i = 0; i < 20; i++) {
			await app.fetch(req(playerId));
		}

		const res = await app.fetch(req(playerId));
		expect(res.status).toBe(429);
		const retryAfter = res.headers.get('Retry-After');
		expect(retryAfter).not.toBeNull();
		expect(Number(retryAfter)).toBeGreaterThan(0);
	});
});

describe('avatarRateLimit (Bun) – reset on success', () => {
	it('resets the counter after a successful upload so subsequent uploads are allowed', async () => {
		const playerId = uniquePlayerId();
		const app = makeApp({ resetOnSuccess: true, handlerStatus: 200 });

		// Make 19 successful uploads (each resets the counter)
		for (let i = 0; i < 19; i++) {
			const res = await app.fetch(req(playerId));
			expect(res.status).toBe(200);
		}

		// Counter was reset each time, so the 20th and beyond should still pass
		const res20 = await app.fetch(req(playerId));
		expect(res20.status).toBe(200);
		const res21 = await app.fetch(req(playerId));
		expect(res21.status).toBe(200);
	});

	it('does NOT reset on a failed upload (handler returns non-200 without calling reset)', async () => {
		const playerId = uniquePlayerId();
		// A failed upload (bad file, too large, etc.) returns early before
		// reaching resetAvatarAttempts — mirroring the real route's early-return
		// pattern. Here the handler returns 400 and does NOT call reset.
		const app = makeApp({ resetOnSuccess: false, handlerStatus: 400 });

		// 20 failed uploads exhaust the counter (no reset)
		for (let i = 0; i < 20; i++) {
			const res = await app.fetch(req(playerId));
			expect(res.status).toBe(400);
		}

		// 21st should be blocked — counter was never reset
		const res = await app.fetch(req(playerId));
		expect(res.status).toBe(429);
	});

	it('reset allows another full window of uploads after near-exhaustion', async () => {
		const playerId = uniquePlayerId();

		// 19 uploads (counter at 19, not yet reset because reset happens at 200 response)
		// Actually reset happens on every 200, so counter resets each time.
		// To test near-exhaustion + reset, use a handler that resets only on the 19th.
		let callCount = 0;
		const customApp = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();
		customApp.use('/avatar', async (c, next) => {
			c.set('playerSession', makeSession(playerId));
			await next();
		});
		customApp.use('/avatar', avatarRateLimit);
		customApp.post('/avatar', (c) => {
			callCount++;
			// Reset only on the 19th call, leaving counter at 1 after
			if (callCount === 19) {
				resetAvatarAttempts(c);
			}
			return c.json({ ok: true }, 200);
		});

		// First 20 requests pass (counter increments 1..20, but resets at call 19
		// so after call 19 counter=0, call 20 counter=1)
		for (let i = 0; i < 20; i++) {
			const res = await customApp.fetch(req(playerId));
			expect(res.status).toBe(200);
		}

		// After reset at call 19, counter is at 1 (from call 20).
		// 19 more requests should pass (counter 2..20)
		for (let i = 0; i < 19; i++) {
			const res = await customApp.fetch(req(playerId));
			expect(res.status).toBe(200);
		}

		// Now counter is at 20, 21st request (relative to reset) should block
		const blocked = await customApp.fetch(req(playerId));
		expect(blocked.status).toBe(429);
	});
});

describe('avatarRateLimit (Bun) – keying', () => {
	it('uses player id as the key, not IP', async () => {
		const playerId = uniquePlayerId();
		const app = makeApp({ handlerStatus: 200 });

		// Exhaust attempts for playerId from one IP
		for (let i = 0; i < 20; i++) {
			await app.fetch(
				new Request('http://localhost/avatar', {
					method: 'POST',
					headers: { 'x-player-id': playerId, 'x-forwarded-for': '1.2.3.4' }
				})
			);
		}
		// Blocked from same player+IP
		const blocked = await app.fetch(
			new Request('http://localhost/avatar', {
				method: 'POST',
				headers: { 'x-player-id': playerId, 'x-forwarded-for': '1.2.3.4' }
			})
		);
		expect(blocked.status).toBe(429);

		// Same player from different IP is still blocked (keyed by player id)
		const blockedDiffIp = await app.fetch(
			new Request('http://localhost/avatar', {
				method: 'POST',
				headers: { 'x-player-id': playerId, 'x-forwarded-for': '5.6.7.8' }
			})
		);
		expect(blockedDiffIp.status).toBe(429);

		// Different player from same IP is NOT blocked
		const otherPlayer = uniquePlayerId();
		const otherRes = await app.fetch(
			new Request('http://localhost/avatar', {
				method: 'POST',
				headers: { 'x-player-id': otherPlayer, 'x-forwarded-for': '1.2.3.4' }
			})
		);
		expect(otherRes.status).toBe(200);
	});

	it('fails open when playerSession is not set (misconfigured middleware order)', async () => {
		// No middleware sets playerSession — avatarRateLimit should let the
		// request through rather than 500.
		const app = new Hono();
		app.use('/avatar', avatarRateLimit);
		app.post('/avatar', (c) => c.json({ ok: true }));

		const res = await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
		expect(res.status).toBe(200);
	});
});

describe('resetAvatarAttempts (Bun) – no-op safety', () => {
	it('is a no-op when AVATAR_RATE_LIMIT_CONTEXT_KEY is not set', async () => {
		const app = new Hono();
		app.get('/test', (c) => {
			resetAvatarAttempts(c); // should not throw
			return c.text('ok');
		});
		const res = await app.fetch(new Request('http://localhost/test'));
		expect(res.status).toBe(200);
	});
});
