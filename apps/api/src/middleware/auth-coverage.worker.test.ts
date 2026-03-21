/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional coverage tests for auth.worker.ts
 * Covers setSessionCookie/clearSessionCookie secure flag and DOMException path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { setSessionCookie, clearSessionCookie, createSession, verifySession } from './auth.worker';
import type { Env } from '../worker';

function createMockKVStore() {
	const store = new Map<string, string>();
	return {
		_store: store,
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		})
	} as unknown as KVNamespace;
}

let mockKV = createMockKVStore();
const baseEnv: Partial<Env> = {
	JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
	PUZZLE_METADATA: mockKV,
	NODE_ENV: 'development'
};

beforeEach(() => {
	mockKV = createMockKVStore();
	baseEnv.PUZZLE_METADATA = mockKV;
});

describe('setSessionCookie - secure flag', () => {
	it('sets secure=false in development mode', async () => {
		const app = new Hono<{ Bindings: Env }>();
		let capturedSetCookieHeader = '';

		app.post('/set-cookie', (c) => {
			setSessionCookie(c, 'test-token');
			capturedSetCookieHeader = c.res.headers.get('set-cookie') ?? '';
			return c.json({ ok: true });
		});

		const req = new Request('http://localhost/set-cookie', { method: 'POST' });
		const env = { ...baseEnv, NODE_ENV: 'development' } as Env;

		await app.fetch(req, env);

		// In development, secure flag should NOT be present
		expect(capturedSetCookieHeader.toLowerCase()).not.toContain('secure');
	});

	it('sets secure=true when NODE_ENV is production', async () => {
		const app = new Hono<{ Bindings: Env }>();
		let capturedSetCookieHeader = '';

		app.post('/set-cookie', (c) => {
			setSessionCookie(c, 'test-token');
			capturedSetCookieHeader = c.res.headers.get('set-cookie') ?? '';
			return c.json({ ok: true });
		});

		const req = new Request('http://localhost/set-cookie', { method: 'POST' });
		const env = { ...baseEnv, NODE_ENV: 'production' } as Env;

		await app.fetch(req, env);

		// In production, secure flag should be present
		expect(capturedSetCookieHeader.toLowerCase()).toContain('secure');
	});

	it('sets secure=true when NODE_ENV is undefined (treated as production)', async () => {
		const app = new Hono<{ Bindings: Env }>();
		let capturedSetCookieHeader = '';

		app.post('/set-cookie', (c) => {
			setSessionCookie(c, 'test-token');
			capturedSetCookieHeader = c.res.headers.get('set-cookie') ?? '';
			return c.json({ ok: true });
		});

		const req = new Request('http://localhost/set-cookie', { method: 'POST' });
		const env = { ...baseEnv, NODE_ENV: undefined } as unknown as Env;

		await app.fetch(req, env);

		// When NODE_ENV is undefined, secure should be true (production default)
		expect(capturedSetCookieHeader.toLowerCase()).toContain('secure');
	});
});

describe('clearSessionCookie - secure flag', () => {
	it('clears cookie with secure=false in development', async () => {
		const app = new Hono<{ Bindings: Env }>();
		let capturedSetCookieHeader = '';

		app.post('/clear-cookie', (c) => {
			clearSessionCookie(c);
			capturedSetCookieHeader = c.res.headers.get('set-cookie') ?? '';
			return c.json({ ok: true });
		});

		const req = new Request('http://localhost/clear-cookie', { method: 'POST' });
		const env = { ...baseEnv, NODE_ENV: 'development' } as Env;

		await app.fetch(req, env);

		expect(capturedSetCookieHeader).toContain('perseus_session=');
		// Max-Age=0 or Expires in the past indicates deletion
		const isDeleted =
			capturedSetCookieHeader.toLowerCase().includes('max-age=0') ||
			capturedSetCookieHeader.toLowerCase().includes('expires=');
		expect(isDeleted).toBe(true);
	});

	it('clears cookie with secure=true in production', async () => {
		const app = new Hono<{ Bindings: Env }>();
		let capturedSetCookieHeader = '';

		app.post('/clear-cookie', (c) => {
			clearSessionCookie(c);
			capturedSetCookieHeader = c.res.headers.get('set-cookie') ?? '';
			return c.json({ ok: true });
		});

		const req = new Request('http://localhost/clear-cookie', { method: 'POST' });
		const env = { ...baseEnv, NODE_ENV: 'production' } as Env;

		await app.fetch(req, env);

		expect(capturedSetCookieHeader).toContain('perseus_session=');
		expect(capturedSetCookieHeader.toLowerCase()).toContain('secure');
	});
});

