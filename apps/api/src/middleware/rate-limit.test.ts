/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
	loginRateLimit,
	resetLoginAttempts,
	oauthRateLimit,
	avatarRateLimit,
	resetAvatarAttempts
} from './rate-limit';

// Each test uses a unique IP to avoid cross-test state in the module-level Map.
let ipCounter = 1;
function uniqueIp(): string {
	return `10.0.${Math.floor(ipCounter / 255)}.${ipCounter++ % 255}`;
}

// Build a minimal Hono app with loginRateLimit and a handler that optionally
// returns 401 (to simulate a failed login) or 200.
function makeApp(handlerStatus: number = 200) {
	const app = new Hono();
	app.use('/login', loginRateLimit);
	app.post('/login', (c) => {
		if (handlerStatus === 200) {
			resetLoginAttempts(c);
		}
		return c.json({ status: handlerStatus }, handlerStatus as any);
	});
	return app;
}

function req(ip: string): Request {
	return new Request('http://localhost/login', {
		method: 'POST',
		headers: {
			'x-forwarded-for': ip,
			'user-agent': 'test-agent'
		}
	});
}

// ─── Basic allow ──────────────────────────────────────────────────────────────

describe('loginRateLimit – first attempt is always allowed', () => {
	it('passes through on the very first request', async () => {
		const ip = uniqueIp();
		const app = makeApp(200);
		const res = await app.fetch(req(ip));
		expect(res.status).toBe(200);
	});
});

// ─── Accumulating failures ────────────────────────────────────────────────────

describe('loginRateLimit – accumulates failures', () => {
	it('allows up to MAX_ATTEMPTS (5) failed requests', async () => {
		const ip = uniqueIp();
		const app = makeApp(401);

		// Attempts 1-5 should all be forwarded to the handler (not blocked by middleware)
		for (let i = 1; i <= 5; i++) {
			const res = await app.fetch(req(ip));
			// The handler returns 401, but the middleware didn't block it
			expect(res.status).toBe(401);
		}
	});

	it('blocks with 429 after MAX_ATTEMPTS exceeded', async () => {
		const ip = uniqueIp();
		const app = makeApp(401);

		// Exhaust the allowed attempts
		for (let i = 0; i < 5; i++) {
			await app.fetch(req(ip));
		}

		// The 6th request should be blocked by the middleware
		const res = await app.fetch(req(ip));
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('too_many_requests');
	});

	it('includes Retry-After header when blocked', async () => {
		const ip = uniqueIp();
		const app = makeApp(401);

		for (let i = 0; i < 5; i++) {
			await app.fetch(req(ip));
		}

		const res = await app.fetch(req(ip));
		expect(res.status).toBe(429);
		const retryAfter = res.headers.get('Retry-After');
		expect(retryAfter).not.toBeNull();
		expect(Number(retryAfter)).toBeGreaterThan(0);
	});
});

// ─── resetLoginAttempts ───────────────────────────────────────────────────────

describe('resetLoginAttempts', () => {
	it('clears the rate limit so subsequent requests are allowed again', async () => {
		const ip = uniqueIp();
		// Fail 4 times (within limit)
		const failApp = makeApp(401);
		for (let i = 0; i < 4; i++) {
			await failApp.fetch(req(ip));
		}

		// One successful login resets the counter
		const successApp = makeApp(200);
		const successRes = await successApp.fetch(req(ip));
		expect(successRes.status).toBe(200);

		// Now subsequent requests should be allowed again (counter was reset)
		const failApp2 = makeApp(401);
		const res = await failApp2.fetch(req(ip));
		expect(res.status).toBe(401); // allowed through (not 429)
	});

	it('is a no-op when RATE_LIMIT_CONTEXT_KEY is not set', async () => {
		// Call resetLoginAttempts directly on a context that never went through loginRateLimit
		const app = new Hono();
		app.get('/test', (c) => {
			resetLoginAttempts(c); // should not throw
			return c.text('ok');
		});
		const res = await app.fetch(new Request('http://localhost/test'));
		expect(res.status).toBe(200);
	});
});

// ─── Window expiry ────────────────────────────────────────────────────────────

