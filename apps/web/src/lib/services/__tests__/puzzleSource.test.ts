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
			public error: string,
			message: string
		) {
			super(message);
		}
	}
}));

vi.mock('$lib/services/quickPuzzle', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/quickPuzzle')>();
	return {
		...actual,
		openQuick: vi.fn(actual.openQuick)
	};
});

import * as api from '$lib/services/api';
import { ApiError } from '$lib/services/api';

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

	it('throws 404 for quick-puzzle ids that are not found locally', async () => {
		const { openQuick } = await import('$lib/services/quickPuzzle');
		const openQuickSpy = openQuick as ReturnType<typeof vi.fn>;

		// openQuick returns null for expired/evicted quick puzzles
		openQuickSpy.mockResolvedValueOnce(null);

		await expect(loadPuzzleSource('q-missing')).rejects.toThrow(ApiError);
		await expect(loadPuzzleSource('q-missing')).rejects.toMatchObject({ status: 404 });

		// The API should never be called with a q- id
		expect(api.fetchPuzzle).not.toHaveBeenCalledWith(expect.stringMatching(/^q-/));
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
