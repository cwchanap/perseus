import { describe, it, expect } from 'vitest';
import { getGridDimensions, getTopEdge, getRightEdge, getBottomEdge, getLeftEdge } from './grid';

describe('getGridDimensions', () => {
	it('returns balanced grid for square piece counts', () => {
		expect(getGridDimensions(225)).toEqual({ rows: 15, cols: 15 });
		expect(getGridDimensions(100)).toEqual({ rows: 10, cols: 10 });
		expect(getGridDimensions(4)).toEqual({ rows: 2, cols: 2 });
	});

	it('returns largest factor <= sqrt for non-square counts', () => {
		expect(getGridDimensions(24)).toEqual({ rows: 4, cols: 6 });
		expect(getGridDimensions(48)).toEqual({ rows: 6, cols: 8 });
		expect(getGridDimensions(96)).toEqual({ rows: 8, cols: 12 });
	});

	it('returns {1, n} for primes', () => {
		expect(getGridDimensions(7)).toEqual({ rows: 1, cols: 7 });
		expect(getGridDimensions(13)).toEqual({ rows: 1, cols: 13 });
	});

	it('returns {0, 0} for zero or negative counts', () => {
		expect(getGridDimensions(0)).toEqual({ rows: 0, cols: 0 });
		expect(getGridDimensions(-5)).toEqual({ rows: 0, cols: 0 });
	});
});

describe('edge helpers', () => {
	it('outermost edges are flat', () => {
		const rows = 3;
		const cols = 3;
		expect(getTopEdge(0, 0, rows)).toBe('flat');
		expect(getTopEdge(0, 2, rows)).toBe('flat');
		expect(getRightEdge(0, cols - 1, cols)).toBe('flat');
		expect(getRightEdge(2, cols - 1, cols)).toBe('flat');
		expect(getBottomEdge(rows - 1, 0, rows)).toBe('flat');
		expect(getBottomEdge(rows - 1, 2, rows)).toBe('flat');
		expect(getLeftEdge(0, 0, cols)).toBe('flat');
		expect(getLeftEdge(2, 0, cols)).toBe('flat');
	});

	it('adjacent pieces have matching opposite edges (horizontal)', () => {
		// Right edge of (row, col) opposes left edge of (row, col+1)
		const rows = 4;
		const cols = 4;
		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols - 1; col++) {
				const right = getRightEdge(row, col, cols);
				const leftOfNext = getLeftEdge(row, col + 1, cols);
				if (right === 'tab') expect(leftOfNext).toBe('blank');
				else if (right === 'blank') expect(leftOfNext).toBe('tab');
				else expect(leftOfNext).toBe('flat');
			}
		}
	});

	it('adjacent pieces have matching opposite edges (vertical)', () => {
		const rows = 4;
		const cols = 4;
		for (let row = 0; row < rows - 1; row++) {
			for (let col = 0; col < cols; col++) {
				const bottom = getBottomEdge(row, col, rows);
				const topOfNext = getTopEdge(row + 1, col, rows);
				if (bottom === 'tab') expect(topOfNext).toBe('blank');
				else if (bottom === 'blank') expect(topOfNext).toBe('tab');
				else expect(topOfNext).toBe('flat');
			}
		}
	});
});
