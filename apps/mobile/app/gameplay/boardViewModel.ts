import type { PuzzleSessionState, Rotation } from '@perseus/game-core';
import type { BoardTransform } from './boardViewport';

export interface BoardCell {
	x: number;
	y: number;
}

export interface BoardDrawRecord {
	pieceId: number;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: Rotation;
}

export interface BoardRenderState {
	boardX: number;
	boardY: number;
	boardWidth: number;
	boardHeight: number;
	cellWidth: number;
	cellHeight: number;
	drawRecords: BoardDrawRecord[];
}

export interface BoardViewModel {
	state(session: Readonly<PuzzleSessionState>): BoardRenderState;
}

export function createBoardViewModel(transform: BoardTransform): BoardViewModel {
	function state(session: Readonly<PuzzleSessionState>): BoardRenderState {
		const records: BoardDrawRecord[] = session.placedPieces.map((piece) => ({
			pieceId: piece.pieceId,
			x: transform.boardX + piece.x * transform.cellSize - transform.cellSize * 0.2,
			y: transform.boardY + piece.y * transform.cellSize - transform.cellSize * 0.2,
			width: transform.cellSize * 1.4,
			height: transform.cellSize * 1.4,
			rotation: session.pieceRotations[piece.pieceId] ?? 0
		}));

		return {
			boardX: transform.boardX,
			boardY: transform.boardY,
			boardWidth: transform.boardWidth,
			boardHeight: transform.boardHeight,
			cellWidth: transform.cellSize,
			cellHeight: transform.cellSize,
			drawRecords: records
		};
	}

	return { state };
}
