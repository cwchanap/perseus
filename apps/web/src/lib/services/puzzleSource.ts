import { fetchPuzzle, getPieceImageUrl, getReferenceImageUrl } from '$lib/services/api';
import { ApiError } from '$lib/services/api';
import { evictBlobUrls, openQuick } from '$lib/services/quickPuzzle';
import { QUICK_PUZZLE_ID_PREFIX } from '$lib/services/quickPuzzle/types';
import type { Puzzle, PuzzlePiece } from '$lib/types/puzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';

export type PuzzleSourceKind = 'local' | 'api';

export interface LoadedPuzzleSource {
	puzzle: Puzzle;
	resolvePieceImage: (piece: Pick<PuzzlePiece, 'id'>) => string;
	resolveReferenceImage: () => string | null;
	source: PuzzleSourceKind;
	cleanup: () => void;
}

function storedToPuzzle(stored: StoredQuickPuzzle): Puzzle {
	return {
		id: stored.id,
		name: stored.name,
		pieceCount: stored.pieceCount,
		gridCols: stored.gridCols,
		gridRows: stored.gridRows,
		imageWidth: stored.imageWidth,
		imageHeight: stored.imageHeight,
		createdAt: stored.createdAt,
		pieces: stored.pieces.map((meta) => ({
			id: meta.id,
			puzzleId: stored.id,
			correctX: meta.correctX,
			correctY: meta.correctY,
			edges: meta.edges,
			imagePath: `pieces/${meta.id}.png`
		})),
		hasReference: true
	};
}

export async function loadPuzzleSource(id: string): Promise<LoadedPuzzleSource> {
	if (id.startsWith(QUICK_PUZZLE_ID_PREFIX)) {
		const opened = await openQuick(id);
		if (opened) {
			return {
				puzzle: storedToPuzzle(opened.stored),
				resolvePieceImage: opened.resolvePieceImage,
				resolveReferenceImage: opened.resolveReferenceImage,
				source: 'local',
				cleanup: () => evictBlobUrls(id)
			};
		}
		// Quick-puzzle ids are local-only — never send them to the API.
		// Throw a 404-equivalent so the puzzle page shows the right message
		// without leaking a device-local id to the server.
		throw new ApiError(404, 'not_found', 'Quick puzzle no longer available');
	}

	const fetched = await fetchPuzzle(id);
	return {
		puzzle: fetched,
		resolvePieceImage: (piece) => getPieceImageUrl(fetched.id, piece.id),
		resolveReferenceImage: () =>
			fetched.hasReference === true ? getReferenceImageUrl(fetched.id) : null,
		source: 'api',
		cleanup: () => {
			/* no-op for API */
		}
	};
}
