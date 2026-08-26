/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { oauthRateLimit, __resetRateLimitStore } from './rate-limit.worker';
import type { Context } from 'hono';

function createMockKV() {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (key: string, type?: string) => {
			const value = store.get(key);
			if (!value) return null;
			if (type === 'json') return JSON.parse(value);
			return value;
		}),
		put: vi.fn(async (key: string, value: string, options?: any) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
		_store: store
	};
}

function createMockContext(ip = '127.0.0.1', kv?: any): Context<any> {
	return {
		env: {
			PUZZLE_METADATA: kv
		},
		req: {
			header: vi.fn((name: string) => {
				if (name === 'cf-connecting-ip') return ip;
				if (name === 'x-forwarded-for') return ip;
				return null;
			})
		},
		json: vi.fn((body, status) => ({ body, status })),
		header: vi.fn(),
		res: { status: 200 } as any
	} as any;
}

describe('oauthRateLimit', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('allows a request when no previous attempts exist', async () => {
		const mockKV = createMockKV();
		const mockContext = createMockContext('127.0.0.1', mockKV);
		const next = vi.fn();

		await oauthRateLimit(mockContext, next);

		expect(next).toHaveBeenCalled();
	});

	it('increments the counter on each request', async () => {
		const mockKV = createMockKV();
		const key = 'ratelimit:oauth:127.0.0.1';
		const mockContext = createMockContext('127.0.0.1', mockKV);
		const next = vi.fn();

		await oauthRateLimit(mockContext, next);

		expect(next).toHaveBeenCalled();
		const savedEntry = JSON.parse(mockKV._store.get(key) ?? '{}');
		expect(savedEntry.attempts).toBe(1);
	});

	it('allows requests below the OAuth limit', async () => {
		const mockKV = createMockKV();
		const key = 'ratelimit:oauth:127.0.0.1';
		mockKV._store.set(
			key,
			JSON.stringify({
				attempts: 8,
				lockedUntil: null,
				lastAttemptAt: Date.now()
			})
		);
		const mockContext = createMockContext('127.0.0.1', mockKV);
		const next = vi.fn();

		await oauthRateLimit(mockContext, next);

		expect(next).toHaveBeenCalled();
	});

	it('blocks a request when OAuth attempts reach the limit', async () => {
		const mockKV = createMockKV();
		const key = 'ratelimit:oauth:127.0.0.1';
		mockKV._store.set(
			key,
			JSON.stringify({
				attempts: 10,
				lockedUntil: Date.now() + 15 * 60 * 1000,
				lastAttemptAt: Date.now()
			})
		);
		const mockContext = createMockContext('127.0.0.1', mockKV);
		const next = vi.fn();

		const response = await oauthRateLimit(mockContext, next);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(429);
		expect((response.body as any).error).toBe('too_many_requests');
	});

	it('stores attempts under an OAuth-specific KV key', async () => {
		const mockKV = createMockKV();
		const mockContext = createMockContext('192.168.1.1', mockKV);
		const next = vi.fn();

		await oauthRateLimit(mockContext, next);

		expect(mockKV.put).toHaveBeenCalled();
		expect(mockKV.put.mock.calls[0][0]).toContain('oauth:');
	});

	it('allows a request after lockout expires', async () => {
		const mockKV = createMockKV();
		const key = 'ratelimit:oauth:127.0.0.1';
		mockKV._store.set(
			key,
			JSON.stringify({
				attempts: 10,
				lockedUntil: Date.now() - 1000,
				lastAttemptAt: Date.now() - 2000
			})
		);
		const mockContext = createMockContext('127.0.0.1', mockKV);
		const next = vi.fn();

		await oauthRateLimit(mockContext, next);

		expect(next).toHaveBeenCalled();
		const savedEntry = JSON.parse(mockKV._store.get(key) ?? '{}');
		expect(savedEntry.attempts).toBe(1);
	});

	it('uses in-memory storage when KV is undefined', async () => {
		const mockContext = createMockContext('127.0.0.1');
		const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const next = vi.fn();

		await oauthRateLimit(mockContext, next);

		expect(next).toHaveBeenCalled();
		consoleWarnSpy.mockRestore();
	});

	it('includes remaining seconds in a blocked response', async () => {
		const mockKV = createMockKV();
		mockKV._store.set(
			'ratelimit:oauth:127.0.0.1',
			JSON.stringify({
				attempts: 10,
				lockedUntil: Date.now() + 10 * 60 * 1000,
				lastAttemptAt: Date.now()
			})
		);
		const mockContext = createMockContext('127.0.0.1', mockKV);
		const next = vi.fn();

		const response = await oauthRateLimit(mockContext, next);

		expect((response.body as any).message).toContain('Try again in');
	});

	it('allows exactly ten requests and blocks the eleventh', async () => {
		const mockKV = createMockKV();
		const key = 'ratelimit:oauth:127.0.0.1';

		for (let i = 0; i < 10; i++) {
			const mockContext = createMockContext('127.0.0.1', mockKV);
			const next = vi.fn();

			await oauthRateLimit(mockContext, next);

			expect(next).toHaveBeenCalled();
		}

		const entry = JSON.parse(mockKV._store.get(key) ?? '{}');
		expect(entry.attempts).toBe(10);
		expect(entry.lockedUntil).not.toBeNull();

		const mockContext = createMockContext('127.0.0.1', mockKV);
		const next = vi.fn();
		const response = await oauthRateLimit(mockContext, next);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(429);
	});
});
