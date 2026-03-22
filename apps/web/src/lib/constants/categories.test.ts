import { describe, it, expect } from 'vitest';
import { CATEGORY_ALL, CATEGORY_COLORS, PUZZLE_CATEGORIES } from './categories';

describe('CATEGORY_ALL', () => {
	it('is the string "All"', () => {
		expect(CATEGORY_ALL).toBe('All');
	});
});

describe('CATEGORY_COLORS', () => {
	it('has an entry for every puzzle category', () => {
		for (const category of PUZZLE_CATEGORIES) {
			expect(CATEGORY_COLORS).toHaveProperty(category);
		}
	});

	it('has string values for all categories', () => {
		for (const category of PUZZLE_CATEGORIES) {
			expect(typeof CATEGORY_COLORS[category]).toBe('string');
			expect(CATEGORY_COLORS[category].length).toBeGreaterThan(0);
		}
	});

	it('contains both background and text color classes for Animals', () => {
		expect(CATEGORY_COLORS['Animals']).toContain('bg-');
		expect(CATEGORY_COLORS['Animals']).toContain('text-');
	});

	it('contains both background and text color classes for Nature', () => {
		expect(CATEGORY_COLORS['Nature']).toContain('bg-');
		expect(CATEGORY_COLORS['Nature']).toContain('text-');
	});

	it('contains both background and text color classes for Art', () => {
		expect(CATEGORY_COLORS['Art']).toContain('bg-');
		expect(CATEGORY_COLORS['Art']).toContain('text-');
	});

	it('contains both background and text color classes for Architecture', () => {
		expect(CATEGORY_COLORS['Architecture']).toContain('bg-');
		expect(CATEGORY_COLORS['Architecture']).toContain('text-');
	});

	it('contains both background and text color classes for Abstract', () => {
		expect(CATEGORY_COLORS['Abstract']).toContain('bg-');
		expect(CATEGORY_COLORS['Abstract']).toContain('text-');
	});

	it('contains both background and text color classes for Food', () => {
		expect(CATEGORY_COLORS['Food']).toContain('bg-');
		expect(CATEGORY_COLORS['Food']).toContain('text-');
	});

	it('contains both background and text color classes for Travel', () => {
		expect(CATEGORY_COLORS['Travel']).toContain('bg-');
		expect(CATEGORY_COLORS['Travel']).toContain('text-');
	});

	it('has exactly 7 entries matching PUZZLE_CATEGORIES length', () => {
		expect(Object.keys(CATEGORY_COLORS)).toHaveLength(PUZZLE_CATEGORIES.length);
	});

	it('all entries have distinct color schemes', () => {
		const colors = Object.values(CATEGORY_COLORS);
		const uniqueColors = new Set(colors);
		expect(uniqueColors.size).toBe(colors.length);
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
