import type { InventoryFilter } from './session/types';

export function matchesInventoryFilter(
	piece: Readonly<{ correctX: number; correctY: number }>,
	grid: Readonly<{ gridCols: number; gridRows: number }>,
	filter: InventoryFilter
): boolean {
	if (filter === 'all') return true;

	const onHorizontalBoundary = piece.correctX === 0 || piece.correctX === grid.gridCols - 1;
	const onVerticalBoundary = piece.correctY === 0 || piece.correctY === grid.gridRows - 1;
	const isCorner = onHorizontalBoundary && onVerticalBoundary;
	const isPerimeter = onHorizontalBoundary || onVerticalBoundary;

	if (filter === 'corners') return isCorner;
	if (filter === 'edges') return isPerimeter && !isCorner;
	return !isPerimeter;
}
