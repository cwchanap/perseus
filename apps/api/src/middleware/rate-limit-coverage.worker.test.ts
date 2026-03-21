/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional coverage tests for rate-limit.worker.ts
 * Covers KV write/delete failure paths and post-auth tracking errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loginRateLimit, resetLoginAttempts, __resetRateLimitStore } from './rate-limit.worker';

function createFailingPutKV() {
	return {
		get: vi.fn(async () => null),
		put: vi.fn(() => {
			throw new Error('KV put failed');
		}),
		delete: vi.fn(async () => {})
	};
}

function createFailingDeleteKV() {
	return {
		get: vi.fn(async () => null),
		put: vi.fn(async () => {}),
		delete: vi.fn(() => {
			throw new Error('KV delete failed');
		})
	};
}

function createContext(ip: string, kv: any, nodeEnv?: string): any {
	return {
		env: {
			PUZZLE_METADATA: kv,
			NODE_ENV: nodeEnv
		},
		req: {
			header: vi.fn((name: string) => {
				if (name === 'cf-connecting-ip') return ip;
				return null;
			})
		},
		json: vi.fn((body: any, status: number) => ({ body, status })),
		res: { status: 200 } as any
	};
}

describe('rate-limit KV write failure', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('falls back to in-memory when KV put fails in development', async () => {
		const kv = createFailingPutKV();
		const ctx = createContext('1.2.3.4', kv, 'development');
		const next = vi.fn(async () => {
			ctx.res.status = 401;
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		// KV put was attempted but failed; no throw
		expect(kv.put).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	it('falls back to in-memory when KV put fails in production', async () => {
		const kv = createFailingPutKV();
		const ctx = createContext('1.2.3.4', kv, 'production');
		const next = vi.fn(async () => {
			ctx.res.status = 401;
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		expect(kv.put).toHaveBeenCalled();
		// Should log critical error for production
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('[CRITICAL]'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('rate-limit KV delete failure', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('logs error but does not throw when KV delete fails in development on successful login', async () => {
		const kv = createFailingDeleteKV();
		const ctx = createContext('5.6.7.8', kv, 'development');
		const next = vi.fn(async () => {
			ctx.res.status = 200; // successful login
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		expect(response.status).toBe(200);
		expect(kv.delete).toHaveBeenCalled();
		// Dev: logs without critical prefix
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('KV delete failed'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('logs critical error when KV delete fails in production on successful login', async () => {
		const kv = createFailingDeleteKV();
		const ctx = createContext('5.6.7.8', kv, 'production');
		const next = vi.fn(async () => {
			ctx.res.status = 200; // successful login
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		expect(response.status).toBe(200);
		expect(kv.delete).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('[CRITICAL] KV delete failed'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('does not throw when KV delete fails via resetLoginAttempts in development', async () => {
		const kv = createFailingDeleteKV();
		const ctx = createContext('9.9.9.9', kv, 'development');

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(resetLoginAttempts(ctx)).resolves.toBeUndefined();

		consoleSpy.mockRestore();
	});

	it('does not throw when KV delete fails via resetLoginAttempts in production', async () => {
		const kv = createFailingDeleteKV();
		const ctx = createContext('9.9.9.9', kv, 'production');

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(resetLoginAttempts(ctx)).resolves.toBeUndefined();

		consoleSpy.mockRestore();
	});
});

describe('rate-limit in-memory with prior entry', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('returns existing in-memory entry when kv is undefined (covers !kv && memEntry path)', async () => {
		// Make a first request without KV to seed in-memory store
		const ctx1 = createContext('1.1.1.1', undefined, 'development');
		const next1 = vi.fn(async () => {
			ctx1.res.status = 401; // failed login seeds in-memory
		});

		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await loginRateLimit(ctx1, next1);
		consoleSpy.mockRestore();

		// Second request for same IP, still no KV - should find the in-memory entry
		const ctx2 = createContext('1.1.1.1', undefined, 'development');
		const next2 = vi.fn(async () => {
			ctx2.res.status = 401;
		});
		const consoleSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await loginRateLimit(ctx2, next2);
		consoleSpy2.mockRestore();

		// next2 should have been called (not blocked after just 2 attempts)
		expect(next2).toHaveBeenCalled();
	});

	it('logs production critical error when KV not configured', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const ctx = createContext('2.2.2.2', undefined, 'production');
		const next = vi.fn();

		await loginRateLimit(ctx, next);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('[CRITICAL] Rate limiting using in-memory storage in production')
		);
		consoleSpy.mockRestore();
	});
});

describe('rate-limit post-auth tracking - 403 response', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('increments failed attempts for 403 responses (same as 401)', async () => {
		const kv = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx = createContext('10.0.0.1', kv, 'development');
		const next = vi.fn(async () => {
			ctx.res.status = 403; // 403 also triggers post-auth increment
		});

		const response = await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		expect(response.status).toBe(403);
		// KV put should have been called to record the attempt
		expect(kv.put).toHaveBeenCalled();
	});

	it('does not track for non-auth status codes (e.g. 500)', async () => {
		const kv = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx = createContext('10.0.0.3', kv, 'development');
		const next = vi.fn(async () => {
			ctx.res.status = 500; // 500 should not trigger rate limit increment or reset
		});

		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		// No KV put or delete for non-auth responses
		expect(kv.put).not.toHaveBeenCalled();
		expect(kv.delete).not.toHaveBeenCalled();
	});
});
