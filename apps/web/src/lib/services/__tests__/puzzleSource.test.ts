import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadPuzzleSource } from '../puzzleSource';

vi.mock('$lib/services/api', () => ({
	fetchPuzzle: vi.fn(),
	getPieceImageUrl: vi.fn(
		(puzzleId: string, pieceId: number) => `/api/puzzles/${puzzleId}/pieces/${pieceId}/image`
	),
	getReferenceImageUrl: vi.fn((puzzleId: string) => `/api/puzzles/${puzzleId}/reference`),
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public errorCode: string,
			message: string
		) {
			super(message);
		}
	}
}));

import * as api from '$lib/services/api';

describe('loadPuzzleSource', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	it('uses the API source for non-quick IDs', async () => {
		const fakePuzzle = {
			id: 'server-id',
			name: 'Server',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: 0,
			pieces: [],
			hasReference: true
		};
		(api.fetchPuzzle as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePuzzle);

		const result = await loadPuzzleSource('server-id');
		expect(result.source).toBe('api');
		expect(result.puzzle).toEqual(fakePuzzle);
		expect(result.resolvePieceImage({ id: 1 } as never)).toContain(
			'/api/puzzles/server-id/pieces/1/image'
		);
		expect(result.resolveReferenceImage()).toContain('/api/puzzles/server-id/reference');
	});

	it('falls through to the API when local source returns null for a quick id', async () => {
		const fakePuzzle = {
			id: 'q-not-stored',
			name: 'Server-stored quick',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: 0,
			pieces: []
		};
		(api.fetchPuzzle as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePuzzle);

		const result = await loadPuzzleSource('q-not-stored');
		expect(result.source).toBe('api');
	});

	it('uses the local source for q- IDs that resolve via openQuick', async () => {
		const { createQuick } = await import('$lib/services/quickPuzzle');
		const canvas = new OffscreenCanvas(200, 200);
		canvas.getContext('2d')!.fillRect(0, 0, 200, 200);
		const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
		const file = new File([blob], 'a.jpg', { type: 'image/jpeg' });
		const created = await createQuick(file, 4, 'L');

		const result = await loadPuzzleSource(created.stored.id);
		expect(result.source).toBe('local');
		expect(result.puzzle.id).toBe(created.stored.id);
		expect(result.resolvePieceImage({ id: 0 } as never)).toMatch(/^blob:/);

		result.cleanup();
	});
});
