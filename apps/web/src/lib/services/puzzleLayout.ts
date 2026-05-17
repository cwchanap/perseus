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
const DESKTOP_SIDE_PANEL_COLUMNS = 3;
const DESKTOP_LAYOUT_RESERVE = 88;

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

export function getResponsivePuzzleBoardMetrics(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize
): ResponsivePuzzleBoardMetrics {
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
	const heightWidthCap = viewportHeightCap * imageAspect;
	const desktopWidthCap =
		tier === 'small' || tier === 'medium'
			? Number.POSITIVE_INFINITY
			: Math.max(
					MIN_BOARD_CELL_SIZE * gridCols,
					(viewportWidthCap - DESKTOP_LAYOUT_RESERVE) / (1 + DESKTOP_SIDE_PANEL_COLUMNS / gridCols)
				);
	const boardWidth = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		Math.min(targetWidth, viewportWidthCap, heightWidthCap, desktopWidthCap)
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