describe('verifySession - tampered token with DOMException', () => {
	it('returns null for token with invalid base64url characters', async () => {
		const env = { ...baseEnv, NODE_ENV: 'development' } as Env;

		// A token with characters that cause DOMException in atob
		// The signature part uses base64url; we use characters that will trip up decoding
		const malformedToken = 'validpayload.!!!invalid!!!base64!!!';

		const result = await verifySession(env, malformedToken);
		expect(result).toBeNull();
	});

	it('returns null for a token where payload base64 is garbage', async () => {
		const env = { ...baseEnv, NODE_ENV: 'development' } as Env;

		// Build a token where the payload decodes but is not valid JSON
		const encoder = new TextEncoder();
		const secretBytes = encoder.encode(env.JWT_SECRET);
		const key = await crypto.subtle.importKey(
			'raw',
			secretBytes,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);

		// Encode random non-JSON bytes as base64url
		const randomBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
		const chunks: string[] = [];
		for (const b of randomBytes) chunks.push(String.fromCharCode(b));
		const payloadB64 = btoa(chunks.join(''))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');

		const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
		const sigBytes = new Uint8Array(signature);
		const sigChunks: string[] = [];
		for (const b of sigBytes) sigChunks.push(String.fromCharCode(b));
		const sigB64 = btoa(sigChunks.join(''))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');

		const token = `${payloadB64}.${sigB64}`;

		// Passes signature check but fails JSON.parse -> SyntaxError -> returns null
		const result = await verifySession(env, token);
		expect(result).toBeNull();
	});

	it('returns null for token with only one part (no dot separator)', async () => {
		const env = { ...baseEnv } as Env;

		const result = await verifySession(env, 'onlyonepart');
		expect(result).toBeNull();
	});
});

describe('createSession - minimal valid user', () => {
	it('creates token with only userId', async () => {
		const env = {
			...baseEnv,
			PUZZLE_METADATA: undefined,
			NODE_ENV: 'development'
		} as unknown as Env;

		const token = await createSession(env, {
			userId: 'user-only',
			username: 'user-only',
			role: 'admin'
		});

		expect(typeof token).toBe('string');
		expect(token.split('.')).toHaveLength(2);
	});
});

describe('createSession - KV persistence failures', () => {
	it('throws when KV put fails in production', async () => {
		const prodEnv: Env = {
			...baseEnv,
			NODE_ENV: 'production',
			PUZZLE_METADATA: {
				get: vi.fn(async () => null),
				put: vi.fn(() => {
					throw new Error('KV unavailable');
				}),
				delete: vi.fn(async () => {})
			} as unknown as KVNamespace
		} as unknown as Env;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(
			createSession(prodEnv, { userId: 'admin', username: 'admin', role: 'admin' })
		).rejects.toThrow('Session storage failed');

		consoleSpy.mockRestore();
	});

	it('falls back to in-memory when KV put fails in development', async () => {
		const devEnv: Env = {
			...baseEnv,
			NODE_ENV: 'development',
			PUZZLE_METADATA: {
				get: vi.fn(async () => null),
				put: vi.fn(() => {
					throw new Error('KV write error');
				}),
				delete: vi.fn(async () => {})
			} as unknown as KVNamespace
		} as unknown as Env;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Should not throw in development - falls back to in-memory
		const token = await createSession(devEnv, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});

		expect(typeof token).toBe('string');
		expect(consoleSpy).toHaveBeenCalledWith('Failed to persist session to KV:', expect.any(Error));
		consoleSpy.mockRestore();
		warnSpy.mockRestore();
	});

	it('throws when no KV configured in production', async () => {
		const prodEnv: Env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'production',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		await expect(
			createSession(prodEnv, { userId: 'admin', username: 'admin', role: 'admin' })
		).rejects.toThrow('KV namespace PUZZLE_METADATA is not configured');
	});
});

