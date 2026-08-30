import { describe, expect, it } from 'vitest';
import {
	backingSizeFromLayout,
	canFitOnDoubleTap,
	createBoardTransform,
	screenPointToCanvas,
	transformViewportForTwoPointers
} from './boardViewport';

const FIT_INPUT = {
	canvasWidth: 800,
	canvasHeight: 600,
	gridCols: 2,
	gridRows: 2,
	viewport: null
};

describe('boardViewport', () => {
	it('fits a 2x2 board into 800x600 with paddingFactor 1', () => {
		const transform = createBoardTransform(FIT_INPUT);

		expect(transform.fitCellSize).toBe(300);
		expect(transform.cellSize).toBe(300);
		expect(transform.boardX).toBe(100);
		expect(transform.boardY).toBe(0);
		expect(transform.cellAt(100, 0)).toEqual({ x: 0, y: 0 });
		expect(transform.cellAt(699, 599)).toEqual({ x: 1, y: 1 });
	});

	it('maps screen DIPs into the Canvas backing surface', () => {
		const metrics = {
			layoutWidthDip: 512,
			layoutHeightDip: 384,
			backingWidth: 1024,
			backingHeight: 768
		};
		expect(screenPointToCanvas(356, 242, 100, 50, metrics)).toEqual({ x: 512, y: 384 });
		expect(screenPointToCanvas(100, 50, 0, 0, metrics)).toEqual({ x: 200, y: 100 });
	});

	it('derives backing pixels from layout DIPs and density', () => {
		expect(backingSizeFromLayout(512, 384, 2)).toEqual({ width: 1024, height: 768 });
	});

	it('rejects zero or invalid surface dimensions', () => {
		expect(backingSizeFromLayout(0, 384, 2)).toBeNull();
		expect(backingSizeFromLayout(512, -1, 2)).toBeNull();
		expect(backingSizeFromLayout(512, 384, 0)).toBeNull();
		expect(backingSizeFromLayout(Number.NaN, 384, 2)).toBeNull();
		const metrics = {
			layoutWidthDip: 512,
			layoutHeightDip: 384,
			backingWidth: 1024,
			backingHeight: 768
		};
		expect(screenPointToCanvas(356, 242, 100, 50, { ...metrics, layoutWidthDip: 0 })).toBeNull();
		expect(screenPointToCanvas(356, 242, 100, 50, { ...metrics, backingWidth: 0 })).toBeNull();
		expect(screenPointToCanvas(Number.NaN, 242, 100, 50, metrics)).toBeNull();

		const degenerate = createBoardTransform({ ...FIT_INPUT, canvasWidth: 0 });
		expect(degenerate.fitCellSize).toBe(0);
		expect(degenerate.cellAt(0, 0)).toBeNull();
		expect(
			transformViewportForTwoPointers(
				{ ...FIT_INPUT, canvasWidth: 0 },
				{
					startViewport: null,
					startFocusX: 0,
					startFocusY: 0,
					currentFocusX: 10,
					currentFocusY: 0,
					scale: 2
				}
			)
		).toBeNull();
	});

	it('hits cells through a transformed viewport', () => {
		const transform = createBoardTransform({
			...FIT_INPUT,
			viewport: { zoom: 2, panX: 0, panY: 0 }
		});
		expect(transform.cellSize).toBe(600);
		expect(transform.boardX).toBe(-200);
		expect(transform.boardY).toBe(-300);
		expect(transform.cellAt(-200, -300)).toEqual({ x: 0, y: 0 });
		expect(transform.cellAt(400, 300)).toEqual({ x: 1, y: 1 });
		expect(transform.cellAt(-201, -300)).toBeNull();

		const panned = createBoardTransform({
			...FIT_INPUT,
			viewport: { zoom: 2, panX: 0.5, panY: -1 }
		});
		expect(panned.boardX).toBe(-50);
		expect(panned.boardY).toBe(-600);
		expect(panned.cellAt(-50, -600)).toEqual({ x: 0, y: 0 });
	});

	it('clamps zoom to 1..4 and normalizes Fit to null', () => {
		const zoomed = createBoardTransform({ ...FIT_INPUT, viewport: { zoom: 99, panX: 0, panY: 0 } });
		expect(zoomed.viewport).toEqual({ zoom: 4, panX: 0, panY: 0 });
		expect(zoomed.cellSize).toBe(1200);

		const shrunk = createBoardTransform({
			...FIT_INPUT,
			viewport: { zoom: 0.5, panX: 0, panY: 0 }
		});
		expect(shrunk.viewport).toBeNull();
		expect(shrunk.cellSize).toBe(300);

		const fit = createBoardTransform({ ...FIT_INPUT, viewport: { zoom: 1, panX: 5, panY: -5 } });
		expect(fit.viewport).toBeNull();
		expect(fit.boardX).toBe(100);
	});

	it('clamps pan so the board cannot leave the view and keeps fitting axes centered', () => {
		const clamped = createBoardTransform({
			...FIT_INPUT,
			viewport: { zoom: 2, panX: -9, panY: 9 }
		});
		expect(clamped.viewport?.panX).toBeCloseTo(-2 / 3);
		expect(clamped.viewport?.panY).toBe(1);
		// Geometry must come from the clamped pan, not the raw input:
		// boardX = -200 + (-2/3)*300, boardY = -300 + 1*300.
		expect(clamped.boardX).toBeCloseTo(-400);
		expect(clamped.boardY).toBe(0);
		expect(clamped.cellAt(0, 0)).toEqual({ x: 0, y: 0 });
		// Re-projecting the echoed viewport is a fixed point.
		const roundTripped = createBoardTransform({ ...FIT_INPUT, viewport: clamped.viewport });
		expect(roundTripped.boardX).toBeCloseTo(clamped.boardX);
		expect(roundTripped.boardY).toBe(clamped.boardY);

		// Height overflows at zoom 2, width still fits and stays centered.
		const wide = createBoardTransform({
			canvasWidth: 1200,
			canvasHeight: 600,
			gridCols: 2,
			gridRows: 2,
			viewport: { zoom: 2, panX: 5, panY: 5 }
		});
		expect(wide.viewport).toEqual({ zoom: 2, panX: 0, panY: 1 });
	});

	it('translates with two pointers without zooming', () => {
		const translated = transformViewportForTwoPointers(FIT_INPUT, {
			startViewport: { zoom: 2, panX: 0, panY: 0 },
			startFocusX: 400,
			startFocusY: 300,
			currentFocusX: 550,
			currentFocusY: 300,
			scale: 1
		});
		expect(translated).toEqual({ zoom: 2, panX: 0.5, panY: 0 });

		const overpanned = transformViewportForTwoPointers(FIT_INPUT, {
			startViewport: { zoom: 2, panX: 0, panY: 0 },
			startFocusX: 400,
			startFocusY: 300,
			currentFocusX: 4000,
			currentFocusY: 300,
			scale: 1
		});
		expect(overpanned?.panX).toBeCloseTo(2 / 3);
		expect(overpanned?.panY).toBe(0);
	});

	it('stays at Fit when a Fit gesture does not zoom', () => {
		expect(
			transformViewportForTwoPointers(FIT_INPUT, {
				startViewport: null,
				startFocusX: 400,
				startFocusY: 300,
				currentFocusX: 550,
				currentFocusY: 300,
				scale: 1
			})
		).toBeNull();
	});

	it('keeps the pinch focus anchored', () => {
		const pinched = transformViewportForTwoPointers(FIT_INPUT, {
			startViewport: null,
			startFocusX: 250,
			startFocusY: 300,
			currentFocusX: 250,
			currentFocusY: 300,
			scale: 2
		});
		expect(pinched).toEqual({ zoom: 2, panX: 0.5, panY: 0 });

		const transform = createBoardTransform({ ...FIT_INPUT, viewport: pinched });
		// The board point originally under the focus stays under it.
		expect(transform.boardX).toBe(-50);
		expect(transform.boardX + 0.5 * transform.cellSize).toBe(250);
	});

	it('combines pinch and translation from one start baseline', () => {
		const combined = transformViewportForTwoPointers(FIT_INPUT, {
			startViewport: { zoom: 2, panX: 0, panY: 0 },
			startFocusX: 400,
			startFocusY: 300,
			currentFocusX: 550,
			currentFocusY: 300,
			scale: 2
		});
		expect(combined).toEqual({ zoom: 4, panX: 0.5, panY: 0 });

		const transform = createBoardTransform({ ...FIT_INPUT, viewport: combined });
		// Content cell under the start focus (400,300) at zoom 2 was cell (1, 1).
		expect(transform.cellAt(550, 300)).toEqual({ x: 1, y: 1 });
	});

	it('clamps an out-of-range start pan before anchoring the pinch', () => {
		// Viewport persisted on a larger surface: panX 9 was within the old
		// limit but exceeds the 800x600 limit at zoom 2 (max 2/3). The rendered
		// board clamps panX to 2/3 (boardX 0); the pinch baseline must match,
		// or the first zoom frame jumps the content under the focus.
		const rendered = createBoardTransform({
			...FIT_INPUT,
			viewport: { zoom: 2, panX: 9, panY: 0 }
		});
		expect(rendered.viewport?.panX).toBeCloseTo(2 / 3);
		expect(rendered.boardX).toBe(0);

		const pinched = transformViewportForTwoPointers(FIT_INPUT, {
			startViewport: { zoom: 2, panX: 9, panY: 0 },
			startFocusX: 400,
			startFocusY: 300,
			currentFocusX: 400,
			currentFocusY: 300,
			scale: 2
		});
		// With the baseline clamped, the content under the focus (offset 400
		// from boardX 0) stays under the focus: panX 4/3, not the 2/3 that
		// results from anchoring to the unclamped board origin.
		expect(pinched).toEqual({ zoom: 4, panX: 4 / 3, panY: 0 });

		const transform = createBoardTransform({ ...FIT_INPUT, viewport: pinched });
		// The content point originally under the focus (board-offset 400 at
		// start zoom 2) scales to offset 800 at zoom 4 and stays under the
		// focus: boardX -400 + 800 = 400.
		expect(transform.boardX).toBe(-400);
		expect(transform.boardX + 400 * (4 / 2)).toBe(400);
	});

	describe('canFitOnDoubleTap', () => {
		it('allows Fit when unselected and outside the suppression window', () => {
			expect(canFitOnDoubleTap(null, 1000, 500)).toBe(true);
		});

		it('blocks Fit while a piece is selected', () => {
			expect(canFitOnDoubleTap(7, 1000, 500)).toBe(false);
		});

		it('blocks Fit inside the suppression window and at the exact boundary allows it again', () => {
			expect(canFitOnDoubleTap(null, 1000, 1500)).toBe(false);
			expect(canFitOnDoubleTap(null, 1500, 1500)).toBe(true);
		});
	});
});
