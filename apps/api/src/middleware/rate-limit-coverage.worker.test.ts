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

	it('accumulates in-memory attempts and blocks after MAX_LOGIN_ATTEMPTS (covers !kv && memEntry path)', async () => {
		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Exhaust all 5 allowed attempts (MAX_LOGIN_ATTEMPTS = 5) via failed logins
		for (let i = 1; i <= 5; i++) {
			const ctx = createContext('1.1.1.1', undefined, 'development');
			const next = vi.fn(async () => {
				ctx.res.status = 401; // each failed login increments in-memory counter
			});
			await loginRateLimit(ctx, next);
		}

		consoleSpy.mockRestore();

		// The 6th request for the same IP (no KV) must hit the !kv && memEntry branch
		// and find the locked-out entry — next should NOT be called and the returned
		// response must carry status 429 (loginRateLimit returns c.json(..., 429) directly).
		const ctx6 = createContext('1.1.1.1', undefined, 'development');
		const next6 = vi.fn();
		const consoleSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const response6 = await loginRateLimit(ctx6, next6);
		consoleSpy2.mockRestore();

		expect(next6).not.toHaveBeenCalled();
		// c.json() in the mock returns { body, status } — status must be 429
		expect((response6 as any).status).toBe(429);
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

describe('rate-limit KV read error - production critical logging', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('logs [CRITICAL] when KV.get throws in production mode', async () => {
		const failingKV = {
			get: vi.fn(() => {
				throw new Error('KV outage');
			}),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const ctx = createContext('7.7.7.7', failingKV, 'production');
		const next = vi.fn();

		await loginRateLimit(ctx, next);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('[CRITICAL] KV read failed'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('rate-limit mergeRateLimitEntries - both KV and in-memory have entries', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('merges KV and in-memory entries when both exist (most restrictive wins)', async () => {
		const kv = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// First failed login — writes to both KV mock and in-memory rateLimitStore
		const ctx1 = createContext('3.3.3.3', kv, 'development');
		const next1 = vi.fn(async () => {
			ctx1.res.status = 401;
		});
		await loginRateLimit(ctx1, next1);

		// At this point rateLimitStore has an entry. Now make KV.get return the stored entry
		// so that getRateLimitEntry finds entries in BOTH places, hitting mergeRateLimitEntries.
		const storedEntry = kv.put.mock.calls[0]?.[1];
		kv.get = vi.fn(async () => (storedEntry ? JSON.parse(storedEntry as string) : null));

		// Second failed login — KV returns entry, rateLimitStore also has entry → merge
		const ctx2 = createContext('3.3.3.3', kv, 'development');
		const next2 = vi.fn(async () => {
			ctx2.res.status = 401;
		});
		await loginRateLimit(ctx2, next2);

		// Both calls should have allowed the request through (only 2 attempts, below limit)
		expect(next1).toHaveBeenCalled();
		expect(next2).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});

describe('rate-limit trusted proxy with peer IP not in list', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('warns and falls through to UUID when peerIP is not in TRUSTED_PROXY_LIST', async () => {
		const kv = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		// Context: TRUSTED_PROXY=true, TRUSTED_PROXY_LIST configured but peerIP is NOT in list
		const ctx: any = {
			env: {
				PUZZLE_METADATA: kv,
				TRUSTED_PROXY: 'true',
				TRUSTED_PROXY_LIST: '10.0.0.1,10.0.0.2'
			},
			req: {
				ip: '192.168.99.99', // not in TRUSTED_PROXY_LIST
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return null;
					if (name === 'x-forwarded-for') return '203.0.113.1';
					return null;
				})
			},
			json: vi.fn((body: any, status: number) => ({ body, status })),
			res: { status: 200 } as any
		};

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const next = vi.fn();

		await loginRateLimit(ctx, next);

		// Should warn about untrusted peer and use UUID fallback (effective rate limiting disabled)
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('X-Forwarded-For rejected'));
		expect(next).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('uses XFF IP when peerIP is in TRUSTED_PROXY_LIST', async () => {
		const kv = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx: any = {
			env: {
				PUZZLE_METADATA: kv,
				TRUSTED_PROXY: 'true',
				TRUSTED_PROXY_LIST: '10.0.0.1,10.0.0.2'
			},
			req: {
				ip: '10.0.0.1', // IS in TRUSTED_PROXY_LIST
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return null;
					if (name === 'x-forwarded-for') return '203.0.113.5';
					return null;
				})
			},
			json: vi.fn((body: any, status: number) => ({ body, status })),
			res: { status: 401 } as any
		};

		const next = vi.fn(async () => {
			ctx.res.status = 401;
		});

		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		// KV key should contain the XFF IP (203.0.113.5), not the peer IP
		const putCall = kv.put.mock.calls[0]?.[0] as string | undefined;
		expect(putCall).toContain('203.0.113.5');
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
