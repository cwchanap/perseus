import { describe, expect, it } from 'vitest';
import { getPuzzleBoardViewportTier, getResponsivePuzzleBoardMetrics } from './puzzleLayout';

const portraitPuzzle = {
	imageWidth: 150,
	imageHeight: 200,
	gridCols: 6,
	gridRows: 8
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

	it('keeps board cells square and makes tray slots match board cells', () => {
		const metrics = getResponsivePuzzleBoardMetrics(portraitPuzzle, {
			width: 1280,
			height: 900
		});

		expect(metrics.boardWidth).toBeCloseTo(metrics.cellSize * portraitPuzzle.gridCols);
		expect(metrics.boardHeight).toBeCloseTo(metrics.cellSize * portraitPuzzle.gridRows);
		expect(metrics.pieceSlotSize).toBeCloseTo(metrics.cellSize);
	});
});
