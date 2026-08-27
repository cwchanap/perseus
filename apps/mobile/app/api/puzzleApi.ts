import {
	isPuzzleFamilyListResponse,
	validatePuzzleMetadata,
	type PuzzleFamilyListResponse,
	type ReadyPuzzle
} from '@perseus/types';

export type PuzzleJsonRequest = (url: string) => Promise<unknown>;

export interface PuzzleApi {
	listPuzzleFamilies(cursor?: string): Promise<PuzzleFamilyListResponse>;
	getPuzzle(puzzleId: string): Promise<ReadyPuzzle>;
	familyThumbnailUrl(familyId: string): string;
	thumbnailUrl(puzzleId: string): string;
	referenceUrl(puzzleId: string): string;
	pieceImageUrl(puzzleId: string, pieceId: number): string;
}

export function createPuzzleApi(options: {
	baseUrl: string;
	requestJson: PuzzleJsonRequest;
}): PuzzleApi {
	const baseUrl = options.baseUrl.replace(/\/+$/, '');

	return {
		async listPuzzleFamilies(cursor?: string): Promise<PuzzleFamilyListResponse> {
			const url =
				cursor !== undefined && cursor !== null
					? `${baseUrl}/api/puzzle-families?cursor=${encodeURIComponent(cursor)}`
					: `${baseUrl}/api/puzzle-families`;
			const raw = await options.requestJson(url);
			if (!isPuzzleFamilyListResponse(raw)) throw new Error('invalid_puzzle_family_list_response');
			return raw;
		},

		async getPuzzle(puzzleId: string): Promise<ReadyPuzzle> {
			const raw = await options.requestJson(
				`${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}`
			);
			if (!validatePuzzleMetadata(raw)) throw new Error('invalid_puzzle_response');
			if (raw.status !== 'ready') throw new Error('puzzle_not_ready');
			if (raw.id !== puzzleId) throw new Error('invalid_puzzle_response');

			return {
				id: raw.id,
				familyId: raw.familyId,
				difficulty: raw.difficulty,
				name: raw.name,
				...(raw.category ? { category: raw.category } : {}),
				...(raw.aspectRatio ? { aspectRatio: raw.aspectRatio } : {}),
				pieceCount: raw.pieceCount,
				gridCols: raw.gridCols,
				gridRows: raw.gridRows,
				imageWidth: raw.imageWidth,
				imageHeight: raw.imageHeight,
				createdAt: raw.createdAt,
				pieces: raw.pieces.map((piece) => ({
					...piece,
					edges: { ...piece.edges }
				})),
				version: raw.version,
				status: 'ready'
			};
		},

		familyThumbnailUrl(familyId: string): string {
			return `${baseUrl}/api/puzzle-families/${encodeURIComponent(familyId)}/thumbnail`;
		},

		thumbnailUrl(puzzleId: string): string {
			return `${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}/thumbnail`;
		},

		referenceUrl(puzzleId: string): string {
			return `${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}/reference`;
		},

		pieceImageUrl(puzzleId: string, pieceId: number): string {
			return `${baseUrl}/api/puzzles/${encodeURIComponent(puzzleId)}/pieces/${pieceId}/image`;
		}
	};
}
