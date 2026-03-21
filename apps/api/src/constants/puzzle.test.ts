import { describe, it, expect } from 'vitest';
import { TAB_RATIO, EXPANSION_FACTOR, BASE_OFFSET } from './puzzle';

describe('Puzzle sizing constants', () => {
	it('TAB_RATIO should be 0.2 (20%)', () => {
		expect(TAB_RATIO).toBe(0.2);
	});

	it('EXPANSION_FACTOR should be 1 + 2 * TAB_RATIO', () => {
		expect(EXPANSION_FACTOR).toBe(1 + 2 * TAB_RATIO);
		expect(EXPANSION_FACTOR).toBe(1.4);
	});

	it('BASE_OFFSET should be TAB_RATIO / EXPANSION_FACTOR (~14.29%)', () => {
		expect(BASE_OFFSET).toBeCloseTo(TAB_RATIO / EXPANSION_FACTOR, 10);
		expect(BASE_OFFSET).toBeCloseTo(0.142857, 5);
	});

	it('BASE_OFFSET should be less than TAB_RATIO', () => {
		expect(BASE_OFFSET).toBeLessThan(TAB_RATIO);
	});

	it('constants should maintain mathematical relationship', () => {
		// Verify: a piece padded by TAB_RATIO on each side occupies EXPANSION_FACTOR of base size
		// The base content within the expanded container starts at BASE_OFFSET
		const contentStart = BASE_OFFSET * EXPANSION_FACTOR;
		expect(contentStart).toBeCloseTo(TAB_RATIO, 10);
	});
});
