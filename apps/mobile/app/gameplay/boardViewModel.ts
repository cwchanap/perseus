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
	placed: boolean;
	selected: boolean;
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
	pieceAt(canvasX: number, canvasY: number, state: Readonly<PuzzleSessionState>): number | null;
	state(session: Readonly<PuzzleSessionState>): BoardRenderState;
}

export function createBoardViewModel(transform: BoardTransform): BoardViewModel {
	function state(session: Readonly<PuzzleSessionState>): BoardRenderState {
		const placedIds = new Set(session.placedPieces.map((piece) => piece.pieceId));
		const records: BoardDrawRecord[] = session.placedPieces.map((piece) => ({
			pieceId: piece.pieceId,
			x: transform.boardX + piece.x * transform.cellSize - transform.cellSize * 0.2,
			y: transform.boardY + piece.y * transform.cellSize - transform.cellSize * 0.2,
			width: transform.cellSize * 1.4,
			height: transform.cellSize * 1.4,
			rotation: session.pieceRotations[piece.pieceId] ?? 0,
			placed: true,
			selected: false
		}));
		const traySize = Math.min(transform.cellSize * 0.32, 96);
		const trayGap = 8;
		const trayY = Math.max(8, transform.boardY - traySize - 12);
		let trayIndex = 0;

		for (const pieceId of session.trayOrder) {
			if (placedIds.has(pieceId)) continue;
			records.push({
				pieceId,
				x: 8 + trayIndex++ * (traySize + trayGap),
				y: trayY,
				width: traySize,
				height: traySize,
				rotation: session.pieceRotations[pieceId] ?? 0,
				placed: false,
				selected: session.selectedPieceId === pieceId
			});
		}

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

	// Temporary unplaced-piece oracle for the HPA-1 in-canvas drag path; the
	// external tray (Task 3B) deletes this and the tray draw records above.
	function pieceAt(
		canvasX: number,
		canvasY: number,
		session: Readonly<PuzzleSessionState>
	): number | null {
		const records = state(session).drawRecords;
		for (let index = records.length - 1; index >= 0; index -= 1) {
			const record = records[index];
			if (
				record &&
				!record.placed &&
				canvasX >= record.x &&
				canvasX < record.x + record.width &&
				canvasY >= record.y &&
				canvasY < record.y + record.height
			) {
				return record.pieceId;
			}
		}
		return null;
	}

	return { pieceAt, state };
}
