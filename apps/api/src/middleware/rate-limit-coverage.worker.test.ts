/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional coverage tests for rate-limit.worker.ts
 * Covers KV write/delete failure paths and post-auth tracking errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('rate-limit KV read failure in production', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('logs [CRITICAL] on KV read failure in production', async () => {
		const failingKV = {
			get: vi.fn(() => {
				throw new Error('KV outage in production');
			}),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx = {
			env: {
				PUZZLE_METADATA: failingKV,
				NODE_ENV: 'production'
			},
			req: {
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return '10.10.10.10';
					return null;
				})
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const next = vi.fn();
		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('[CRITICAL] KV read failed'),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});
});

describe('rate-limit KV and in-memory entry merge', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('merges KV and in-memory entries when both exist for the same IP', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Step 1: populate in-memory store via a failed login with no KV
		const ctx1 = {
			env: { PUZZLE_METADATA: undefined, NODE_ENV: 'development' },
			req: {
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return '5.5.5.5';
					return null;
				})
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];
		const next1 = vi.fn(async () => {
			(ctx1.res as { status: number }).status = 401;
		});
		await loginRateLimit(ctx1, next1);
		warnSpy.mockRestore();

		// Step 2: call again with KV that also has an entry — triggers merge path
		const kvEntry = { attempts: 3, lockedUntil: null, lastAttemptAt: Date.now() };
		const kv = {
			get: vi.fn(async (_key: string, type: string) => (type === 'json' ? kvEntry : null)),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx2 = {
			env: { PUZZLE_METADATA: kv, NODE_ENV: 'development' },
			req: {
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return '5.5.5.5';
					return null;
				})
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];
		const next2 = vi.fn();
		await loginRateLimit(ctx2, next2);

		// Merge should have run; KV entry (3 attempts) wins over memory (1 attempt).
		// 3 < 5 so not blocked — next still called.
		expect(next2).toHaveBeenCalled();
		expect(kv.get).toHaveBeenCalled();
	});
});

describe('rate-limit trusted proxy with TRUSTED_PROXY_LIST', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('uses X-Forwarded-For when peer IP is in TRUSTED_PROXY_LIST', async () => {
		const mockKV = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx = {
			env: {
				PUZZLE_METADATA: mockKV,
				NODE_ENV: 'development',
				TRUSTED_PROXY: 'true',
				TRUSTED_PROXY_LIST: '10.0.0.1,10.0.0.2'
			},
			req: {
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return null;
					if (name === 'x-forwarded-for') return '192.168.100.1';
					return null;
				}),
				ip: '10.0.0.1' // peer IP is in the trusted list
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];

		const next = vi.fn(async () => {
			(ctx.res as { status: number }).status = 401;
		});
		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		// The KV key should include the real client IP from X-Forwarded-For
		expect(mockKV.put).toHaveBeenCalled();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const kvKey: string = (mockKV.put.mock.calls as any)[0][0];
		expect(kvKey).toContain('192.168.100.1');
	});

	it('logs X-Forwarded-For rejection warning when peer IP is NOT in TRUSTED_PROXY_LIST', async () => {
		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const mockKV = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx = {
			env: {
				PUZZLE_METADATA: mockKV,
				NODE_ENV: 'development',
				TRUSTED_PROXY: 'true',
				TRUSTED_PROXY_LIST: '10.0.0.1'
			},
			req: {
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return null;
					if (name === 'x-forwarded-for') return '192.168.100.1';
					return null;
				}),
				ip: '9.9.9.9' // peer IP NOT in trusted list
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];

		const next = vi.fn();
		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('X-Forwarded-For rejected'));
		consoleSpy.mockRestore();
	});
});

