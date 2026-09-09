import { describe, expect, it } from 'vitest';
import {
	DESKTOP_TRAY_BASE_WIDTH,
	DESKTOP_BOARD_MIN_WIDTH,
	DESKTOP_TRAY_SEPARATOR_WIDTH,
	clampTrayWidth,
	getDefaultPuzzleTrayWidth,
	GAMEPLAY_RAIL_WIDTH,
	getPuzzleBoardViewportTier,
	getResponsivePuzzleBoardMetrics,
	MOBILE_GAMEPLAY_GAP
} from './puzzleLayout';

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
		const small = getResponsivePuzzleBoardMetrics(
			portraitPuzzle,
			{
				width: 390,
				height: 844
			},
			DESKTOP_TRAY_BASE_WIDTH
		);
		const medium = getResponsivePuzzleBoardMetrics(
			portraitPuzzle,
			{
				width: 800,
				height: 900
			},
			DESKTOP_TRAY_BASE_WIDTH
		);
		const large = getResponsivePuzzleBoardMetrics(
			portraitPuzzle,
			{
				width: 1280,
				height: 900
			},
			DESKTOP_TRAY_BASE_WIDTH
		);
		const extraLarge = getResponsivePuzzleBoardMetrics(
			portraitPuzzle,
			{
				width: 1600,
				height: 1000
			},
			DESKTOP_TRAY_BASE_WIDTH
		);

		expect(small.boardWidth).toBeGreaterThan(portraitPuzzle.imageWidth);
		expect(medium.boardWidth).toBeGreaterThan(small.boardWidth);
		expect(large.boardWidth).toBeGreaterThan(medium.boardWidth);
		expect(extraLarge.boardWidth).toBeGreaterThan(large.boardWidth);
	});

	it('keeps board cells square when image aspect matches grid aspect', () => {
		const metrics = getResponsivePuzzleBoardMetrics(
			portraitPuzzle,
			{
				width: 1280,
				height: 900
			},
			DESKTOP_TRAY_BASE_WIDTH
		);

		expect(metrics.boardWidth).toBeCloseTo(metrics.cellSize * portraitPuzzle.gridCols);
		expect(metrics.boardHeight).toBeCloseTo(metrics.cellSize * portraitPuzzle.gridRows);
		expect(metrics.pieceSlotSize).toBeCloseTo(metrics.cellSize);
	});

	it('keeps small square and landscape metrics within the mobile board column', () => {
		const mobileLayoutWidth = 390;
		const boardColumnWidth = mobileLayoutWidth - GAMEPLAY_RAIL_WIDTH.small - MOBILE_GAMEPLAY_GAP;
		const puzzles = [
			{ imageWidth: 1200, imageHeight: 1200, gridCols: 4, gridRows: 4 },
			{ imageWidth: 1600, imageHeight: 1200, gridCols: 4, gridRows: 3 }
		];

		for (const puzzle of puzzles) {
			const metrics = getResponsivePuzzleBoardMetrics(
				puzzle,
				{ width: 390, height: 844 },
				DESKTOP_TRAY_BASE_WIDTH
			);

			expect(metrics.boardWidth).toBeLessThanOrEqual(boardColumnWidth);
		}
	});

	it('preserves image-derived aspect ratio for mismatched image/grid', () => {
		const metrics = getResponsivePuzzleBoardMetrics(
			mismatchedPuzzle,
			{
				width: 1600,
				height: 1000
			},
			DESKTOP_TRAY_BASE_WIDTH
		);

		const expectedAspect = mismatchedPuzzle.imageWidth / mismatchedPuzzle.imageHeight;
		const actualAspect = metrics.boardWidth / metrics.boardHeight;

		expect(actualAspect).toBeCloseTo(expectedAspect, 1);
		// Board height should NOT be equal to board width for a non-square image
		expect(metrics.boardHeight).not.toBeCloseTo(metrics.boardWidth);
	});

	it('widens dense desktop trays beyond the old 17.5rem minimum', () => {
		const dense = {
			imageWidth: 1500,
			imageHeight: 1500,
			gridCols: 15,
			gridRows: 15
		};

		expect(getDefaultPuzzleTrayWidth(dense, { width: 1280, height: 900 })).toBe(300);
	});

	it('does not narrow a coarse three-column tray to 360px', () => {
		const coarse = {
			imageWidth: 1200,
			imageHeight: 900,
			gridCols: 4,
			gridRows: 3
		};

		// Preferred board width is 720, so preferred cell is 180.
		// Existing tray chrome is 42px: 3 * 180 + 42 = 582.
		expect(getDefaultPuzzleTrayWidth(coarse, { width: 1280, height: 900 })).toBe(582);
	});

	it('uses the tiered docked tray base for a portrait puzzle', () => {
		expect(getDefaultPuzzleTrayWidth(portraitPuzzle, { width: 1080, height: 810 })).toBe(300);
		expect(getDefaultPuzzleTrayWidth(portraitPuzzle, { width: 1440, height: 900 })).toBe(352);
	});

	it('clamps the requested tray against board and tray minimums', () => {
		expect(clampTrayWidth(1000, 200)).toBe(300);
		expect(clampTrayWidth(1000, 700)).toBe(500);
		expect(clampTrayWidth(760, 360)).toBe(300);
	});

	it('reserves the gameplay rail when clamping desktop tray width', () => {
		const layoutWidth = 1408;
		const railWidth = GAMEPLAY_RAIL_WIDTH['extra-large'];
		const tray = clampTrayWidth(layoutWidth, 1000, railWidth);

		expect(layoutWidth - railWidth - tray - DESKTOP_TRAY_SEPARATOR_WIDTH).toBeGreaterThanOrEqual(
			DESKTOP_BOARD_MIN_WIDTH
		);
	});

	it('reserves the tablet rail when clamping the 1080 layout', () => {
		const layoutWidth = 1080;
		const railWidth = GAMEPLAY_RAIL_WIDTH.large;
		const tray = clampTrayWidth(layoutWidth, 1000, railWidth);

		expect(layoutWidth - railWidth - tray - DESKTOP_TRAY_SEPARATOR_WIDTH).toBeGreaterThanOrEqual(
			DESKTOP_BOARD_MIN_WIDTH
		);
	});

	it('reduces board width when the applied desktop tray is wider', () => {
		const puzzle = {
			imageWidth: 1200,
			imageHeight: 900,
			gridCols: 4,
			gridRows: 3
		};
		const viewport = { width: 1280, height: 900 };

		const narrowTray = getResponsivePuzzleBoardMetrics(puzzle, viewport, 360);
		const wideTray = getResponsivePuzzleBoardMetrics(puzzle, viewport, 580);

		expect(wideTray.boardWidth).toBeLessThan(narrowTray.boardWidth);
	});

	it('caps the desktop board to the measured layout width so it fits the board viewport', () => {
		// A coarse 4x3 puzzle on a wide desktop. The outer viewport (1920)
		// is wider than the .game-layout box, which CSS caps at 96rem (1536).
		// With a widened tray the board column is much narrower than the
		// outer viewport, so capping from window.innerWidth would request a
		// board wider than the actual .board-viewport and force fit zoom < 1.
		const coarsePuzzle = {
			imageWidth: 1600,
			imageHeight: 1200,
			gridCols: 4,
			gridRows: 3
		};
		const outerViewport = { width: 1920, height: 1000 };
		const layoutWidth = 1536;
		const trayWidth = 720;
		const railWidth = GAMEPLAY_RAIL_WIDTH['extra-large'];

		// Without the measured layout width (prior behavior), the desktop cap
		// is derived from the outer viewport and the board overflows the board
		// column: boardWidth + tray + separator exceeds the layout box.
		const uncapped = getResponsivePuzzleBoardMetrics(coarsePuzzle, outerViewport, trayWidth);
		expect(
			uncapped.boardWidth + trayWidth + DESKTOP_TRAY_SEPARATOR_WIDTH + railWidth
		).toBeGreaterThan(layoutWidth);

		// With the measured layout width, the board fits inside the board
		// column (layout - tray - separator), so getFitZoom() stays at 1.
		const capped = getResponsivePuzzleBoardMetrics(
			coarsePuzzle,
			outerViewport,
			trayWidth,
			layoutWidth
		);
		expect(
			capped.boardWidth + trayWidth + DESKTOP_TRAY_SEPARATOR_WIDTH + railWidth
		).toBeLessThanOrEqual(layoutWidth);
		expect(capped.boardWidth).toBeLessThan(uncapped.boardWidth);
	});
});
