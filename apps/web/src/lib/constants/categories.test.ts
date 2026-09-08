import { describe, it, expect } from 'vitest';
import { CATEGORY_ALL, PUZZLE_CATEGORIES } from './categories';

describe('CATEGORY_ALL', () => {
	it('is the string "All"', () => {
		expect(CATEGORY_ALL).toBe('All');
	});
});

describe('PUZZLE_CATEGORIES re-export', () => {
	it('is an array with expected categories', () => {
		expect(PUZZLE_CATEGORIES).toContain('Animals');
		expect(PUZZLE_CATEGORIES).toContain('Nature');
		expect(PUZZLE_CATEGORIES).toContain('Art');
		expect(PUZZLE_CATEGORIES).toContain('Architecture');
		expect(PUZZLE_CATEGORIES).toContain('Abstract');
		expect(PUZZLE_CATEGORIES).toContain('Food');
		expect(PUZZLE_CATEGORIES).toContain('Travel');
	});
});
