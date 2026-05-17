import { describe, expect, it } from 'vitest';
import { getPuzzleBoardViewportTier, getResponsivePuzzleBoardMetrics } from './puzzleLayout';

const portraitPuzzle = {
	imageWidth: 150,
	imageHeight: 200,
	gridCols: 6,
	gridRows: 8
};

const mismatchedPuzzle = {
	// 4:3 image (2000x1500) with a square grid (15x15)
	imageWidth: 2000,
	imageHeight: 1500,
	gridCols: 15,
	gridRows: 15
};

describe('puzzle layout', () => {
	it('classifies viewport width into board size tiers', () => {
		expect(getPuzzleBoardViewportTier(390)).toBe('small');
		expect(getPuzzleBoardViewportTier(800)).toBe('medium');
		expect(getPuzzleBoardViewportTier(1280)).toBe('large');
		expect(getPuzzleBoardViewportTier(1600)).toBe('extra-large');
	});

	it('sizes the board from the viewport tier instead of source image pixels', () => {
		const small = getResponsivePuzzleBoardMetrics(portraitPuzzle, {
			width: 390,
			height: 844
		});
		const medium = getResponsivePuzzleBoardMetrics(portraitPuzzle, {
			width: 800,
			height: 900
		});
		const large = getResponsivePuzzleBoardMetrics(portraitPuzzle, {
			width: 1280,
			height: 900
		});
		const extraLarge = getResponsivePuzzleBoardMetrics(portraitPuzzle, {
			width: 1600,
			height: 1000
		});

		expect(small.boardWidth).toBeGreaterThan(portraitPuzzle.imageWidth);
		expect(medium.boardWidth).toBeGreaterThan(small.boardWidth);
		expect(large.boardWidth).toBeGreaterThan(medium.boardWidth);
		expect(extraLarge.boardWidth).toBeGreaterThan(large.boardWidth);
	});

	it('keeps board cells square when image aspect matches grid aspect', () => {
		const metrics = getResponsivePuzzleBoardMetrics(portraitPuzzle, {
			width: 1280,
			height: 900
		});

		expect(metrics.boardWidth).toBeCloseTo(metrics.cellSize * portraitPuzzle.gridCols);
		expect(metrics.boardHeight).toBeCloseTo(metrics.cellSize * portraitPuzzle.gridRows);
		expect(metrics.pieceSlotSize).toBeCloseTo(metrics.cellSize);
	});

	it('preserves image-derived aspect ratio for mismatched image/grid', () => {
		const metrics = getResponsivePuzzleBoardMetrics(mismatchedPuzzle, {
			width: 1600,
			height: 1000
		});

		const expectedAspect = mismatchedPuzzle.imageWidth / mismatchedPuzzle.imageHeight;
		const actualAspect = metrics.boardWidth / metrics.boardHeight;

		expect(actualAspect).toBeCloseTo(expectedAspect, 1);
		// Board height should NOT be equal to board width for a non-square image
		expect(metrics.boardHeight).not.toBeCloseTo(metrics.boardWidth);
	});
});
