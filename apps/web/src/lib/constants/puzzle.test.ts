import { describe, it, expect } from 'vitest';
import { TAB_RATIO, EXPANSION_FACTOR, BASE_OFFSET } from './puzzle';

describe('TAB_RATIO', () => {
	it('is 0.2 (20% of base piece dimension)', () => {
		expect(TAB_RATIO).toBe(0.2);
	});
});

describe('EXPANSION_FACTOR', () => {
	it('equals 1 + 2 * TAB_RATIO', () => {
		expect(EXPANSION_FACTOR).toBe(1 + 2 * TAB_RATIO);
	});

	it('is 1.4 (140% of base dimension)', () => {
		expect(EXPANSION_FACTOR).toBeCloseTo(1.4);
	});

	it('is greater than 1 so piece containers are larger than base cells', () => {
		expect(EXPANSION_FACTOR).toBeGreaterThan(1);
	});
});

describe('BASE_OFFSET', () => {
	it('equals TAB_RATIO / EXPANSION_FACTOR', () => {
		expect(BASE_OFFSET).toBeCloseTo(TAB_RATIO / EXPANSION_FACTOR);
	});

	it('is approximately 14.29% (tab size relative to expanded container)', () => {
		expect(BASE_OFFSET).toBeCloseTo(0.1429, 3);
	});

	it('is less than 0.5 so pieces stay within their containers', () => {
		expect(BASE_OFFSET).toBeLessThan(0.5);
	});

	it('is positive', () => {
		expect(BASE_OFFSET).toBeGreaterThan(0);
	});
});

describe('constant relationships', () => {
	it('BASE_OFFSET * EXPANSION_FACTOR equals TAB_RATIO', () => {
		expect(BASE_OFFSET * EXPANSION_FACTOR).toBeCloseTo(TAB_RATIO);
	});

	it('all constants are finite positive numbers', () => {
		expect(Number.isFinite(TAB_RATIO)).toBe(true);
		expect(Number.isFinite(EXPANSION_FACTOR)).toBe(true);
		expect(Number.isFinite(BASE_OFFSET)).toBe(true);
		expect(TAB_RATIO).toBeGreaterThan(0);
		expect(EXPANSION_FACTOR).toBeGreaterThan(0);
		expect(BASE_OFFSET).toBeGreaterThan(0);
	});
});
