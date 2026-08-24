import { describe, it, expect } from 'vitest';
import { createDefaultClock } from './runtime';

describe('createDefaultClock', () => {
	it('exposes monotonic/wall time and a clearable interval', () => {
		const clock = createDefaultClock();

		expect(Number.isFinite(clock.monotonicNow())).toBe(true);
		expect(Number.isFinite(clock.wallNow())).toBe(true);

		const handle = clock.setInterval(() => {}, 1_000);
		expect(() => clock.clearInterval(handle)).not.toThrow();
	});
});
