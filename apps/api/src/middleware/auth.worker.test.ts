/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
	createSession,
	verifySession,
	getSessionToken,
	requireAuth,
	revokeSession,
	clearSessionCookie
} from './auth.worker';
import type { Env } from '../worker';

function createMockKVStore() {
	const store = new Map<string, string>();
	return {
		_store: store,
		get: vi.fn(async function (key: string) {
			return store.get(key) ?? null;
		}),
		put: vi.fn(async function (key: string, value: string) {
			store.set(key, value);
		}),
		delete: vi.fn(async function (key: string) {
			store.delete(key);
		})
	} as unknown as KVNamespace;
}

// Mock environment
let mockKV = createMockKVStore();
const mockEnv: Partial<Env> = {
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: mockKV
};

describe('Session Token Management', () => {
	beforeEach(() => {
		mockKV = createMockKVStore();
		mockEnv.PUZZLE_METADATA = mockKV;
	});

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

			// Tamper with the payload (use Base64URL encoding to match production format)
			const [, signature] = token.split('.');
			const fakePayload = btoa(
				JSON.stringify({
					userId: 'hacker',
					username: 'hacker',
					role: 'admin',
					iat: Date.now(),
					exp: Date.now() + 100000
				})
			)
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/g, '');
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
				JWT_SECRET: 'different-secret-should-not-match-1234567890'
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
			const payloadB64 = btoa(payloadJson)
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/g, '');

			// Create valid signature for the expired payload
			const key = await crypto.subtle.importKey(
				'raw',
				encoder.encode(mockEnv.JWT_SECRET!),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign']
			);

			const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
			const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/g, '');

			const expiredToken = `${payloadB64}.${signatureB64}`;

			const session = await verifySession(mockEnv as Env, expiredToken);

			expect(session).toBeNull();
		});

		it('should throw on unexpected crypto errors', async () => {
			const testEnv = {
				JWT_SECRET: 'test-secret-key-should-be-long-enough-123456'
			};

			const badToken = 'validbase64==.validbase64==';

			const importKeySpy = vi
				.spyOn(crypto.subtle, 'importKey')
				.mockRejectedValue(new Error('Unexpected crypto error'));
			try {
				await expect(verifySession(testEnv as Env, badToken)).rejects.toThrow(
					'Unexpected crypto error'
				);
			} finally {
				importKeySpy.mockRestore();
			}
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

	describe('clearSessionCookie', () => {
		it('should clear cookie when called from context with Variables typing', async () => {
			const app = new Hono<{ Bindings: Env; Variables: { foo: string } }>();

			app.get('/logout', (c) => {
				clearSessionCookie(c);
				return c.json({ success: true });
			});

			const req = new Request('http://localhost/logout', {
				headers: {
					Cookie: 'perseus_session=token'
				}
			});
			const res = await app.fetch(req, mockEnv as Env);

			expect(res.status).toBe(200);
			const setCookie = res.headers.get('Set-Cookie');
			expect(setCookie).toContain('perseus_session=');
			expect(setCookie).toContain('Max-Age=0');
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

		const importKeySpy = vi
			.spyOn(crypto.subtle, 'importKey')
			.mockRejectedValue(new Error('Crypto system failure'));
		try {
			app.use('/protected/*', requireAuth);
			app.get('/protected/resource', (c) => c.json({ data: 'secret' }));

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
		} finally {
			importKeySpy.mockRestore();
		}
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

		// Helper function from auth.worker.ts (Base64URL variant)
		function bytesToBase64URL(bytes: Uint8Array): string {
			const CHUNK_SIZE = 0x8000;
			const chunks = [];
			for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
				const chunk = bytes.subarray(i, i + CHUNK_SIZE);
				chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
			}
			return btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
		}

		const payloadB64 = bytesToBase64URL(new Uint8Array(payloadBytes));
		const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
		const signatureB64 = bytesToBase64URL(new Uint8Array(signature));
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

describe('revokeSession', () => {
	beforeEach(() => {
		mockKV = createMockKVStore();
		mockEnv.PUZZLE_METADATA = mockKV;
	});

	it('should delete session from KV', async () => {
		const token = await createSession(mockEnv as Env, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});

		// Verify session exists before revocation
		const sessionBefore = await verifySession(mockEnv as Env, token);
		expect(sessionBefore).not.toBeNull();

		await revokeSession(mockEnv as Env, token);

		// Verify session is revoked
		const sessionAfter = await verifySession(mockEnv as Env, token);
		expect(sessionAfter).toBeNull();
	});

	it('should re-throw on KV failure in production', async () => {
		const prodEnv: Partial<Env> = {
			...mockEnv,
			NODE_ENV: 'production',
			PUZZLE_METADATA: {
				get: vi.fn(),
				put: vi.fn(),
				delete: vi.fn(() => {
					throw new Error('KV unavailable');
				})
			} as unknown as KVNamespace
		};

		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(revokeSession(prodEnv as Env, 'any-token')).rejects.toThrow('KV unavailable');
		} finally {
			spy.mockRestore();
		}
	});

	it('should swallow KV failure in development', async () => {
		const devEnv: Partial<Env> = {
			...mockEnv,
			NODE_ENV: 'development',
			PUZZLE_METADATA: {
				get: vi.fn(),
				put: vi.fn(),
				delete: vi.fn(() => {
					throw new Error('KV unavailable');
				})
			} as unknown as KVNamespace
		};

		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			// Should not throw in development
			await expect(revokeSession(devEnv as Env, 'any-token')).resolves.toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});
});
