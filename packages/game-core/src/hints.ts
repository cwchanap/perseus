// Hint strategy helper

/**
 * Determines which piece to hint based on current game state.
 *
 * Strategy:
 * 1. If the player has selected an unplaced piece, hint that piece.
 * 2. Otherwise pick the first unplaced piece in tray order.
 *
 * @param trayOrder - Ordered array of piece IDs (shuffled tray order)
 * @param placedPieceIds - Set of piece IDs that are already placed
 * @param selectedPieceId - Currently selected piece ID, or null if none
 * @returns The piece ID to hint, or null if all pieces are placed
 */
export function getHintPieceId(
	trayOrder: number[],
	placedPieceIds: Set<number>,
	selectedPieceId: number | null
): number | null {
	if (selectedPieceId !== null && !placedPieceIds.has(selectedPieceId)) {
		return selectedPieceId;
	}

	for (const pieceId of trayOrder) {
		if (!placedPieceIds.has(pieceId)) {
			return pieceId;
		}
	}

	return null;
}
