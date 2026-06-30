/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * Avatar rate-limit tests for the Worker runtime (rate-limit.worker.ts).
 * Pins the threshold (AVATAR_MAX_ATTEMPTS = 20, using maxAttempts+1 to
 * compensate for the >= check in checkAndIncrement) and reset-on-success
 * behavior against both KV and in-memory stores.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { avatarRateLimit, resetAvatarAttempts, __resetRateLimitStore } from './rate-limit.worker';
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

let playerCounter = 0;
function uniquePlayerId(): string {
	return `player-worker-${playerCounter++}`;
}

// Mock context with playerSession support (avatarRateLimit reads it via c.get).
function createAvatarMockContext(
	playerId: string,
	kv?: any,
	opts: { nodeEnv?: string } = {}
): Context<any> {
	const variables: Record<string, any> = {
		playerSession: { user: { id: playerId } }
	};
	const res = { status: 200 } as any;
	return {
		env: {
			PUZZLE_METADATA: kv,
			NODE_ENV: opts.nodeEnv ?? 'test'
		},
		req: {
			header: vi.fn((name: string) => {
				if (name === 'cf-connecting-ip') return '127.0.0.1';
				return null;
			})
		},
		res,
		get: vi.fn((key: string) => variables[key]),
		set: vi.fn((key: string, value: any) => {
			variables[key] = value;
		}),
		json: vi.fn((body, status) => ({ body, status }))
	} as any;
}

// Context without playerSession (for fail-open test)
function createNoSessionMockContext(kv?: any): Context<any> {
	const res = { status: 200 } as any;
	return {
		env: {
			PUZZLE_METADATA: kv,
			NODE_ENV: 'test'
		},
		req: {
			header: vi.fn(() => null)
		},
		res,
		get: vi.fn(() => undefined),
		set: vi.fn(),
		json: vi.fn((body, status) => ({ body, status }))
	} as any;
}

