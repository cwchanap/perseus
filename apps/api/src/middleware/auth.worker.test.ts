import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createSession, verifySession, getSessionToken, requireAuth } from './auth.worker';
import type { Env } from '../worker';

// Mock environment
const mockEnv: Partial<Env> = {
	JWT_SECRET: 'test-secret-key-for-testing-purposes'
};

describe('Session Token Management', () => {
	describe('createSession', () => {
		it('should create a valid session token', async () => {
			const token = await createSession(mockEnv as Env, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			expect(token).toBeDefined();
			expect(typeof token).toBe('string');
			expect(token.split('.')).toHaveLength(2); // payload.signature format
		});

		it('should create unique tokens for different sessions', async () => {
			const token1 = await createSession(mockEnv as Env, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			// Wait a bit to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 10));

			const token2 = await createSession(mockEnv as Env, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			expect(token1).not.toBe(token2);
		});
	});

	describe('verifySession', () => {
		it('should verify a valid session token', async () => {
			const token = await createSession(mockEnv as Env, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			const session = await verifySession(mockEnv as Env, token);

			expect(session).not.toBeNull();
			expect(session?.userId).toBe('admin');
			expect(session?.username).toBe('admin');
			expect(session?.role).toBe('admin');
		});

		it('should return null for invalid token format', async () => {
			const session = await verifySession(mockEnv as Env, 'invalid-token');

			expect(session).toBeNull();
		});

		it('should return null for tampered signature', async () => {
			const token = await createSession(mockEnv as Env, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			// Tamper with the signature
			const [payload] = token.split('.');
			const tamperedToken = `${payload}.tampered-signature`;

			const session = await verifySession(mockEnv as Env, tamperedToken);

			expect(session).toBeNull();
		});

		it('should return null for tampered payload', async () => {
			const token = await createSession(mockEnv as Env, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			// Tamper with the payload
			const [, signature] = token.split('.');
			const fakePayload = btoa(
				JSON.stringify({
					userId: 'hacker',
					username: 'hacker',
					role: 'admin',
					iat: Date.now(),
					exp: Date.now() + 100000
				})
			);
			const tamperedToken = `${fakePayload}.${signature}`;

			const session = await verifySession(mockEnv as Env, tamperedToken);

			expect(session).toBeNull();
		});

		it('should return null for different secret', async () => {
			const token = await createSession(mockEnv as Env, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			const differentEnv: Partial<Env> = {
				JWT_SECRET: 'different-secret'
			};

			const session = await verifySession(differentEnv as Env, token);

			expect(session).toBeNull();
		});

		it('should return null for expired token', async () => {
			// Create a token that is already expired by manipulating the payload
			const expiredPayload = {
				userId: 'admin',
				username: 'admin',
				role: 'admin',
				iat: Date.now() - 100000,
				exp: Date.now() - 50000 // Expired 50 seconds ago
			};

			const encoder = new TextEncoder();
			const payloadJson = JSON.stringify(expiredPayload);
			const payloadB64 = btoa(payloadJson);

			// Create valid signature for the expired payload
			const key = await crypto.subtle.importKey(
				'raw',
				encoder.encode(mockEnv.JWT_SECRET!),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign']
			);

			const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
			const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

			const expiredToken = `${payloadB64}.${signatureB64}`;

			const session = await verifySession(mockEnv as Env, expiredToken);

			expect(session).toBeNull();
		});
	});
});

describe('Cookie Management', () => {
	describe('getSessionToken', () => {
		it('should return undefined when no cookie is set', () => {
			const app = new Hono();
			let result: string | undefined;

			app.get('/test', (c) => {
				result = getSessionToken(c);
				return c.text('ok');
			});

			// Make request without cookie
			const req = new Request('http://localhost/test');
			app.fetch(req);

			// Note: getSessionToken returns undefined for no cookie
			expect(result).toBeUndefined();
		});
	});
});

describe('requireAuth Middleware', () => {
	it('should return 401 when no token is present', async () => {
		const app = new Hono<{ Bindings: Env }>();

		app.use('/protected/*', requireAuth);
		app.get('/protected/resource', (c) => c.json({ data: 'secret' }));

		const res = await app.fetch(new Request('http://localhost/protected/resource'), mockEnv as Env);

		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('unauthorized');
	});
});
