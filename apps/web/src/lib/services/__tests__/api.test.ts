import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { deletePuzzle, fetchPuzzles, fetchPuzzle, checkSession } from '../api';

describe('API Service - deletePuzzle', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns partial deletion details for 207 responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						success: false,
						partialSuccess: true,
						warning: 'Puzzle metadata deleted but some assets failed to delete',
						failedAssets: ['puzzles/abc/pieces/0.png']
					}),
					{
						status: 207,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
		);

		const result = await deletePuzzle('abc');

		expect(result).toEqual({
			success: false,
			partialSuccess: true,
			warning: 'Puzzle metadata deleted but some assets failed to delete',
			failedAssets: ['puzzles/abc/pieces/0.png']
		});
	});

	it('returns null for 204 responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(null, {
					status: 204
				})
			)
		);

		const result = await deletePuzzle('abc');

		expect(result).toBeNull();
	});
});

describe('API Service - fetchPuzzles', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns list of puzzles on success', async () => {
		const mockPuzzles = [
			{ id: 'p1', name: 'Puzzle 1', pieceCount: 25, status: 'ready' },
			{ id: 'p2', name: 'Puzzle 2', pieceCount: 100, status: 'ready' }
		];
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: mockPuzzles }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await fetchPuzzles();

		expect(result).toEqual(mockPuzzles);
	});

	it('throws ApiError on non-ok response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'internal_error', message: 'Server failure' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(fetchPuzzles()).rejects.toMatchObject({ status: 500 });
	});
});

describe('API Service - fetchPuzzle', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns puzzle data on success', async () => {
		const mockPuzzle = {
			id: 'p1',
			name: 'Test',
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: 0,
			pieces: []
		};
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(mockPuzzle), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await fetchPuzzle('p1');

		expect(result).toEqual(mockPuzzle);
	});

	it('throws ApiError when puzzle is not found', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'not_found', message: 'Puzzle not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(fetchPuzzle('missing')).rejects.toMatchObject({ status: 404 });
	});
});

describe('API Service - checkSession', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns true when session is authenticated', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ authenticated: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await checkSession();
		expect(result).toBe(true);
	});

	it('returns false when response is not ok', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

		const result = await checkSession();
		expect(result).toBe(false);
	});

	it('returns false when fetch throws', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

		const result = await checkSession();
		expect(result).toBe(false);
	});
});
