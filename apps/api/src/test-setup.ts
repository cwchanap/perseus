import { afterEach, beforeEach, expect, vi } from 'vitest';

let randomSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	const testPath = expect.getState().testPath;
	if (testPath?.endsWith('admin-coverage-gaps.worker.test.ts')) {
		// This suite uses fake timers to assert retry-budget behavior. Production
		// intentionally applies ±20% jitter, so pin the random midpoint in this
		// suite and keep the expected 500 ms base delay deterministic.
		randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
	}
});

afterEach(() => {
	randomSpy?.mockRestore();
	randomSpy = undefined;
});
