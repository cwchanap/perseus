import {
	validatePuzzleMetadata,
	type PuzzleListResponse,
	type PuzzleSummary,
	type ReadyPuzzle
} from '@perseus/types';

export type PuzzleJsonRequest = (url: string) => Promise<unknown>;

export interface PuzzleApi {
	listPuzzles(cursor?: string): Promise<PuzzleListResponse>;
	getPuzzle(puzzleId: string): Promise<ReadyPuzzle>;
	thumbnailUrl(puzzleId: string): string;
	referenceUrl(puzzleId: string): string;
	pieceImageUrl(puzzleId: string, pieceId: number): string;
}

function isPuzzleSummary(value: unknown): value is PuzzleSummary {
	if (typeof value !== 'object' || value === null) return false;
	const s = value as Record<string, unknown>;
	return (
		typeof s.id === 'string' &&
		typeof s.name === 'string' &&
		typeof s.pieceCount === 'number' &&
		Number.isFinite(s.pieceCount) &&
		typeof s.status === 'string'
	);
}

function isPuzzleListResponse(value: unknown): value is PuzzleListResponse {
	if (typeof value !== 'object' || value === null) return false;
	const r = value as Record<string, unknown>;
	if (!Array.isArray(r.puzzles) || !r.puzzles.every(isPuzzleSummary)) return false;
	if (typeof r.total !== 'number' || !Number.isFinite(r.total)) return false;
	if (typeof r.offset !== 'number' || !Number.isFinite(r.offset)) return false;
	if (typeof r.limit !== 'number' || !Number.isFinite(r.limit)) return false;
	if (r.nextCursor !== undefined && typeof r.nextCursor !== 'string') return false;
	return true;
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
			const raw = await options.requestJson(url);
			if (!isPuzzleListResponse(raw)) throw new Error('invalid_puzzle_list_response');
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
