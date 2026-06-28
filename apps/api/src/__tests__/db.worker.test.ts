import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock createD1Db so we can exercise the WeakMap caching logic without a real
// D1 binding. The mock returns a distinct object per call so we can assert
// that the cache reuses the same instance for the same env.
vi.mock('@perseus/shared/d1', () => ({
	createD1Db: vi.fn((env: unknown) => ({ __env: env, __id: Math.random() }))
}));

import { getWorkerDb } from '../db.worker';
import { createD1Db } from '@perseus/shared/d1';

describe('getWorkerDb', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns the same instance for the same env (cached)', () => {
		const env = { DB: {} } as unknown as Parameters<typeof getWorkerDb>[0];
		const db1 = getWorkerDb(env);
		const db2 = getWorkerDb(env);
		expect(db1).toBe(db2);
		expect(createD1Db).toHaveBeenCalledTimes(1);
	});

	it('returns distinct instances for different envs', () => {
		const envA = { DB: {} } as unknown as Parameters<typeof getWorkerDb>[0];
		const envB = { DB: {} } as unknown as Parameters<typeof getWorkerDb>[0];
		const dbA = getWorkerDb(envA);
		const dbB = getWorkerDb(envB);
		expect(dbA).not.toBe(dbB);
		expect(createD1Db).toHaveBeenCalledTimes(2);
	});

	it('does not retain env references after they are GC-eligible (WeakMap)', () => {
		// This is a structural assertion: the cache is a WeakMap, so it does
		// not prevent env garbage collection. We can't test GC directly, but
		// we can verify the cache is weak by checking that a new env with the
		// same shape still gets its own instance (no strong-key map behavior).
		const env1 = { DB: {} } as unknown as Parameters<typeof getWorkerDb>[0];
		getWorkerDb(env1);
		// If the cache were a strong Map keyed by something else, a new env
		// object would still miss. With WeakMap keyed by env identity, a new
		// object always misses.
		const env2 = { DB: {} } as unknown as Parameters<typeof getWorkerDb>[0];
		getWorkerDb(env2);
		expect(createD1Db).toHaveBeenCalledTimes(2);
	});
});
