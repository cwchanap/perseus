/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage tests for rate-limit.worker.ts post-request tracking catch blocks.
 *
 * The catch blocks fire when an unexpected error occurs AFTER next() has run.
 * The internal KV functions (setRateLimitEntry, deleteRateLimitEntry,
 * getRateLimitEntry) all have their own try-catch for KV errors, so the outer
 * catch can only fire if something outside those internal handlers throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { oauthRateLimit, __resetRateLimitStore } from './rate-limit.worker';

function createKV() {
	return {
		get: vi.fn(async () => null),
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {})
	};
}

function createOauthContext(ip: string, kv: any, nodeEnv?: string): any {
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

describe('oauthRateLimit – post-request tracking catch (line 429)', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('logs and returns c.res when checkAndIncrement throws during post-request tracking', async () => {
		const kv = createKV();
		// Make kv.put throw so setRateLimitEntry enters its internal catch block,
		// where rateLimitStore.set is called. We then make Map.prototype.set
		// throw for rate-limit keys so that the rateLimitStore.set call in the
		// internal catch block propagates up through checkAndIncrement to the
		// post-request catch.
		kv.put = vi.fn(() => {
			throw new Error('KV put failed');
		});

		const ctx = createOauthContext('30.0.0.2', kv, 'development');
		const next = vi.fn(async () => {
			ctx.res.status = 200;
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// Spy on Map.prototype.set to throw for rate-limit keys (string keys
		// starting with 'oauth:'). This makes rateLimitStore.set throw in
		// setRateLimitEntry's internal catch block, which propagates up.
		const originalSet = Map.prototype.set;
		const setSpy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
			this: Map<any, any>,
			key: any,
			value: any
		) {
			if (typeof key === 'string' && key.startsWith('oauth:')) {
				throw new Error('Map.set poisoned');
			}
			return originalSet.call(this, key, value);
		});

		const response = await oauthRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		// The post-request catch logs the failure
		expect(consoleSpy).toHaveBeenCalledWith(
			'Rate limit post-request tracking failed:',
			expect.any(Error)
		);
		// oauthRateLimit returns c.res (status 200 from next())
		expect(response.status).toBe(200);

		setSpy.mockRestore();
		consoleSpy.mockRestore();
	});
});
