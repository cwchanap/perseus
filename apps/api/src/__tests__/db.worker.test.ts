import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@perseus/shared/d1', () => ({
	createD1Db: vi.fn((env: unknown) => ({ __env: env })),
	createD1CompletionWriteExecutor: vi.fn((db: unknown) => ({ __db: db }))
}));

import { getWorkerDb, getWorkerDbContext } from '../db.worker';
import { createD1CompletionWriteExecutor, createD1Db } from '@perseus/shared/d1';

describe('getWorkerDbContext', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns the same complete context for the same env', () => {
		const env = { DB: {} } as unknown as Parameters<typeof getWorkerDbContext>[0];
		const first = getWorkerDbContext(env);
		const second = getWorkerDbContext(env);

		expect(first).toBe(second);
		expect(createD1Db).toHaveBeenCalledTimes(1);
		expect(createD1CompletionWriteExecutor).toHaveBeenCalledTimes(1);
		expect(createD1CompletionWriteExecutor).toHaveBeenCalledWith(first.db);
	});

	it('returns distinct complete contexts for different env identities', () => {
		const envA = { DB: {} } as unknown as Parameters<typeof getWorkerDbContext>[0];
		const envB = { DB: {} } as unknown as Parameters<typeof getWorkerDbContext>[0];
		const contextA = getWorkerDbContext(envA);
		const contextB = getWorkerDbContext(envB);

		expect(contextA).not.toBe(contextB);
		expect(contextA.db).not.toBe(contextB.db);
		expect(contextA.completionWrites).not.toBe(contextB.completionWrites);
		expect(createD1Db).toHaveBeenCalledTimes(2);
		expect(createD1CompletionWriteExecutor).toHaveBeenCalledTimes(2);
	});

	it('keeps getWorkerDb as the cached context db projection', () => {
		const env = { DB: {} } as unknown as Parameters<typeof getWorkerDbContext>[0];
		const context = getWorkerDbContext(env);

		expect(getWorkerDb(env)).toBe(context.db);
		expect(createD1Db).toHaveBeenCalledTimes(1);
		expect(createD1CompletionWriteExecutor).toHaveBeenCalledTimes(1);
	});
});
