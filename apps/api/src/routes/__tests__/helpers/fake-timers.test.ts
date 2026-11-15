import { describe, expect, it, vi } from 'vitest';
import { pumpUntilTimerOrSettled } from './fake-timers';

describe('pumpUntilTimerOrSettled', () => {
	it('throws when the pump exhausts maxTurns with no timer queued and no settlement', async () => {
		vi.useFakeTimers();
		try {
			await expect(pumpUntilTimerOrSettled(new Promise(() => undefined), 5)).rejects.toThrow(
				/exhausted/
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns once the code under test queues its first fake timer', async () => {
		vi.useFakeTimers();
		try {
			const pending = new Promise(() => undefined);
			const pump = pumpUntilTimerOrSettled(pending, 100);
			setTimeout(() => undefined, 10);
			await pump;
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns when the tracked promise settles without a timer', async () => {
		vi.useFakeTimers();
		try {
			await pumpUntilTimerOrSettled(Promise.resolve('done'), 100);
		} finally {
			vi.useRealTimers();
		}
	});
});
