// Single source of board geometry for the mobile Canvas: fit/zoom/pan math,
// canonical cell hit-testing, and DIP <-> backing-surface conversion. The
// portable fit formula lives in @perseus/game-core; only app-side clamping
// and projection live here.
import { calculateFitZoom, type PersistedViewport } from '@perseus/game-core';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export interface CanvasSurfaceMetrics {
	layoutWidthDip: number;
	layoutHeightDip: number;
	backingWidth: number;
	backingHeight: number;
}

export interface BoardViewportInput {
	canvasWidth: number;
	canvasHeight: number;
	gridCols: number;
	gridRows: number;
	viewport: PersistedViewport | null;
}

export interface BoardTransform {
	fitCellSize: number;
	cellSize: number;
	boardX: number;
	boardY: number;
	boardWidth: number;
	boardHeight: number;
	viewport: PersistedViewport | null;
	cellAt(canvasX: number, canvasY: number): { x: number; y: number } | null;
}

export interface TwoPointerTransformInput {
	startViewport: PersistedViewport | null;
	startFocusX: number;
	startFocusY: number;
	currentFocusX: number;
	currentFocusY: number;
	scale: number;
}

function isFinitePositive(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function clampZoom(zoom: number): number {
	return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/**
 * Normalizes a persisted viewport: clamps zoom to the UI range 1..4 and
 * collapses zoom 1 (or invalid input) to Fit with zero pan.
 */
function normalizeViewport(viewport: PersistedViewport | null): PersistedViewport | null {
	if (!viewport) return null;
	const rawZoom = viewport.zoom;
	if (!Number.isFinite(rawZoom) || rawZoom <= 0) return null;
	const zoom = clampZoom(rawZoom);
	if (zoom === MIN_ZOOM) return null;
	return {
		zoom,
		panX: Number.isFinite(viewport.panX) ? viewport.panX : 0,
		panY: Number.isFinite(viewport.panY) ? viewport.panY : 0
	};
}

/** Converts layout DIPs and screen density into Canvas backing pixels. */
export function backingSizeFromLayout(
	widthDip: number,
	heightDip: number,
	density: number
): { width: number; height: number } | null {
	if (!isFinitePositive(widthDip) || !isFinitePositive(heightDip) || !isFinitePositive(density)) {
		return null;
	}
	return { width: widthDip * density, height: heightDip * density };
}

export interface NextSurfaceMetrics {
	metrics: CanvasSurfaceMetrics;
	backingChanged: boolean;
}

export function nextSurfaceMetrics(
	layoutWidthDip: number,
	layoutHeightDip: number,
	density: number,
	previous: CanvasSurfaceMetrics | null
): NextSurfaceMetrics | null {
	const backing = backingSizeFromLayout(layoutWidthDip, layoutHeightDip, density);
	if (!backing) return null;

	const metrics: CanvasSurfaceMetrics = {
		layoutWidthDip,
		layoutHeightDip,
		backingWidth: Math.round(backing.width),
		backingHeight: Math.round(backing.height)
	};

	return {
		metrics,
		backingChanged:
			previous !== null &&
			(previous.backingWidth !== metrics.backingWidth ||
				previous.backingHeight !== metrics.backingHeight)
	};
}

/**
 * Maps a screen point (DIPs) into Canvas backing coordinates through the
 * actual backing/layout ratios of the rendered surface.
 */
export function screenPointToCanvas(
	screenX: number,
	screenY: number,
	originXDip: number,
	originYDip: number,
	metrics: CanvasSurfaceMetrics
): { x: number; y: number } | null {
	if (
		!isFinitePositive(metrics.layoutWidthDip) ||
		!isFinitePositive(metrics.layoutHeightDip) ||
		!isFinitePositive(metrics.backingWidth) ||
		!isFinitePositive(metrics.backingHeight) ||
		![screenX, screenY, originXDip, originYDip].every(Number.isFinite)
	) {
		return null;
	}
	return {
		x: ((screenX - originXDip) * metrics.backingWidth) / metrics.layoutWidthDip,
		y: ((screenY - originYDip) * metrics.backingHeight) / metrics.layoutHeightDip
	};
}

/** Clamps a persisted pan (fit-cell units) so the board stays partly in view. */
function clampPan(
	pan: number,
	scaledSize: number,
	canvasSize: number,
	fitCellSize: number
): number {
	const maxFitCells = Math.max(0, (scaledSize - canvasSize) / 2) / fitCellSize;
	return Math.max(-maxFitCells, Math.min(maxFitCells, pan));
}

/** Centers a board of the given size and offsets it by the pan (fit-cell units). */
function projectBoardOrigin(
	canvasSize: number,
	boardSize: number,
	panFitCells: number,
	fitCellSize: number
): number {
	return (canvasSize - boardSize) / 2 + panFitCells * fitCellSize;
}

export function createBoardTransform(input: BoardViewportInput): BoardTransform {
	const fitCellSize = calculateFitZoom(
		input.gridCols,
		input.gridRows,
		input.canvasWidth,
		input.canvasHeight,
		1
	);
	const viewport = normalizeViewport(input.viewport);
	const zoom = viewport?.zoom ?? MIN_ZOOM;
	const cellSize = fitCellSize * zoom;
	const boardWidth = cellSize * input.gridCols;
	const boardHeight = cellSize * input.gridRows;
	// Persisted pan is in fit-cell units: one unit moves the board one
	// fit-scale cell, independent of zoom. Clamp once so the projection and
	// the echoed viewport always agree.
	const panX =
		viewport && fitCellSize > 0
			? clampPan(viewport.panX, boardWidth, input.canvasWidth, fitCellSize)
			: 0;
	const panY =
		viewport && fitCellSize > 0
			? clampPan(viewport.panY, boardHeight, input.canvasHeight, fitCellSize)
			: 0;
	const boardX = projectBoardOrigin(input.canvasWidth, boardWidth, panX, fitCellSize);
	const boardY = projectBoardOrigin(input.canvasHeight, boardHeight, panY, fitCellSize);

	function cellAt(canvasX: number, canvasY: number): { x: number; y: number } | null {
		if (
			cellSize <= 0 ||
			!Number.isFinite(canvasX) ||
			!Number.isFinite(canvasY) ||
			canvasX < boardX ||
			canvasY < boardY ||
			canvasX >= boardX + boardWidth ||
			canvasY >= boardY + boardHeight
		) {
			return null;
		}
		return {
			x: Math.floor((canvasX - boardX) / cellSize),
			y: Math.floor((canvasY - boardY) / cellSize)
		};
	}

	return {
		fitCellSize,
		cellSize,
		boardX,
		boardY,
		boardWidth,
		boardHeight,
		viewport: viewport && fitCellSize > 0 ? { zoom, panX, panY } : null,
		cellAt
	};
}

/**
 * True when a double tap may fit the board: no piece is selected (a selected
 * piece hands the gesture to More -> Fit Board) and any placement tap's
 * suppression window has expired.
 */
export function canFitOnDoubleTap(
	selectedPieceId: number | null,
	nowMs: number,
	suppressFitUntilMs: number
): boolean {
	return selectedPieceId === null && nowMs >= suppressFitUntilMs;
}

export function transformViewportForTwoPointers(
	board: BoardViewportInput,
	gesture: TwoPointerTransformInput
): PersistedViewport | null {
	const fitCellSize = calculateFitZoom(
		board.gridCols,
		board.gridRows,
		board.canvasWidth,
		board.canvasHeight,
		1
	);
	if (
		fitCellSize <= 0 ||
		![
			gesture.startFocusX,
			gesture.startFocusY,
			gesture.currentFocusX,
			gesture.currentFocusY,
			gesture.scale
		].every(Number.isFinite)
	) {
		return null;
	}
	const start = normalizeViewport(gesture.startViewport);
	const startZoom = start?.zoom ?? MIN_ZOOM;
	const zoom = clampZoom(startZoom * gesture.scale);
	if (zoom === MIN_ZOOM) return null;

	// Anchor the board content point under the start focus so it stays under
	// the moving focus at the new zoom (focal pinch); focus movement then
	// translates the board one-to-one.
	const boardWidth = board.gridCols * fitCellSize * zoom;
	const boardHeight = board.gridRows * fitCellSize * zoom;
	// Clamp the start pan with the start-scale board dimensions, matching
	// createBoardTransform's rendered-viewport clamping. Without this, a
	// viewport persisted on a larger surface (pan within the old limit but
	// beyond the current one after relayout) anchors the pinch to a board
	// origin that does not match what is drawn, and the first zoom frame
	// jumps the content under the focus.
	const startBoardWidth = board.gridCols * fitCellSize * startZoom;
	const startBoardHeight = board.gridRows * fitCellSize * startZoom;
	const startPanX = clampPan(start?.panX ?? 0, startBoardWidth, board.canvasWidth, fitCellSize);
	const startPanY = clampPan(start?.panY ?? 0, startBoardHeight, board.canvasHeight, fitCellSize);
	const startBoardX = projectBoardOrigin(
		board.canvasWidth,
		startBoardWidth,
		startPanX,
		fitCellSize
	);
	const startBoardY = projectBoardOrigin(
		board.canvasHeight,
		startBoardHeight,
		startPanY,
		fitCellSize
	);
	const anchorX = (gesture.startFocusX - startBoardX) * (zoom / startZoom);
	const anchorY = (gesture.startFocusY - startBoardY) * (zoom / startZoom);
	const boardX = gesture.currentFocusX - anchorX;
	const boardY = gesture.currentFocusY - anchorY;

	return {
		zoom,
		panX: clampPan(
			(boardX - projectBoardOrigin(board.canvasWidth, boardWidth, 0, fitCellSize)) / fitCellSize,
			boardWidth,
			board.canvasWidth,
			fitCellSize
		),
		panY: clampPan(
			(boardY - projectBoardOrigin(board.canvasHeight, boardHeight, 0, fitCellSize)) / fitCellSize,
			boardHeight,
			board.canvasHeight,
			fitCellSize
		)
	};
}
