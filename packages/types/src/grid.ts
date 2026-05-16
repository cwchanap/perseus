// Pure grid + edge geometry helpers shared by the workflow and the web's quick-puzzle generator.
// Edge calculation is deterministic by position so that adjacent pieces always have
// matching/opposite edges without coordination.

import type { EdgeType } from './index';

export const PUZZLE_ASPECT_RATIOS = ['1:1', '4:3', '3:4'] as const;

export type PuzzleAspectRatio = (typeof PUZZLE_ASPECT_RATIOS)[number];

export const DEFAULT_PUZZLE_ASPECT_RATIO: PuzzleAspectRatio = '1:1';

interface BaseGrid {
	rows: number;
	cols: number;
}

const BASE_GRIDS: Record<PuzzleAspectRatio, BaseGrid> = {
	'1:1': { rows: 1, cols: 1 },
	'4:3': { rows: 3, cols: 4 },
	'3:4': { rows: 4, cols: 3 }
};

export function isPuzzleAspectRatio(value: unknown): value is PuzzleAspectRatio {
	return typeof value === 'string' && (PUZZLE_ASPECT_RATIOS as readonly string[]).includes(value);
}

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

export function getGridDimensionsForAspectRatio(
	pieceCount: number,
	aspectRatio: PuzzleAspectRatio
): { rows: number; cols: number } {
	if (!Number.isInteger(pieceCount) || pieceCount <= 0) {
		return { rows: 0, cols: 0 };
	}

	const base = BASE_GRIDS[aspectRatio];
	const basePieceCount = base.rows * base.cols;
	if (pieceCount % basePieceCount !== 0) {
		return { rows: 0, cols: 0 };
	}

	const scaleSquared = pieceCount / basePieceCount;
	const scale = Math.sqrt(scaleSquared);
	if (!Number.isInteger(scale)) {
		return { rows: 0, cols: 0 };
	}

	return {
		rows: base.rows * scale,
		cols: base.cols * scale
	};
}

export function isValidPieceCountForAspectRatio(
	pieceCount: number,
	aspectRatio: PuzzleAspectRatio
): boolean {
	const { rows, cols } = getGridDimensionsForAspectRatio(pieceCount, aspectRatio);
	return rows > 0 && cols > 0 && rows * cols === pieceCount;
}

export function getAllowedPieceCountsForAspectRatio(
	aspectRatio: PuzzleAspectRatio,
	minPieces: number,
	maxPieces: number
): number[] {
	const base = BASE_GRIDS[aspectRatio];
	const basePieceCount = base.rows * base.cols;
	const counts: number[] = [];

	for (let scale = 1; ; scale += 1) {
		const count = basePieceCount * scale * scale;
		if (count > maxPieces) break;
		if (count >= minPieces) counts.push(count);
	}

	return counts;
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
