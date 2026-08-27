import { describe, it, expect } from 'vitest';
import {
	getGridDimensions,
	getTopEdge,
	getRightEdge,
	getBottomEdge,
	getLeftEdge,
	getGridDimensionsForAspectRatio,
	getAllowedPieceCountsForAspectRatio,
	isValidPieceCountForAspectRatio,
	isPuzzleAspectRatio,
	aspectRatiosMatch,
	ASPECT_RATIO_TOLERANCE,
	PUZZLE_DIFFICULTIES,
	DIFFICULTY_PIECE_COUNTS,
	getDifficultyPieceCount,
	type PuzzleAspectRatio,
	type PuzzleDifficulty
} from './grid';

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

describe('aspect-ratio grid helpers', () => {
	it('returns square grids for 1:1 counts', () => {
		expect(getGridDimensionsForAspectRatio(225, '1:1')).toEqual({ rows: 15, cols: 15 });
		expect(getGridDimensionsForAspectRatio(16, '1:1')).toEqual({ rows: 4, cols: 4 });
	});

	it('returns landscape and portrait grids with square-cell ratios', () => {
		expect(getGridDimensionsForAspectRatio(48, '4:3')).toEqual({ rows: 6, cols: 8 });
		expect(getGridDimensionsForAspectRatio(48, '3:4')).toEqual({ rows: 8, cols: 6 });
		expect(getGridDimensionsForAspectRatio(192, '4:3')).toEqual({ rows: 12, cols: 16 });
		expect(getGridDimensionsForAspectRatio(192, '3:4')).toEqual({ rows: 16, cols: 12 });
	});

	it('rejects counts that do not match the selected aspect-ratio formula', () => {
		expect(isValidPieceCountForAspectRatio(24, '1:1')).toBe(false);
		expect(isValidPieceCountForAspectRatio(24, '4:3')).toBe(false);
		expect(isValidPieceCountForAspectRatio(25, '4:3')).toBe(false);
		expect(getGridDimensionsForAspectRatio(24, '3:4')).toEqual({ rows: 0, cols: 0 });
	});

	it('lists allowed counts within a bounded range', () => {
		expect(getAllowedPieceCountsForAspectRatio('1:1', 4, 100)).toEqual([
			4, 9, 16, 25, 36, 49, 64, 81, 100
		]);
		expect(getAllowedPieceCountsForAspectRatio('4:3', 4, 250)).toEqual([12, 48, 108, 192]);
		expect(getAllowedPieceCountsForAspectRatio('3:4', 4, 100)).toEqual([12, 48]);
	});

	it('recognizes supported puzzle aspect ratios', () => {
		expect(isPuzzleAspectRatio('1:1')).toBe(true);
		expect(isPuzzleAspectRatio('4:3')).toBe(true);
		expect(isPuzzleAspectRatio('3:4')).toBe(true);
		expect(isPuzzleAspectRatio('16:9')).toBe(false);
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

describe('difficulty piece counts', () => {
	const expectedGrids: Record<
		PuzzleDifficulty,
		Record<PuzzleAspectRatio, { count: number; rows: number; cols: number }>
	> = {
		easy: {
			'1:1': { count: 16, rows: 4, cols: 4 },
			'4:3': { count: 12, rows: 3, cols: 4 },
			'3:4': { count: 12, rows: 4, cols: 3 }
		},
		normal: {
			'1:1': { count: 49, rows: 7, cols: 7 },
			'4:3': { count: 48, rows: 6, cols: 8 },
			'3:4': { count: 48, rows: 8, cols: 6 }
		},
		hard: {
			'1:1': { count: 100, rows: 10, cols: 10 },
			'4:3': { count: 108, rows: 9, cols: 12 },
			'3:4': { count: 108, rows: 12, cols: 9 }
		}
	};

	it('exposes the fixed difficulty catalog', () => {
		expect(PUZZLE_DIFFICULTIES).toEqual(['easy', 'normal', 'hard']);
		expect(DIFFICULTY_PIECE_COUNTS).toEqual({
			easy: { '1:1': 16, '4:3': 12, '3:4': 12 },
			normal: { '1:1': 49, '4:3': 48, '3:4': 48 },
			hard: { '1:1': 100, '4:3': 108, '3:4': 108 }
		});
	});

	it('matches the design-spec rows×cols grid for every difficulty and aspect ratio', () => {
		expect(getDifficultyPieceCount('4:3', 'easy')).toBe(12);
		expect(getGridDimensionsForAspectRatio(12, '4:3')).toEqual({ rows: 3, cols: 4 });
		expect(getDifficultyPieceCount('3:4', 'hard')).toBe(108);
		expect(getGridDimensionsForAspectRatio(108, '3:4')).toEqual({ rows: 12, cols: 9 });

		for (const difficulty of PUZZLE_DIFFICULTIES) {
			for (const aspectRatio of ['1:1', '4:3', '3:4'] as const) {
				const { count, rows, cols } = expectedGrids[difficulty][aspectRatio];
				expect(getDifficultyPieceCount(aspectRatio, difficulty)).toBe(count);
				expect(getGridDimensionsForAspectRatio(count, aspectRatio)).toEqual({ rows, cols });
				expect(isValidPieceCountForAspectRatio(count, aspectRatio)).toBe(true);
			}
		}
	});
});

describe('aspectRatiosMatch', () => {
	it('matches exact 1:1 dimensions', () => {
		expect(aspectRatiosMatch(100, 100, '1:1')).toBe(true);
		expect(aspectRatiosMatch(1024, 1024, '1:1')).toBe(true);
	});

	it('matches exact 4:3 dimensions', () => {
		expect(aspectRatiosMatch(400, 300, '4:3')).toBe(true);
		expect(aspectRatiosMatch(800, 600, '4:3')).toBe(true);
	});

	it('matches exact 3:4 dimensions', () => {
		expect(aspectRatiosMatch(300, 400, '3:4')).toBe(true);
		expect(aspectRatiosMatch(600, 800, '3:4')).toBe(true);
	});

	it('matches within the 5% tolerance (normalized rounding)', () => {
		// 4:3 at 300px wide → 400px tall is exact; 399px is within 5% tolerance
		expect(aspectRatiosMatch(300, 399, '3:4')).toBe(true);
		// 1:1 with slight rounding: 100x102 → actual 0.980, expected 1.0, diff 2% < 5%
		expect(aspectRatiosMatch(100, 102, '1:1')).toBe(true);
	});

	it('rejects ratios outside the tolerance', () => {
		// 16:9 image (1.778) vs 4:3 target (1.333): diff ~33% > 5%
		expect(aspectRatiosMatch(1920, 1080, '4:3')).toBe(false);
		// 1:1 target with a clearly non-square image
		expect(aspectRatiosMatch(200, 100, '1:1')).toBe(false);
		// 4:3 target given a 3:4 image (inverted)
		expect(aspectRatiosMatch(300, 400, '4:3')).toBe(false);
	});

	it('rejects at exactly the tolerance boundary on the wrong side', () => {
		// Build a width/height whose ratio diverges just over ASPECT_RATIO_TOLERANCE.
		// For 1:1 (expected=1), a 6% height shortfall exceeds the 5% tolerance.
		const expected = 1;
		const actual = 100 / 106; // ~0.9434, |1 - 0.9434|/1 = 0.0566 > 0.05
		expect(Math.abs(actual - expected) / expected).toBeGreaterThan(ASPECT_RATIO_TOLERANCE);
		expect(aspectRatiosMatch(100, 106, '1:1')).toBe(false);
	});

	it('handles portrait vs landscape correctly for 4:3 vs 3:4', () => {
		// Same pixel counts, different orientation — must not cross-match
		expect(aspectRatiosMatch(400, 300, '4:3')).toBe(true);
		expect(aspectRatiosMatch(400, 300, '3:4')).toBe(false);
		expect(aspectRatiosMatch(300, 400, '3:4')).toBe(true);
		expect(aspectRatiosMatch(300, 400, '4:3')).toBe(false);
	});

	it('rejects zero or negative dimensions', () => {
		expect(aspectRatiosMatch(0, 100, '1:1')).toBe(false);
		expect(aspectRatiosMatch(100, 0, '1:1')).toBe(false);
		expect(aspectRatiosMatch(0, 0, '1:1')).toBe(false);
		expect(aspectRatiosMatch(-100, 100, '1:1')).toBe(false);
		expect(aspectRatiosMatch(100, -100, '1:1')).toBe(false);
	});
});
