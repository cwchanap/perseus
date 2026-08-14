import { describe, expect, it } from 'vitest';
import { matchesInventoryFilter } from './inventory';

const GRID_4X3 = { gridCols: 4, gridRows: 3 };

function matchingFilters(
	correctX: number,
	correctY: number,
	grid: { gridCols: number; gridRows: number }
) {
	return (['corners', 'edges', 'center'] as const).filter((filter) =>
		matchesInventoryFilter({ correctX, correctY }, grid, filter)
	);
}

describe('matchesInventoryFilter', () => {
	it('classifies a non-square perimeter into mutually exclusive corners, edges, and center', () => {
		expect(matchingFilters(0, 0, GRID_4X3)).toEqual(['corners']);
		expect(matchingFilters(3, 2, GRID_4X3)).toEqual(['corners']);
		expect(matchingFilters(1, 0, GRID_4X3)).toEqual(['edges']);
		expect(matchingFilters(0, 1, GRID_4X3)).toEqual(['edges']);
		expect(matchingFilters(1, 1, GRID_4X3)).toEqual(['center']);
	});

	it('treats 1x1 as a corner', () => {
		expect(matchingFilters(0, 0, { gridCols: 1, gridRows: 1 })).toEqual(['corners']);
	});

	it('treats one-dimensional endpoints as corners and interior cells as edges', () => {
		const vertical = { gridCols: 1, gridRows: 4 };
		expect(matchingFilters(0, 0, vertical)).toEqual(['corners']);
		expect(matchingFilters(0, 1, vertical)).toEqual(['edges']);
		expect(matchingFilters(0, 3, vertical)).toEqual(['corners']);

		const horizontal = { gridCols: 4, gridRows: 1 };
		expect(matchingFilters(0, 0, horizontal)).toEqual(['corners']);
		expect(matchingFilters(2, 0, horizontal)).toEqual(['edges']);
		expect(matchingFilters(3, 0, horizontal)).toEqual(['corners']);
	});

	it('matches every piece for All', () => {
		expect(matchesInventoryFilter({ correctX: 1, correctY: 1 }, GRID_4X3, 'all')).toBe(true);
	});
});