describe('avatarRateLimit (Worker)', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	describe('threshold against KV store', () => {
		it('allows the first AVATAR_MAX_ATTEMPTS (20) uploads', async () => {
			const playerId = uniquePlayerId();
			const mockKV = createMockKV();

			for (let i = 0; i < 20; i++) {
				const ctx = createAvatarMockContext(playerId, mockKV);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
				expect(next).toHaveBeenCalled();
			}

			// Verify counter reached 20 and is NOT locked yet
			const key = 'ratelimit:avatar:' + playerId;
			const entry = JSON.parse(mockKV._store.get(key) ?? '{}');
			expect(entry.attempts).toBe(20);
			expect(entry.lockedUntil).toBeNull();
		});

		it('blocks the 21st upload with 429', async () => {
			const playerId = uniquePlayerId();
			const mockKV = createMockKV();

			for (let i = 0; i < 20; i++) {
				const ctx = createAvatarMockContext(playerId, mockKV);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
			}

			const ctx = createAvatarMockContext(playerId, mockKV);
			const next = vi.fn();
			const response = await avatarRateLimit(ctx, next);

			expect(next).not.toHaveBeenCalled();
			expect(response.status).toBe(429);
			expect((response.body as any).error).toBe('too_many_requests');
		});

		it('includes remaining seconds in blocked response message', async () => {
			const playerId = uniquePlayerId();
			const mockKV = createMockKV();

			for (let i = 0; i < 20; i++) {
				const ctx = createAvatarMockContext(playerId, mockKV);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
			}

			const ctx = createAvatarMockContext(playerId, mockKV);
			const next = vi.fn();
			const response = await avatarRateLimit(ctx, next);

			expect(response.status).toBe(429);
			expect((response.body as any).message).toContain('Try again in');
		});
	});

	describe('threshold against in-memory store (KV undefined)', () => {
		it('allows 20 uploads then blocks the 21st', async () => {
			const playerId = uniquePlayerId();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			for (let i = 0; i < 20; i++) {
				const ctx = createAvatarMockContext(playerId, undefined);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
				expect(next).toHaveBeenCalled();
			}

			const ctx = createAvatarMockContext(playerId, undefined);
			const next = vi.fn();
			const response = await avatarRateLimit(ctx, next);

			expect(next).not.toHaveBeenCalled();
			expect(response.status).toBe(429);

			consoleWarnSpy.mockRestore();
			consoleErrorSpy.mockRestore();
		});
	});

	describe('reset on success', () => {
		it('resetAvatarAttempts deletes the counter so subsequent uploads are allowed', async () => {
			const playerId = uniquePlayerId();
			const mockKV = createMockKV();

			// 19 uploads (counter at 19)
			for (let i = 0; i < 19; i++) {
				const ctx = createAvatarMockContext(playerId, mockKV);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
			}

			// Simulate a successful upload: the handler calls resetAvatarAttempts
			const resetCtx = createAvatarMockContext(playerId, mockKV);
			await resetAvatarAttempts(resetCtx);

			// Counter is deleted — verify KV no longer has the key
			const key = 'ratelimit:avatar:' + playerId;
			expect(mockKV._store.get(key)).toBeUndefined();

			// Now 20 more uploads should pass (counter starts fresh)
			for (let i = 0; i < 20; i++) {
				const ctx = createAvatarMockContext(playerId, mockKV);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
				expect(next).toHaveBeenCalled();
			}

			// 21st after reset should block
			const blockCtx = createAvatarMockContext(playerId, mockKV);
			const blockNext = vi.fn();
			const response = await avatarRateLimit(blockCtx, blockNext);
			expect(blockNext).not.toHaveBeenCalled();
			expect(response.status).toBe(429);
		});

		it('resetAvatarAttempts is a no-op when session is not set', async () => {
			const mockKV = createMockKV();
			const ctx = createNoSessionMockContext(mockKV);
			// Should not throw and should not attempt KV delete
			await resetAvatarAttempts(ctx);
			expect(mockKV.delete).not.toHaveBeenCalled();
		});

		it('reset works against in-memory store (KV undefined)', async () => {
			const playerId = uniquePlayerId();
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			// 19 uploads into in-memory store
			for (let i = 0; i < 19; i++) {
				const ctx = createAvatarMockContext(playerId, undefined);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
			}

			// Reset
			const resetCtx = createAvatarMockContext(playerId, undefined);
			await resetAvatarAttempts(resetCtx);

			// 20 more should pass
			for (let i = 0; i < 20; i++) {
				const ctx = createAvatarMockContext(playerId, undefined);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
				expect(next).toHaveBeenCalled();
			}

			consoleWarnSpy.mockRestore();
			consoleErrorSpy.mockRestore();
		});
	});

	describe('keying', () => {
		it('uses avatar:<playerId> as the KV key, separate from login/oauth', async () => {
			const playerId = uniquePlayerId();
			const mockKV = createMockKV();

			const ctx = createAvatarMockContext(playerId, mockKV);
			const next = vi.fn();
			await avatarRateLimit(ctx, next);

			expect(mockKV.put).toHaveBeenCalled();
			const key = mockKV.put.mock.calls[0][0];
			expect(key).toBe('ratelimit:avatar:' + playerId);
			expect(key).not.toContain('login:');
			expect(key).not.toContain('oauth:');
		});

		it('different players have independent counters', async () => {
			const playerA = uniquePlayerId();
			const playerB = uniquePlayerId();
			const mockKV = createMockKV();

			// Exhaust player A
			for (let i = 0; i < 20; i++) {
				const ctx = createAvatarMockContext(playerA, mockKV);
				const next = vi.fn();
				await avatarRateLimit(ctx, next);
			}
			// Player A is blocked
			const ctxA = createAvatarMockContext(playerA, mockKV);
			const blockedRes = await avatarRateLimit(ctxA, vi.fn());
			expect(blockedRes.status).toBe(429);

			// Player B is unaffected
			const ctxB = createAvatarMockContext(playerB, mockKV);
			const nextB = vi.fn();
			await avatarRateLimit(ctxB, nextB);
			expect(nextB).toHaveBeenCalled();
		});
	});

	describe('fail-open when session missing', () => {
		it('lets the request through when playerSession is not set', async () => {
			const mockKV = createMockKV();
			const ctx = createNoSessionMockContext(mockKV);
			const next = vi.fn();

			await avatarRateLimit(ctx, next);

			expect(next).toHaveBeenCalled();
		});
	});
});
