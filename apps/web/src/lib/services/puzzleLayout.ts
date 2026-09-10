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
	trayColumns: number;
}

const TIER_LONG_EDGE: Record<PuzzleBoardViewportTier, number> = {
	small: 384,
	medium: 520,
	large: 720,
	'extra-large': 880
};

const MIN_BOARD_CELL_SIZE = 24;

const TABLET_TRAY_COLUMNS = 2;
const DESKTOP_TRAY_COLUMNS = 3;
const TABLET_TRAY_PIECE_SCALE = 1.125;
const TRAY_INVENTORY_PADDING = 28;
const TRAY_INVENTORY_GAP = 6;

export const DESKTOP_TRAY_MIN_WIDTH = 300;
export const DESKTOP_TRAY_BASE_WIDTH = 352;
export const DESKTOP_BOARD_MIN_WIDTH = 480;
export const DESKTOP_TRAY_SEPARATOR_WIDTH = 20;

export const GAMEPLAY_RAIL_WIDTH = {
	small: 56,
	medium: 56,
	large: 88,
	'extra-large': 96
} as const;

export const MOBILE_SHEET_HEIGHT = {
	peek: 140,
	half: 300,
	full: 528
} as const;

export const MOBILE_GAMEPLAY_GAP = 20;

const DESKTOP_TRAY_CHROME_WIDTH = 42;

function getTrayTargetColumns(tier: PuzzleBoardViewportTier): number {
	return tier === 'large' ? TABLET_TRAY_COLUMNS : DESKTOP_TRAY_COLUMNS;
}

function getTrayPieceSlotSize(
	tier: PuzzleBoardViewportTier,
	cellSize: number,
	trayWidth: number
): number {
	const trayColumns = getTrayTargetColumns(tier);
	const preferredSize = tier === 'large' ? cellSize * TABLET_TRAY_PIECE_SCALE : cellSize;
	const availableSize =
		(trayWidth - TRAY_INVENTORY_PADDING - Math.max(0, trayColumns - 1) * TRAY_INVENTORY_GAP) /
		trayColumns;

	return roundMetric(Math.min(preferredSize, Math.max(MIN_BOARD_CELL_SIZE, availableSize)));
}

export function getPuzzleBoardViewportTier(width: number): PuzzleBoardViewportTier {
	if (width < 640) return 'small';
	if (width < 1024) return 'medium';
	if (width < 1440) return 'large';
	return 'extra-large';
}

export function getGameplayRailWidth(viewportWidth: number): number {
	return GAMEPLAY_RAIL_WIDTH[getPuzzleBoardViewportTier(viewportWidth)];
}

function getWidthReserve(tier: PuzzleBoardViewportTier): number {
	if (tier === 'small' || tier === 'medium') {
		return GAMEPLAY_RAIL_WIDTH[tier] + MOBILE_GAMEPLAY_GAP + (tier === 'small' ? 24 : 64);
	}
	return 64;
}

function getHeightReserve(tier: PuzzleBoardViewportTier): number {
	if (tier === 'small' || tier === 'medium') return MOBILE_SHEET_HEIGHT.half;
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
	const { tier, width } = getPreferredBoardWidth(puzzle, viewport);
	const cellSize = width / Math.max(1, puzzle.gridCols);
	const baseWidth = tier === 'large' ? 300 : DESKTOP_TRAY_BASE_WIDTH;
	return Math.max(baseWidth, cellSize * getTrayTargetColumns(tier) + DESKTOP_TRAY_CHROME_WIDTH);
}

export function clampTrayWidth(layoutWidth: number, requestedWidth: number, railWidth = 0): number {
	const maxTrayWidth = Math.max(
		DESKTOP_TRAY_MIN_WIDTH,
		layoutWidth - railWidth - DESKTOP_BOARD_MIN_WIDTH - DESKTOP_TRAY_SEPARATOR_WIDTH
	);
	return Math.min(Math.max(requestedWidth, DESKTOP_TRAY_MIN_WIDTH), maxTrayWidth);
}

export function getResponsivePuzzleBoardMetrics(
	puzzle: PuzzleBoardSource,
	viewport: PuzzleViewportSize,
	trayWidth: number,
	layoutWidth?: number
): ResponsivePuzzleBoardMetrics {
	const { tier, width: preferredWidth } = getPreferredBoardWidth(puzzle, viewport);
	const gridCols = Math.max(1, puzzle.gridCols);
	const imageAspect = puzzle.imageWidth / Math.max(1, puzzle.imageHeight);

	// The desktop board cap must be derived from the same measured layout
	// width used to clamp the tray (the .game-layout box, capped at 96rem),
	// not the outer viewport. window.innerWidth can exceed the layout box by
	// hundreds of pixels on wide displays, so capping from the outer viewport
	// lets the board metric exceed the actual .board-viewport and forces
	// PuzzleBoardPanel.getFitZoom() to silently downscale it. When the layout
	// width is unavailable (pre-measurement), fall back to the viewport width
	// to preserve the prior behavior until the ResizeObserver fires.
	const desktopCapSource = layoutWidth ?? viewport.width;
	const railWidth = getGameplayRailWidth(viewport.width);
	const desktopWidthCap =
		tier === 'small' || tier === 'medium'
			? Number.POSITIVE_INFINITY
			: Math.max(
					MIN_BOARD_CELL_SIZE * gridCols,
					desktopCapSource -
						railWidth -
						getWidthReserve(tier) -
						trayWidth -
						DESKTOP_TRAY_SEPARATOR_WIDTH
				);

	const boardWidth = Math.max(
		MIN_BOARD_CELL_SIZE * gridCols,
		Math.min(preferredWidth, desktopWidthCap)
	);
	const cellSize = boardWidth / gridCols;
	const trayColumns = getTrayTargetColumns(tier);

	return {
		tier,
		boardWidth: roundMetric(boardWidth),
		boardHeight: roundMetric(boardWidth / imageAspect),
		cellSize: roundMetric(cellSize),
		pieceSlotSize: getTrayPieceSlotSize(tier, cellSize, trayWidth),
		trayColumns
	};
}