describe('rate-limit trusted proxy backward-compat (no TRUSTED_PROXY_LIST, line 115)', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('uses X-Forwarded-For IP when TRUSTED_PROXY=true but no TRUSTED_PROXY_LIST is configured', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const mockKV = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const ctx = {
			env: {
				PUZZLE_METADATA: mockKV,
				NODE_ENV: 'development',
				TRUSTED_PROXY: 'true'
				// No TRUSTED_PROXY_LIST → triggers backward-compat path
			},
			req: {
				header: vi.fn((name: string) => {
					if (name === 'cf-connecting-ip') return null;
					if (name === 'x-forwarded-for') return '10.20.30.40';
					return null;
				}),
				ip: undefined // no peer IP info
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];

		const next = vi.fn(async () => {
			(ctx.res as { status: number }).status = 401;
		});

		await loginRateLimit(ctx, next);

		expect(next).toHaveBeenCalled();
		// The XFF IP (10.20.30.40) should have been used in the KV key
		expect(mockKV.put).toHaveBeenCalled();
		const kvKey: string = (mockKV.put.mock.calls as any)[0][0];
		expect(kvKey).toContain('10.20.30.40');

		warnSpy.mockRestore();
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

describe('mergeRateLimitEntries - both locked (line 173)', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('returns KV entry when both KV and memory entries are locked (KV lockedUntil >= mem lockedUntil)', async () => {
		const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Step 1: Trigger 5 failed logins with no KV → in-memory store gets locked entry
		for (let i = 0; i < 5; i++) {
			const ctx = {
				env: { PUZZLE_METADATA: undefined, NODE_ENV: 'development' },
				req: { header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '7.7.7.7' : null)) },
				json: vi.fn((body: unknown, status: number) => ({ body, status })),
				res: { status: 200 }
			} as unknown as Parameters<typeof loginRateLimit>[0];
			const next = vi.fn(async () => {
				(ctx.res as { status: number }).status = 401;
			});
			await loginRateLimit(ctx, next);
		}
		consoleSpy.mockRestore();

		// Memory is now locked. Step 2: Provide a KV that also returns a locked entry.
		// KV's lockedUntil is further in the future, so KV entry wins.
		const kvLockedUntil = Date.now() + 30 * 60 * 1000;
		const lockedKvEntry = { attempts: 5, lockedUntil: kvLockedUntil, lastAttemptAt: Date.now() };
		const kv = {
			get: vi.fn(async (_key: string, type: string) =>
				type === 'json' ? lockedKvEntry : JSON.stringify(lockedKvEntry)
			),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};

		const ctx = {
			env: { PUZZLE_METADATA: kv, NODE_ENV: 'development' },
			req: { header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '7.7.7.7' : null)) },
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];
		const next = vi.fn();

		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await loginRateLimit(ctx, next);
		errSpy.mockRestore();

		// Both are locked → merge picks the one with later lockedUntil (KV)
		// The request should be blocked (429) since both entries are locked
		expect(next).not.toHaveBeenCalled();
		// json should have been called with 429
		expect((ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(429);
	});
});

