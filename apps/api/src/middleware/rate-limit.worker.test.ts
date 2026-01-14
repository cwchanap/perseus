import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { loginRateLimit, resetLoginAttempts } from './rate-limit.worker';
import type { Env } from '../worker';

describe('loginRateLimit Middleware', () => {
	let app: Hono<{ Bindings: Env }>;
	const mockEnv = {} as Env;

	beforeEach(() => {
		app = new Hono<{ Bindings: Env }>();
		app.post('/login', loginRateLimit, (c) => {
			resetLoginAttempts(c);
			return c.json({ success: true });
		});
		app.post('/login-fail', loginRateLimit, (c) => {
			// Don't reset attempts - simulate failed login
			return c.json({ success: false }, 401);
		});
	});

	const createRequest = (ip: string = '127.0.0.1') => {
		return new Request('http://localhost/login', {
			method: 'POST',
			headers: {
				'cf-connecting-ip': ip
			}
		});
	};

	const createFailRequest = (ip: string = '127.0.0.1') => {
		return new Request('http://localhost/login-fail', {
			method: 'POST',
			headers: {
				'cf-connecting-ip': ip
			}
		});
	};

	it('should allow first request', async () => {
		const res = await app.fetch(createRequest('1.1.1.1'), mockEnv);
		expect(res.status).toBe(200);
	});

	it('should allow multiple successful requests (rate limit resets on success)', async () => {
		for (let i = 0; i < 10; i++) {
			const res = await app.fetch(createRequest('2.2.2.2'), mockEnv);
			expect(res.status).toBe(200);
		}
	});

	it('should block after 5 failed attempts from same IP', async () => {
		const ip = '3.3.3.3';

		// Make 5 failed attempts
		for (let i = 0; i < 5; i++) {
			const res = await app.fetch(createFailRequest(ip), mockEnv);
			expect(res.status).toBe(401); // Our mock returns 401 for fail
		}

		// 6th attempt should be blocked
		const blockedRes = await app.fetch(createFailRequest(ip), mockEnv);
		expect(blockedRes.status).toBe(429);

		const body = (await blockedRes.json()) as { error: string };
		expect(body.error).toBe('too_many_requests');
	});

	it('should track attempts per IP separately', async () => {
		// Make 4 failed attempts from IP A
		for (let i = 0; i < 4; i++) {
			await app.fetch(createFailRequest('4.4.4.4'), mockEnv);
		}

		// IP B should still be allowed
		const res = await app.fetch(createFailRequest('5.5.5.5'), mockEnv);
		expect(res.status).toBe(401); // Not blocked
	});

	it('should reset attempts on successful login', async () => {
		const ip = '6.6.6.6';

		// Make 3 failed attempts
		for (let i = 0; i < 3; i++) {
			await app.fetch(createFailRequest(ip), mockEnv);
		}

		// Successful login resets the counter
		const successRes = await app.fetch(createRequest(ip), mockEnv);
		expect(successRes.status).toBe(200);

		// Can make more attempts now
		for (let i = 0; i < 4; i++) {
			const res = await app.fetch(createFailRequest(ip), mockEnv);
			expect(res.status).toBe(401); // Not blocked
		}
	});
});
