import { calculateFitZoom, type PuzzleSessionState, type Rotation } from '@perseus/game-core';

export interface BoardCell {
	x: number;
	y: number;
}

export interface BoardViewModelOptions {
	canvasWidth: number;
	canvasHeight: number;
	gridCols: number;
	gridRows: number;
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
	cellAt(canvasX: number, canvasY: number): BoardCell | null;
	pieceAt(canvasX: number, canvasY: number, state: Readonly<PuzzleSessionState>): number | null;
	state(session: Readonly<PuzzleSessionState>): BoardRenderState;
}

export function createBoardViewModel(options: BoardViewModelOptions): BoardViewModel {
	const cellSize = calculateFitZoom(
		options.gridCols,
		options.gridRows,
		options.canvasWidth,
		options.canvasHeight
	);
	const boardWidth = cellSize * options.gridCols;
	const boardHeight = cellSize * options.gridRows;
	const boardX = (options.canvasWidth - boardWidth) / 2;
	const boardY = (options.canvasHeight - boardHeight) / 2;

	function cellAt(canvasX: number, canvasY: number): BoardCell | null {
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

	function state(session: Readonly<PuzzleSessionState>): BoardRenderState {
		const placedIds = new Set(session.placedPieces.map((piece) => piece.pieceId));
		const records: BoardDrawRecord[] = session.placedPieces.map((piece) => ({
			pieceId: piece.pieceId,
			x: boardX + piece.x * cellSize - cellSize * 0.2,
			y: boardY + piece.y * cellSize - cellSize * 0.2,
			width: cellSize * 1.4,
			height: cellSize * 1.4,
			rotation: session.pieceRotations[piece.pieceId] ?? 0,
			placed: true,
			selected: false
		}));
		const traySize = Math.min(cellSize * 0.32, 96);
		const trayGap = 8;
		const trayY = Math.max(8, boardY - traySize - 12);
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
			boardX,
			boardY,
			boardWidth,
			boardHeight,
			cellWidth: cellSize,
			cellHeight: cellSize,
			drawRecords: records
		};
	}

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

	return { cellAt, pieceAt, state };
}
