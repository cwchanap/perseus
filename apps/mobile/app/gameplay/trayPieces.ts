import {
	matchesInventoryFilter,
	type PuzzleSessionState,
	type SessionPuzzleSpec
} from '@perseus/game-core';

export type TrayProjectionState = Pick<
	PuzzleSessionState,
	'placedPieces' | 'trayOrder' | 'organization' | 'gridCols' | 'gridRows'
>;

export function unplacedPieceIds(state: TrayProjectionState): number[] {
	const placed = new Set(state.placedPieces.map((piece) => piece.pieceId));
	return state.trayOrder.filter((pieceId) => !placed.has(pieceId));
}

export function visibleUnplacedPieceIds(
	state: TrayProjectionState,
	pieces: SessionPuzzleSpec['pieces']
): number[] {
	const filter = state.organization?.filter ?? 'all';
	const pieceById = new Map(pieces.map((piece) => [piece.id, piece]));
	return unplacedPieceIds(state).filter((pieceId) => {
		const piece = pieceById.get(pieceId);
		return piece ? matchesInventoryFilter(piece, state, filter) : false;
	});
}

// Fisher-Yates; intentionally duplicates the tiny web helper because mobile
// depends only on game-core/types and tray-order creation is an app seam.
export function shuffleIds(ids: readonly number[], random: () => number = Math.random): number[] {
	const result = [...ids];
	for (let i = result.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		const swapped = result[i];
		result[i] = result[j];
		result[j] = swapped;
	}
	return result;
}

export function shuffledUnplacedPieceIds(
	state: TrayProjectionState,
	random: () => number = Math.random
): number[] {
	return shuffleIds(unplacedPieceIds(state), random);
}
