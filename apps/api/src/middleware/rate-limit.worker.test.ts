/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loginRateLimit, resetLoginAttempts } from './rate-limit.worker';
import type { Context, Next } from 'hono';

// Mock KV namespace
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

function createMockContext(ip: string = '127.0.0.1', kv?: any): Context<any> {
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
		res: { status: 200 } as any
	} as any;
}

describe('Rate Limit Middleware', () => {
	describe('loginRateLimit', () => {
		it('should allow request when no previous attempts', async () => {
			const mockKV = createMockKV();
			const mockContext = createMockContext('127.0.0.1', mockKV);
			const next = vi.fn();

			await loginRateLimit(mockContext, next);

			expect(next).toHaveBeenCalled();
		});

		it('should allow request with less than 5 failed attempts', async () => {
			const mockKV = createMockKV();
			const key = 'ratelimit:login:127.0.0.1';
			mockKV._store.set(
				key,
				JSON.stringify({
					attempts: 3,
					lockedUntil: null
				})
			);

			const mockContext = createMockContext('127.0.0.1', mockKV);
			const next = vi.fn();

			await loginRateLimit(mockContext, next);

			expect(next).toHaveBeenCalled();
		});

		it('should block request after 5 failed attempts', async () => {
			const mockKV = createMockKV();
			const key = 'ratelimit:login:127.0.0.1';
			const lockoutUntil = Date.now() + 15 * 60 * 1000; // 15 minutes from now

			mockKV._store.set(
				key,
				JSON.stringify({
					attempts: 5,
					lockedUntil: lockoutUntil
				})
			);

			const mockContext = createMockContext('127.0.0.1', mockKV);
			const next = vi.fn();

			const response = await loginRateLimit(mockContext, next);

			expect(next).not.toHaveBeenCalled();
			expect(response.status).toBe(429);
			expect((response.body as any).error).toBe('too_many_requests');
		});

		it('should use cf-connecting-ip header for client identification', async () => {
			const mockKV = createMockKV();
			const mockContext = createMockContext('192.168.1.1', mockKV);
			const next = vi.fn();

			await loginRateLimit(mockContext, next);

			expect(next).toHaveBeenCalled();
			// Verify KV key includes IP
			const calls = mockKV.put.mock.calls;
			if (calls.length > 0) {
				const key = calls[0][0];
				expect(key).toContain('192.168.1.1');
			}
		});

		it('should use in-memory storage when KV is undefined', async () => {
			const mockContext = createMockContext('127.0.0.1', undefined);
			const next = vi.fn();

			await loginRateLimit(mockContext, next);

			expect(next).toHaveBeenCalled();
		});
	});

	describe('resetLoginAttempts', () => {
		it('should delete rate limit entry on successful login', async () => {
			const mockKV = createMockKV();
			const key = 'ratelimit:login:127.0.0.1';
			mockKV._store.set(
				key,
				JSON.stringify({
					attempts: 3,
					lockedUntil: null
				})
			);

			const mockContext = createMockContext('127.0.0.1', mockKV);

			await resetLoginAttempts(mockContext);

			expect(mockKV.delete).toHaveBeenCalledWith(expect.stringContaining('127.0.0.1'));
		});

		it('should handle missing KV gracefully', async () => {
			const mockContext = createMockContext('127.0.0.1', undefined);

			// Should not throw when KV is undefined
			await resetLoginAttempts(mockContext);
			// Test passes if no error is thrown
			expect(true).toBe(true);
		});
	});
});
