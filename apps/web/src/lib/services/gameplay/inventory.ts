import type { InventoryFilter } from '$lib/services/gameplay/session/types';
import type { Puzzle, PuzzlePiece } from '$lib/types/puzzle';

export function matchesInventoryFilter(
	piece: Pick<PuzzlePiece, 'correctX' | 'correctY'>,
	grid: Pick<Puzzle, 'gridCols' | 'gridRows'>,
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