describe('assertJwtSecret - whitespace warning', () => {
	it('warns when JWT_SECRET has leading whitespace', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const envWithSpace: Env = {
			JWT_SECRET: ' test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development',
			PUZZLE_METADATA: createMockKVStore()
		} as unknown as Env;

		// createSession triggers assertJwtSecret internally
		const token = await createSession(envWithSpace, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});

		expect(token).toBeDefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('JWT_SECRET contains leading or trailing whitespace')
		);
		warnSpy.mockRestore();
	});
});

describe('verifySession - KV read failure paths', () => {
	it('(A) returns null on KV miss when grace period has expired', async () => {
		// Create the token using KV so createSession populates the grace period entry,
		// then advance time past SESSION_GRACE_PERIOD_MS (10 s) so the grace period is gone.
		vi.useFakeTimers();
		try {
			const envWithKV: Env = { ...baseEnv } as Env;
			const token = await createSession(envWithKV, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			// Advance system clock beyond the 10-second grace period
			vi.advanceTimersByTime(11_000);

			// Now verify against a KV that always returns null — grace period is gone
			const env: Env = {
				...baseEnv,
				NODE_ENV: 'development',
				PUZZLE_METADATA: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {}),
					delete: vi.fn(async () => {})
				} as unknown as KVNamespace
			} as unknown as Env;

			const result = await verifySession(env, token);
			expect(result).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('(B) returns session payload when KV misses but grace period is still active', async () => {
		// Freeze time so the grace period set by createSession is still valid during verifySession.
		vi.useFakeTimers();
		try {
			// createSession stores the token in baseEnv's KV and registers the grace period.
			const envWithKV: Env = { ...baseEnv } as Env;
			const token = await createSession(envWithKV, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			// Do NOT advance time — grace period (10 s) has not expired yet.
			// Verify against a KV that returns null to force the grace-period branch.
			const env: Env = {
				...baseEnv,
				NODE_ENV: 'development',
				PUZZLE_METADATA: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {}),
					delete: vi.fn(async () => {})
				} as unknown as KVNamespace
			} as unknown as Env;

			const result = await verifySession(env, token);
			expect(result).not.toBeNull();
			expect(typeof result).toBe('object');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('isSessionActive - KV throws error (retry logic)', () => {
	beforeEach(() => {
		mockKV = createMockKVStore();
		baseEnv.PUZZLE_METADATA = mockKV;
	});

	it('retries on KV error and returns false when all retries fail (no fallback) in dev', async () => {
		// Use an async throwing KV so retries complete without fake timers
		const throwingKV = {
			get: vi.fn(async () => {
				throw new Error('KV connection error');
			}),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		} as unknown as KVNamespace;

		const env: Env = {
			...baseEnv,
			NODE_ENV: 'development',
			PUZZLE_METADATA: throwingKV
		} as unknown as Env;

		// Create a fresh token stored in a separate working KV (not in throwingKV fallback)
		const freshKV = createMockKVStore();
		const freshEnv: Env = {
			...baseEnv,
			PUZZLE_METADATA: freshKV
		} as Env;
		const token = await createSession(freshEnv, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const result = await verifySession(env, token);

		// All retries failed, no fallback → returns null (session not found)
		expect(result).toBeNull();
		// Error should have been logged for each retry attempt
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to read session store'),
			expect.any(Error)
		);
		// Dev fallback warning should be logged
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('KV read failed after retries'));

		consoleSpy.mockRestore();
		warnSpy.mockRestore();
	}, 10000);

	it('throws when all KV retries fail in production mode', async () => {
		const throwingKV = {
			get: vi.fn(async () => {
				throw new Error('KV production outage');
			}),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		} as unknown as KVNamespace;

		const env: Env = {
			...baseEnv,
			NODE_ENV: 'production',
			PUZZLE_METADATA: throwingKV
		} as unknown as Env;

		// Create token with a working KV so it's not in the throwingKV fallback
		const freshKV = createMockKVStore();
		const freshEnv: Env = { ...baseEnv, PUZZLE_METADATA: freshKV } as Env;
		const token = await createSession(freshEnv, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(verifySession(env, token)).rejects.toThrow('KV production outage');

		consoleSpy.mockRestore();
	}, 10000);

	it('uses fallback session when KV retries fail in development and fallback exists', async () => {
		// Create session using dev in-memory fallback (no KV)
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const devEnvNoKV: Env = {
			...baseEnv,
			NODE_ENV: 'development',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		const token = await createSession(devEnvNoKV, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		warnSpy.mockRestore();

		// Now verify with a KV that always throws — should fall through to in-memory fallback
		const throwingKV = {
			get: vi.fn(async () => {
				throw new Error('KV error');
			}),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		} as unknown as KVNamespace;

		const env: Env = {
			...baseEnv,
			NODE_ENV: 'development',
			PUZZLE_METADATA: throwingKV
		} as unknown as Env;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const result = await verifySession(env, token);

		// Should find session in fallback store
		expect(result).not.toBeNull();
		expect(result?.userId).toBe('admin');

		consoleSpy.mockRestore();
		warnSpy2.mockRestore();
	}, 10000);
});

describe('isSessionActive - no KV configured', () => {
	it('throws in production when PUZZLE_METADATA is not configured', async () => {
		const prodEnvNoKV: Env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'production',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		// We can't call createSession with this env (it would throw), so build token manually
		const encoder = new TextEncoder();
		const payload = {
			userId: 'admin',
			username: 'admin',
			role: 'admin',
			iat: Date.now(),
			exp: Date.now() + 86400000
		};
		const payloadB64 = btoa(JSON.stringify(payload))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/g, '');
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(prodEnvNoKV.JWT_SECRET),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
		const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/g, '');
		const token = `${payloadB64}.${sigB64}`;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(verifySession(prodEnvNoKV, token)).rejects.toThrow(
			'PUZZLE_METADATA not configured'
		);

		consoleSpy.mockRestore();
	});
});

describe('checkFallbackSession edge cases', () => {
	it('returns false for a session not in the fallback store', async () => {
		// Verify with dev no-KV env and a token that was never stored in fallback
		const devEnvNoKV: Env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		const encoder = new TextEncoder();
		const payload = {
			userId: 'admin',
			username: 'admin',
			role: 'admin',
			iat: Date.now(),
			exp: Date.now() + 86400000
		};
		const payloadB64 = btoa(JSON.stringify(payload))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/g, '');
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(devEnvNoKV.JWT_SECRET),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
		const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/g, '');
		// This token has a valid signature but was never stored in the fallback
		const token = `${payloadB64}.${sigB64}`;

		const result = await verifySession(devEnvNoKV, token);

		// Token validates cryptographically but isn't in the fallback store → null
		expect(result).toBeNull();
	});

	it('returns false for an expired fallback session', async () => {
		vi.useFakeTimers();

		try {
			// Create a dev session (no KV) which goes into the in-memory fallback
			const devEnvNoKV: Env = {
				...baseEnv,
				NODE_ENV: 'development',
				PUZZLE_METADATA: undefined
			} as unknown as Env;

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const token = await createSession(devEnvNoKV, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});
			warnSpy.mockRestore();

			// Advance time past the 24-hour session expiry + grace period
			vi.advanceTimersByTime(25 * 60 * 60 * 1000);

			// Verify should now fail — fallback session is expired
			const result = await verifySession(devEnvNoKV, token);
			expect(result).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