describe('loginRateLimit – window expiry', () => {
	it('resets attempt count after the window expires', async () => {
		vi.useFakeTimers();
		try {
			const ip = uniqueIp();
			const app = makeApp(401);

			// Make 4 failed attempts within the window
			for (let i = 0; i < 4; i++) {
				await app.fetch(req(ip));
			}

			// Advance past the 10-minute attempt window
			vi.advanceTimersByTime(10 * 60 * 1000 + 1);

			// Counter should be reset, so 5 more attempts are allowed
			for (let i = 0; i < 5; i++) {
				const res = await app.fetch(req(ip));
				// Not 429 – middleware forwarded it
				expect(res.status).toBe(401);
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── Block expiry ─────────────────────────────────────────────────────────────

describe('loginRateLimit – block expiry', () => {
	it('allows requests again after the block duration expires', async () => {
		vi.useFakeTimers();
		try {
			const ip = uniqueIp();
			const app = makeApp(401);

			// Trigger a block
			for (let i = 0; i < 6; i++) {
				await app.fetch(req(ip));
			}

			// Still blocked
			const blockedRes = await app.fetch(req(ip));
			expect(blockedRes.status).toBe(429);

			// Advance past the 15-minute block duration
			vi.advanceTimersByTime(15 * 60 * 1000 + 1);

			// Should be allowed again
			const afterRes = await app.fetch(req(ip));
			expect(afterRes.status).toBe(401); // handler received it
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── IP detection ─────────────────────────────────────────────────────────────

describe('loginRateLimit – IP detection', () => {
	it('identifies clients by IP + User-Agent', async () => {
		const ip = uniqueIp();

		const app1 = new Hono();
		app1.use('/login', loginRateLimit);
		app1.post('/login', (c) => c.json({}, 401 as any));

		const app2 = new Hono();
		app2.use('/login', loginRateLimit);
		app2.post('/login', (c) => c.json({}, 401 as any));

		// Exhaust attempts for user-agent-A
		for (let i = 0; i < 5; i++) {
			await app1.fetch(
				new Request('http://localhost/login', {
					method: 'POST',
					headers: { 'x-forwarded-for': ip, 'user-agent': 'agent-A' }
				})
			);
		}

		// user-agent-B should not be blocked even with same IP
		const resB = await app2.fetch(
			new Request('http://localhost/login', {
				method: 'POST',
				headers: { 'x-forwarded-for': ip, 'user-agent': 'agent-B' }
			})
		);
		expect(resB.status).toBe(401); // not blocked
	});

	it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
		const ip = uniqueIp();
		const app = new Hono();
		app.use('/login', loginRateLimit);
		app.post('/login', (c) => c.json({}, 401 as any));

		const makeRealIpReq = () =>
			new Request('http://localhost/login', {
				method: 'POST',
				headers: { 'x-real-ip': ip, 'user-agent': 'test' }
			});

		// Exhaust the 5-attempt window using x-real-ip as the IP source
		for (let i = 0; i < 5; i++) {
			const res = await app.fetch(makeRealIpReq());
			expect(res.status).toBe(401); // allowed through
		}

		// 6th request must be blocked — confirms key derivation used x-real-ip
		const blocked = await app.fetch(makeRealIpReq());
		expect(blocked.status).toBe(429);
	});

	it('uses "unknown" when no IP header is present', async () => {
		const app = new Hono();
		app.use('/login', loginRateLimit);
		app.post('/login', (c) => c.json({}, 401 as any));

		// No IP headers, no user-agent → key = "unknown|unknown"
		const makeAnonymousReq = () => new Request('http://localhost/login', { method: 'POST' });

		// Exhaust the 5-attempt window
		for (let i = 0; i < 5; i++) {
			const res = await app.fetch(makeAnonymousReq());
			expect(res.status).toBe(401); // allowed through
		}

		// 6th request must be blocked — confirms "unknown|unknown" key accumulates state
		const blocked = await app.fetch(makeAnonymousReq());
		expect(blocked.status).toBe(429);
	});
});

// ─── OAuth Rate Limit ──────────────────────────────────────────────────────────

function makeOAuthApp() {
	const app = new Hono();
	app.use('/oauth/start', oauthRateLimit);
	app.get('/oauth/start', (c) => c.json({ ok: true }));
	return app;
}

function oauthReq(ip: string): Request {
	return new Request('http://localhost/oauth/start', {
		headers: {
			'x-forwarded-for': ip,
			'user-agent': 'test-agent'
		}
	});
}

describe('oauthRateLimit', () => {
	it('allows the first request', async () => {
		const ip = uniqueIp();
		const app = makeOAuthApp();
		const res = await app.fetch(oauthReq(ip));
		expect(res.status).toBe(200);
	});

	it('allows up to OAUTH_MAX_ATTEMPTS (10) requests', async () => {
		const ip = uniqueIp();
		const app = makeOAuthApp();

		for (let i = 0; i < 10; i++) {
			const res = await app.fetch(oauthReq(ip));
			expect(res.status).toBe(200);
		}
	});

	it('blocks the 11th request with 429', async () => {
		const ip = uniqueIp();
		const app = makeOAuthApp();

		for (let i = 0; i < 10; i++) {
			await app.fetch(oauthReq(ip));
		}

		const res = await app.fetch(oauthReq(ip));
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('too_many_requests');
	});

	it('includes Retry-After header when blocked', async () => {
		const ip = uniqueIp();
		const app = makeOAuthApp();

		for (let i = 0; i < 10; i++) {
			await app.fetch(oauthReq(ip));
		}

		const res = await app.fetch(oauthReq(ip));
		expect(res.status).toBe(429);
		const retryAfter = res.headers.get('Retry-After');
		expect(retryAfter).not.toBeNull();
		expect(Number(retryAfter)).toBeGreaterThan(0);
	});

	it('uses a separate counter from login rate limiter', async () => {
		const ip = uniqueIp();

		// Exhaust OAuth attempts
		const oauthApp = makeOAuthApp();
		for (let i = 0; i < 10; i++) {
			await oauthApp.fetch(oauthReq(ip));
		}
		const blockedRes = await oauthApp.fetch(oauthReq(ip));
		expect(blockedRes.status).toBe(429);

		// Login rate limiter should NOT be affected — same IP, different counter
		const loginApp = makeApp(401);
		const loginRes = await loginApp.fetch(req(ip));
		expect(loginRes.status).toBe(401); // not blocked
	});

	it('allows requests again after block expires', async () => {
		vi.useFakeTimers();
		try {
			const ip = uniqueIp();
			const app = makeOAuthApp();

			// Trigger a block
			for (let i = 0; i < 11; i++) {
				await app.fetch(oauthReq(ip));
			}

			// Still blocked
			const blockedRes = await app.fetch(oauthReq(ip));
			expect(blockedRes.status).toBe(429);

			// Advance past the 15-minute block duration
			vi.advanceTimersByTime(15 * 60 * 1000 + 1);

			// Should be allowed again
			const afterRes = await app.fetch(oauthReq(ip));
			expect(afterRes.status).toBe(200);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── avatarRateLimit (Bun) ────────────────────────────────────────────────────

function makeAvatarApp(handlerStatus: number = 200, playerId: string = 'player-test-1') {
	const app = new Hono();
	app.use('/avatar', (c, next) => {
		// Simulate requirePlayerAuth setting the session. The default Context
		// type doesn't include 'playerSession' in its Variables map, so cast.
		(c as any).set('playerSession', { user: { id: playerId } });
		return avatarRateLimit(c, next);
	});
	app.post('/avatar', (c) => {
		if (handlerStatus === 200) {
			resetAvatarAttempts(c);
		}
		return c.json({ status: handlerStatus }, handlerStatus as any);
	});
	return app;
}

describe('avatarRateLimit (Bun)', () => {
	it('allows the first upload and resets on success', async () => {
		const app = makeAvatarApp(200, 'player-allow-1');
		const res = await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
		expect(res.status).toBe(200);
	});

	it('blocks after exceeding the max attempt threshold', async () => {
		// AVATAR_MAX_ATTEMPTS is 20; the 21st attempt triggers the block.
		// Use a failing handler so attempts accumulate without reset.
		const app = makeAvatarApp(500, 'player-block-1');
		let lastStatus = 200;
		for (let i = 0; i < 22; i++) {
			const res = await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
			lastStatus = res.status;
		}
		expect(lastStatus).toBe(429);
	});

	it('sets Retry-After header when blocked', async () => {
		const app = makeAvatarApp(500, 'player-retry-1');
		for (let i = 0; i < 22; i++) {
			await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
		}
		const res = await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBeTruthy();
	});

	it('resetAvatarAttempts is a no-op when no key is set', () => {
		const app = new Hono();
		app.post('/test', (c) => {
			resetAvatarAttempts(c); // no avatarRateLimit ran → no key
			return c.json({ ok: true });
		});
		// Should not throw.
		expect(() => app.fetch(new Request('http://localhost/test', { method: 'POST' }))).not.toThrow();
	});

	it('fails open (calls next) when no playerSession is set on the context', async () => {
		// Simulate misconfigured middleware order: avatarRateLimit runs without
		// requirePlayerAuth having set the session. Must not 500.
		const app = new Hono();
		app.use('/avatar', avatarRateLimit);
		app.post('/avatar', (c) => c.json({ ok: true }));
		const res = await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
		expect(res.status).toBe(200);
	});

	it('allows uploads again after the avatar block expires', async () => {
		vi.useFakeTimers();
		try {
			const app = makeAvatarApp(500, 'player-expire-1');
			// Exhaust attempts to trigger a block
			for (let i = 0; i < 22; i++) {
				await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
			}
			// Confirm blocked
			const blockedRes = await app.fetch(
				new Request('http://localhost/avatar', { method: 'POST' })
			);
			expect(blockedRes.status).toBe(429);

			// Advance past the 15-minute block duration
			vi.advanceTimersByTime(15 * 60 * 1000 + 1);

			// Should be allowed again (block-expiry reset path)
			const afterRes = await app.fetch(new Request('http://localhost/avatar', { method: 'POST' }));
			expect(afterRes.status).toBe(500); // handler received it (500, not 429)
		} finally {
			vi.useRealTimers();
		}
	});
});
