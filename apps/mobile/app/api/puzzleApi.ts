import { validatePuzzleMetadata, type PuzzleListResponse, type ReadyPuzzle } from '@perseus/types';

export type PuzzleJsonRequest = (url: string) => Promise<unknown>;

export interface PuzzleApi {
	listPuzzles(cursor?: string): Promise<PuzzleListResponse>;
	getPuzzle(puzzleId: string): Promise<ReadyPuzzle>;
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
		async listPuzzles(cursor?: string): Promise<PuzzleListResponse> {
			const url = cursor
				? `${baseUrl}/api/puzzles?cursor=${encodeURIComponent(cursor)}`
				: `${baseUrl}/api/puzzles`;
			return (await options.requestJson(url)) as PuzzleListResponse;
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

		thumbnailUrl(puzzleId: string): string {
			return `${baseUrl}/api/puzzles/${puzzleId}/thumbnail`;
		},

		referenceUrl(puzzleId: string): string {
			return `${baseUrl}/api/puzzles/${puzzleId}/reference`;
		},

		pieceImageUrl(puzzleId: string, pieceId: number): string {
			return `${baseUrl}/api/puzzles/${puzzleId}/pieces/${pieceId}/image`;
		}
	};
}
