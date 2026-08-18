export type PuzzleBoardViewportTier = 'small' | 'medium' | 'large' | 'extra-large';

export interface PuzzleBoardSource {
	imageWidth: number;
	imageHeight: number;
	gridCols: number;
	gridRows: number;
}

export interface PuzzleViewportSize {
	width: number;
	height: number;
}

export interface ResponsivePuzzleBoardMetrics {
	tier: PuzzleBoardViewportTier;
	boardWidth: number;
	boardHeight: number;
	cellSize: number;
	pieceSlotSize: number;
}

const TIER_LONG_EDGE: Record<PuzzleBoardViewportTier, number> = {
	small: 320,
	medium: 520,
	large: 720,
	'extra-large': 880
};

const MIN_BOARD_CELL_SIZE = 24;

export const DESKTOP_TRAY_MIN_WIDTH = 300;
export const DESKTOP_TRAY_BASE_WIDTH = 360;
export const DESKTOP_BOARD_MIN_WIDTH = 480;
export const DESKTOP_TRAY_SEPARATOR_WIDTH = 20;

const DESKTOP_TRAY_TARGET_COLUMNS = 3;
const DESKTOP_TRAY_CHROME_WIDTH = 42;

export function getPuzzleBoardViewportTier(width: number): PuzzleBoardViewportTier {
	if (width < 640) return 'small';
	if (width < 1024) return 'medium';
	if (width < 1440) return 'large';
	return 'extra-large';
}

function getWidthReserve(tier: PuzzleBoardViewportTier): number {
	return tier === 'small' ? 32 : 64;
}

function getHeightReserve(tier: PuzzleBoardViewportTier): number {
	if (tier === 'small') return 300;
	if (tier === 'medium') return 280;
	return 260;
}

function roundMetric(value: number): number {
	return Math.round(value * 100) / 100;
}

function getPreferredBoardWidth(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize
): { tier: PuzzleBoardViewportTier; width: number } {
	const tier = getPuzzleBoardViewportTier(viewport.width);
	const gridCols = Math.max(1, puzzle.gridCols);
	const gridRows = Math.max(1, puzzle.gridRows);
	const imageAspect = puzzle.imageWidth / Math.max(1, puzzle.imageHeight);
	const targetLongEdge = TIER_LONG_EDGE[tier];
	const targetWidth = imageAspect >= 1 ? targetLongEdge : targetLongEdge * imageAspect;
	const viewportWidthCap = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		viewport.width - getWidthReserve(tier)
	);
	const viewportHeightCap = Math.max(
		MIN_BOARD_CELL_SIZE * gridRows,
		viewport.height - getHeightReserve(tier)
	);
	return {
		tier,
		width: Math.max(
			MIN_BOARD_CELL_SIZE * gridCols,
			Math.min(targetWidth, viewportWidthCap, viewportHeightCap * imageAspect)
		)
	};
}

export function getDefaultPuzzleTrayWidth(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize
): number {
	const { width } = getPreferredBoardWidth(puzzle, viewport);
	const cellSize = width / Math.max(1, puzzle.gridCols);
	return Math.max(
		DESKTOP_TRAY_BASE_WIDTH,
		cellSize * DESKTOP_TRAY_TARGET_COLUMNS + DESKTOP_TRAY_CHROME_WIDTH
	);
}

export function clampTrayWidth(layoutWidth: number, requestedWidth: number): number {
	const maxTrayWidth = Math.max(
		DESKTOP_TRAY_MIN_WIDTH,
		layoutWidth - DESKTOP_BOARD_MIN_WIDTH - DESKTOP_TRAY_SEPARATOR_WIDTH
	);
	return Math.min(Math.max(requestedWidth, DESKTOP_TRAY_MIN_WIDTH), maxTrayWidth);
}

export function getResponsivePuzzleBoardMetrics(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize,
	trayWidth: number
): ResponsivePuzzleBoardMetrics {
	const { tier, width: preferredWidth } = getPreferredBoardWidth(puzzle, viewport);
	const gridCols = Math.max(1, puzzle.gridCols);
	const imageAspect = puzzle.imageWidth / Math.max(1, puzzle.imageHeight);

	const viewportWidthCap = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		viewport.width - getWidthReserve(tier)
	);
	const desktopWidthCap =
		tier === 'small' || tier === 'medium'
			? Number.POSITIVE_INFINITY
			: Math.max(
					MIN_BOARD_CELL_SIZE * gridCols,
					viewportWidthCap - trayWidth - DESKTOP_TRAY_SEPARATOR_WIDTH
				);

	const boardWidth = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		Math.min(preferredWidth, desktopWidthCap)
	);
	const cellSize = boardWidth / gridCols;

	return {
		tier,
		boardWidth: roundMetric(boardWidth),
		boardHeight: roundMetric(boardWidth / imageAspect),
		cellSize: roundMetric(cellSize),
		pieceSlotSize: roundMetric(cellSize)
	};
}