describe('mergeRateLimitEntries - same attempts, use most recent lastAttemptAt (line 182)', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('returns KV entry when both unlocked, same attempts, KV has more recent lastAttemptAt', async () => {
		vi.useFakeTimers();
		try {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			// Step 1: make 1 failed login with no KV → memory gets entry with attempts=1, lastAttemptAt=T
			const ctx1 = {
				env: { PUZZLE_METADATA: undefined, NODE_ENV: 'development' },
				req: { header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '8.8.8.8' : null)) },
				json: vi.fn((body: unknown, status: number) => ({ body, status })),
				res: { status: 200 }
			} as unknown as Parameters<typeof loginRateLimit>[0];
			const next1 = vi.fn(async () => {
				(ctx1.res as { status: number }).status = 401;
			});
			await loginRateLimit(ctx1, next1);

			// Advance time by 1 second so KV entry's lastAttemptAt will be more recent
			vi.advanceTimersByTime(1000);

			// Step 2: KV returns entry with same attempts=1 but more recent lastAttemptAt (now + 1s)
			const kvEntry = { attempts: 1, lockedUntil: null, lastAttemptAt: Date.now() };
			const kv = {
				get: vi.fn(async (_key: string, type: string) =>
					type === 'json' ? kvEntry : JSON.stringify(kvEntry)
				),
				put: vi.fn(async () => {}),
				delete: vi.fn(async () => {})
			};

			const ctx2 = {
				env: { PUZZLE_METADATA: kv, NODE_ENV: 'development' },
				req: { header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '8.8.8.8' : null)) },
				json: vi.fn((body: unknown, status: number) => ({ body, status })),
				res: { status: 200 }
			} as unknown as Parameters<typeof loginRateLimit>[0];
			const next2 = vi.fn(async () => {
				(ctx2.res as { status: number }).status = 401;
			});

			await loginRateLimit(ctx2, next2);
			warnSpy.mockRestore();

			// Not locked yet (only 2 total attempts across both calls), so next is called
			expect(next2).toHaveBeenCalled();
			// KV put should have been called to record the merged entry
			expect(kv.put).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('cleanupExpiredEntries - expired locked entry (line 37)', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('removes locked entry from store when lockedUntil has passed', async () => {
		vi.useFakeTimers();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Trigger 5 failed logins with no KV → memory gets locked entry
		for (let i = 0; i < 5; i++) {
			const ctx = {
				env: { PUZZLE_METADATA: undefined, NODE_ENV: 'development' },
				req: {
					header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '11.11.11.11' : null))
				},
				json: vi.fn((body: unknown, status: number) => ({ body, status })),
				res: { status: 200 }
			} as unknown as Parameters<typeof loginRateLimit>[0];
			const next = vi.fn(async () => {
				(ctx.res as { status: number }).status = 401;
			});
			await loginRateLimit(ctx, next);
		}

		// Advance time past lockout (15 min) AND past LOCKOUT_DURATION_MS for stale cleanup
		vi.advanceTimersByTime(16 * 60 * 1000);

		// Make a new request - cleanupExpiredEntries should remove the expired locked entry
		const freshCtx = {
			env: { PUZZLE_METADATA: undefined, NODE_ENV: 'development' },
			req: {
				header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '11.11.11.11' : null))
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];
		const freshNext = vi.fn(async () => {
			(freshCtx.res as { status: number }).status = 401;
		});
		await loginRateLimit(freshCtx, freshNext);
		warnSpy.mockRestore();

		// After cleanup and the new (single) failed attempt, should NOT be blocked
		expect(freshNext).toHaveBeenCalled();
	});

	it('removes stale unlocked entry from store when lastAttemptAt is too old (line 40)', async () => {
		vi.useFakeTimers();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Single failed login with no KV → memory gets unlocked entry with 1 attempt
		const ctx = {
			env: { PUZZLE_METADATA: undefined, NODE_ENV: 'development' },
			req: {
				header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '12.12.12.12' : null))
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];
		const next = vi.fn(async () => {
			(ctx.res as { status: number }).status = 401;
		});
		await loginRateLimit(ctx, next);

		// Advance time past LOCKOUT_DURATION_MS (15 min) for stale entry cleanup
		vi.advanceTimersByTime(16 * 60 * 1000);

		// Make a new request - cleanupExpiredEntries should remove the stale unlocked entry
		const freshCtx = {
			env: { PUZZLE_METADATA: undefined, NODE_ENV: 'development' },
			req: {
				header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '12.12.12.12' : null))
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];
		const freshNext = vi.fn(async () => {
			(freshCtx.res as { status: number }).status = 401;
		});
		await loginRateLimit(freshCtx, freshNext);
		warnSpy.mockRestore();

		// Entry was cleaned up; this is the first fresh attempt, so not blocked
		expect(freshNext).toHaveBeenCalled();
	});
});

describe('isRateLimitEntry - invalid lockedUntil (line 54)', () => {
	beforeEach(() => {
		__resetRateLimitStore();
	});

	it('logs warning and resets when KV returns entry with non-numeric lockedUntil', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// KV returns an entry where lockedUntil is a string (invalid)
		const malformedEntry = { attempts: 3, lockedUntil: 'not-a-number', lastAttemptAt: Date.now() };
		const kv = {
			get: vi.fn(async (_key: string, type: string) =>
				type === 'json' ? malformedEntry : JSON.stringify(malformedEntry)
			),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};

		const ctx = {
			env: { PUZZLE_METADATA: kv, NODE_ENV: 'development' },
			req: {
				header: vi.fn((name: string) => (name === 'cf-connecting-ip' ? '13.13.13.13' : null))
			},
			json: vi.fn((body: unknown, status: number) => ({ body, status })),
			res: { status: 200 }
		} as unknown as Parameters<typeof loginRateLimit>[0];
		const next = vi.fn();
		await loginRateLimit(ctx, next);
		warnSpy.mockRestore();

		// Invalid entry → warning logged, treated as no entry → not blocked
		expect(next).toHaveBeenCalled();
	});
});
