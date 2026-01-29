/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
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

		it('should throw on unexpected crypto errors', async () => {
			const mockEnv = {
				JWT_SECRET: 'test-secret-key'
			};

			// Create a token that will cause crypto.subtle to fail
			const badToken = 'validbase64==.validbase64=='; // Valid format but will fail signature verification in an unexpected way

			// Mock crypto.subtle.importKey to throw unexpected error
			const originalImportKey = crypto.subtle.importKey;
			crypto.subtle.importKey = vi.fn(() => {
				return Promise.reject(new Error('Unexpected crypto error'));
			}) as any;

			await expect(verifySession(mockEnv as Env, badToken)).rejects.toThrow(
				'Unexpected crypto error'
			);

			crypto.subtle.importKey = originalImportKey;
		});
	});
});

describe('Cookie Management', () => {
	describe('getSessionToken', () => {
		it('should return undefined when no cookie is set', async () => {
			const app = new Hono();
			let result: string | undefined;

			app.get('/test', (c) => {
				result = getSessionToken(c);
				return c.text('ok');
			});

			// Make request without cookie
			const req = new Request('http://localhost/test');
			await app.fetch(req);

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

	it('should return 500 when session verification throws unexpected error', async () => {
		const app = new Hono<{ Bindings: Env }>();

		// Mock crypto.subtle.importKey to throw unexpected error
		const originalImportKey = crypto.subtle.importKey;
		crypto.subtle.importKey = vi.fn(() => {
			return Promise.reject(new Error('Crypto system failure'));
		}) as any;

		app.use('/protected/*', requireAuth);
		app.get('/protected/resource', (c) => c.json({ data: 'secret' }));

		// Create a request with a token cookie
		const req = new Request('http://localhost/protected/resource', {
			headers: {
				Cookie: 'perseus_session=some.token'
			}
		});

		const res = await app.fetch(req, mockEnv as Env);

		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe('internal_error');
		expect(body.message).toBe('Authentication system error');

		// Restore original function
		crypto.subtle.importKey = originalImportKey;
	});
});

describe('requireAuth with valid token', () => {
	it('should populate session context and call next', async () => {
		const app = new Hono<{ Bindings: Env }>();

		// Create a valid session token
		const token = await createSession(mockEnv as Env, {
			userId: 'user-123',
			username: 'testuser',
			role: 'admin'
		});

		let capturedSession: any = null;

		app.use('/protected/*', requireAuth);
		app.get('/protected/resource', (c) => {
			// Capture the session from context
			capturedSession = (c as any).get('session');
			return c.json({ data: 'secret' });
		});

		// Create a request with a valid session cookie
		const req = new Request('http://localhost/protected/resource', {
			headers: {
				Cookie: `perseus_session=${token}`
			}
		});

		const res = await app.fetch(req, mockEnv as Env);

		// Verify response is successful
		expect(res.status).toBe(200);

		// Verify session data was set on context
		expect(capturedSession).toEqual({
			userId: 'user-123',
			username: 'testuser',
			role: 'admin'
		});
	});

	it('should return 401 for expired token', async () => {
		const app = new Hono<{ Bindings: Env }>();

		// Create an expired token (manually construct with past expiration)
		const payload = {
			userId: 'user-123',
			username: 'testuser',
			role: 'admin',
			iat: Date.now() - 100000,
			exp: Date.now() - 1000 // 1 second ago
		};

		const payloadJson = JSON.stringify(payload);
		const encoder = new TextEncoder();
		const payloadBytes = encoder.encode(payloadJson);
		const secretBytes = encoder.encode(mockEnv.JWT_SECRET!);
		const key = await crypto.subtle.importKey(
			'raw',
			secretBytes,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);

		// Helper function from auth.worker.ts
		function bytesToBase64(bytes: Uint8Array): string {
			const CHUNK_SIZE = 0x8000;
			const chunks = [];
			for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
				const chunk = bytes.subarray(i, i + CHUNK_SIZE);
				chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
			}
			return btoa(chunks.join(''));
		}

		const payloadB64 = bytesToBase64(new Uint8Array(payloadBytes));
		const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
		const signatureB64 = bytesToBase64(new Uint8Array(signature));
		const expiredToken = `${payloadB64}.${signatureB64}`;

		app.use('/protected/*', requireAuth);
		app.get('/protected/resource', (c) => c.json({ data: 'secret' }));

		// Create a request with an expired session cookie
		const req = new Request('http://localhost/protected/resource', {
			headers: {
				Cookie: `perseus_session=${expiredToken}`
			}
		});

		const res = await app.fetch(req, mockEnv as Env);

		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('unauthorized');
	});
});
