import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPuzzle, deletePuzzle, fetchPuzzles, fetchPuzzle, checkSession } from '../api';
import type { PuzzleCategory } from '$lib/types/puzzle';

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('API Service - deletePuzzle', () => {
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
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/admin\/puzzles\/abc$/), {
			method: 'DELETE',
			credentials: 'include'
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
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/admin\/puzzles\/abc$/), {
			method: 'DELETE',
			credentials: 'include'
		});
	});
});

describe('API Service - fetchPuzzles', () => {
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
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/puzzles$/));
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
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/puzzles\/p1$/));
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
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/admin\/session$/), {
			credentials: 'include'
		});
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

describe('API Service - createPuzzle', () => {
	const mockPuzzleMetadata = {
		id: 'p1',
		name: 'Test Puzzle',
		pieceCount: 25,
		status: 'ready',
		createdAt: 0
	};

	it('appends category to FormData when category is provided', async () => {
		let capturedBody: FormData | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((_url: string, options: RequestInit) => {
				capturedBody = options.body as FormData;
				return Promise.resolve(
					new Response(JSON.stringify(mockPuzzleMetadata), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			})
		);

		const image = new File(['data'], 'test.png', { type: 'image/png' });
		const category: PuzzleCategory = 'Animals';
		await createPuzzle('Test Puzzle', 25, image, category);

		expect(capturedBody).toBeInstanceOf(FormData);
		expect(capturedBody!.get('category')).toBe('Animals');
	});

	it('does not append category to FormData when category is undefined', async () => {
		let capturedBody: FormData | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((_url: string, options: RequestInit) => {
				capturedBody = options.body as FormData;
				return Promise.resolve(
					new Response(JSON.stringify(mockPuzzleMetadata), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			})
		);

		const image = new File(['data'], 'test.png', { type: 'image/png' });
		await createPuzzle('Test Puzzle', 25, image, undefined);

		expect(capturedBody).toBeInstanceOf(FormData);
		expect(capturedBody!.get('category')).toBeNull();
	});
});
