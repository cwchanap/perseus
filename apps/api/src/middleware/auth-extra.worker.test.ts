/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for auth.worker.ts.
 * Covers:
 * - isSessionActive: production branch when PUZZLE_METADATA not configured (lines 226-230)
 * - checkFallbackSession: expired session cleanup (lines 243-245)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSession, verifySession, __resetSessionStore } from './auth.worker';
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

beforeEach(() => {
	__resetSessionStore();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
	__resetSessionStore();
});

describe('isInGracePeriod - expired grace period (lines 59-60)', () => {
	it('returns false and removes expired grace period entry (line 59-60)', async () => {
		vi.useFakeTimers();
		try {
			// Step 1: Create a session with a working KV → sets grace period
			const workingKv = {
				_store: new Map<string, string>(),
				get: vi.fn(async function (this: { _store: Map<string, string> }, key: string) {
					return this._store.get(key) ?? null;
				}),
				put: vi.fn(async function (
					this: { _store: Map<string, string> },
					key: string,
					value: string
				) {
					this._store.set(key, value);
				}),
				delete: vi.fn()
			};
			workingKv.get = workingKv.get.bind(workingKv);
			workingKv.put = workingKv.put.bind(workingKv);

			const devEnv: Env = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				NODE_ENV: 'development',
				PUZZLE_METADATA: workingKv as unknown as KVNamespace
			} as unknown as Env;

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const token = await createSession(devEnv, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});
			warnSpy.mockRestore();

			// Step 2: Advance time past the 10-second grace period
			vi.advanceTimersByTime(11_000);

			// Step 3: Verify with a KV that returns null → isInGracePeriod finds expired entry → lines 59-60
			const nullKv = {
				get: vi.fn().mockResolvedValue(null),
				put: vi.fn(),
				delete: vi.fn()
			};
			const nullKvEnv: Env = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				NODE_ENV: 'development',
				PUZZLE_METADATA: nullKv as unknown as KVNamespace
			} as unknown as Env;

			const result = await verifySession(nullKvEnv, token);
			// Grace period expired, KV returns null, not in fallback → session not found
			expect(result).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('assertJwtSecret - missing or too short JWT_SECRET (line 109)', () => {
	it('throws when JWT_SECRET is missing', async () => {
		const envNoSecret: Env = {
			JWT_SECRET: '',
			NODE_ENV: 'development',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		await expect(
			createSession(envNoSecret, { userId: 'admin', username: 'admin', role: 'admin' })
		).rejects.toThrow('JWT_SECRET missing or too short');
	});

	it('throws when JWT_SECRET is too short', async () => {
		const envShortSecret: Env = {
			JWT_SECRET: 'too-short',
			NODE_ENV: 'development',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		await expect(
			createSession(envShortSecret, { userId: 'admin', username: 'admin', role: 'admin' })
		).rejects.toThrow('JWT_SECRET missing or too short');
	});
});

describe('isSessionActive - production with no KV configured (lines 226-230)', () => {
	it('throws when verifySession is called in production without PUZZLE_METADATA configured', async () => {
		// Step 1: Create a valid token using a working KV environment so we have a real token
		const workingKv = createMockKVStore();
		const devEnv: Env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development',
			PUZZLE_METADATA: workingKv
		} as unknown as Env;

		const token = await createSession(devEnv, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});

		// Step 2: Try to verify in production with NO KV configured
		// This hits the `if (env.NODE_ENV !== 'development')` branch in isSessionActive
		const prodNoKvEnv: Env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'production',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(verifySession(prodNoKvEnv, token)).rejects.toThrow(
			'PUZZLE_METADATA not configured'
		);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('PUZZLE_METADATA not configured')
		);
		consoleSpy.mockRestore();
	});
});

describe('isSessionActive - KV returns null but key in fallback store (line 208)', () => {
	it('calls checkFallbackSession when KV returns null and key is in fallback store', async () => {
		// Step 1: Create a session in dev mode WITHOUT KV → goes to in-memory fallback + sessionFallbackKeys
		const noKvDevEnv: Env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development',
			PUZZLE_METADATA: undefined
		} as unknown as Env;

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const token = await createSession(noKvDevEnv, {
			userId: 'admin',
			username: 'admin',
			role: 'admin'
		});
		warnSpy.mockRestore();

		// Step 2: Now verify with a KV configured that always returns null (KV doesn't have the session)
		// This hits the `kvReturnedNull && sessionFallbackKeys.has(key)` branch (line 207-208)
		const kvReturnsNullEnv: Env = {
			JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
			NODE_ENV: 'development',
			PUZZLE_METADATA: {
				get: vi.fn().mockResolvedValue(null),
				put: vi.fn(),
				delete: vi.fn(),
				list: vi.fn()
			}
		} as unknown as Env;

		// The session should still be found via the fallback store
		const result = await verifySession(kvReturnsNullEnv, token);
		// Session is still valid (not expired) → should return the session data
		expect(result).not.toBeNull();
	});
});

describe('checkFallbackSession - expired session cleanup (lines 243-245)', () => {
	it('returns null and removes expired entry from fallback store', async () => {
		vi.useFakeTimers();
		try {
			// Create a session in dev without KV → goes to in-memory fallback store
			const noKvDevEnv: Env = {
				JWT_SECRET: 'test-secret-key-for-testing-purposes-1234567890',
				NODE_ENV: 'development',
				PUZZLE_METADATA: undefined
			} as unknown as Env;

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const token = await createSession(noKvDevEnv, {
				userId: 'admin',
				username: 'admin',
				role: 'admin'
			});

			warnSpy.mockRestore();

			// Advance time past the 24-hour session duration so the fallback entry expires
			vi.advanceTimersByTime(25 * 60 * 60 * 1000);

			// Verify session — checkFallbackSession should find the expired entry,
			// remove it (lines 243-244), and return false (line 245)
			const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await verifySession(noKvDevEnv, token);
			warnSpy2.mockRestore();

			// Should return null since the session has expired
			expect(result).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
