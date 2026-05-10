// Pure grid + edge geometry helpers shared by the workflow and the web's quick-puzzle generator.
// Edge calculation is deterministic by position so that adjacent pieces always have
// matching/opposite edges without coordination.

import type { EdgeType } from './index';

/**
 * Find the most square-like grid for a given piece count.
 * Picks the largest factor of `pieceCount` that is <= sqrt(pieceCount) as the row count,
 * giving rows <= cols (e.g., 225 → 15x15, 24 → 4x6).
 */
export function getGridDimensions(pieceCount: number): { rows: number; cols: number } {
	if (pieceCount <= 0) {
		return { rows: 0, cols: 0 };
	}

	const sqrt = Math.floor(Math.sqrt(pieceCount));
	for (let i = sqrt; i >= 1; i -= 1) {
		if (pieceCount % i === 0) {
			return { rows: i, cols: pieceCount / i };
		}
	}

	// Unreachable: the loop always returns at i===1 since pieceCount % 1 === 0.
	return { rows: 1, cols: pieceCount };
}

function opposite(edge: EdgeType): EdgeType {
	return edge === 'tab' ? 'blank' : edge === 'blank' ? 'tab' : 'flat';
}

export function getBottomEdge(row: number, col: number, rows: number): EdgeType {
	if (row === rows - 1) return 'flat';
	return (row + col) % 2 === 0 ? 'blank' : 'tab';
}

export function getRightEdge(row: number, col: number, cols: number): EdgeType {
	if (col === cols - 1) return 'flat';
	return (row + col) % 2 === 0 ? 'tab' : 'blank';
}

export function getTopEdge(row: number, col: number, rows: number): EdgeType {
	if (row === 0) return 'flat';
	return opposite(getBottomEdge(row - 1, col, rows));
}

export function getLeftEdge(row: number, col: number, cols: number): EdgeType {
	if (col === 0) return 'flat';
	return opposite(getRightEdge(row, col - 1, cols));
}
