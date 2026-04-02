import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
	createPuzzle,
	deletePuzzle,
	fetchPuzzles,
	fetchPuzzle,
	checkSession,
	login,
	logout,
	fetchAdminPuzzles,
	getThumbnailUrl,
	getPieceImageUrl,
	getReferenceImageUrl,
	ApiError
} from '../api';
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

// ─── URL helpers ─────────────────────────────────────────────────────────────

describe('API Service - getThumbnailUrl', () => {
	it('returns correct thumbnail URL for a given puzzle ID', () => {
		const url = getThumbnailUrl('abc-123');
		expect(url).toMatch(/\/api\/puzzles\/abc-123\/thumbnail$/);
	});
});

describe('API Service - getPieceImageUrl', () => {
	it('returns correct piece image URL for a given puzzle ID and piece ID', () => {
		const url = getPieceImageUrl('abc-123', 5);
		expect(url).toMatch(/\/api\/puzzles\/abc-123\/pieces\/5\/image$/);
	});

	it('returns URL with piece ID 0', () => {
		const url = getPieceImageUrl('puzzle-x', 0);
		expect(url).toMatch(/\/api\/puzzles\/puzzle-x\/pieces\/0\/image$/);
	});
});

describe('API Service - getReferenceImageUrl', () => {
	it('returns correct reference image URL for a given puzzle ID', () => {
		const url = getReferenceImageUrl('abc-123');
		expect(url).toMatch(/\/api\/puzzles\/abc-123\/reference$/);
	});
});

// ─── login ───────────────────────────────────────────────────────────────────

describe('API Service - login', () => {
	it('returns login response on success', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await login('my-passkey');
		expect(result).toEqual({ success: true });
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/admin\/login$/),
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
				body: JSON.stringify({ passkey: 'my-passkey' })
			})
		);
	});

	it('throws ApiError on failed login', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'unauthorized', message: 'Invalid passkey' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(login('wrong')).rejects.toMatchObject({ status: 401 });
	});
});

// ─── logout ──────────────────────────────────────────────────────────────────

describe('API Service - logout', () => {
	it('resolves successfully on 204 response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

		await expect(logout()).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/admin\/logout$/),
			expect.objectContaining({ method: 'POST', credentials: 'include' })
		);
	});

	it('throws ApiError when logout fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'server_error', message: 'Internal error' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(logout()).rejects.toBeInstanceOf(ApiError);
	});
});

// ─── fetchAdminPuzzles ───────────────────────────────────────────────────────

describe('API Service - fetchAdminPuzzles', () => {
	it('returns list of puzzles including non-ready ones', async () => {
		const mockPuzzles = [
			{ id: 'p1', name: 'Puzzle 1', pieceCount: 25, status: 'ready' },
			{ id: 'p2', name: 'Puzzle 2', pieceCount: 9, status: 'processing' }
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

		const result = await fetchAdminPuzzles();
		expect(result).toEqual(mockPuzzles);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/admin\/puzzles$/),
			expect.objectContaining({ credentials: 'include' })
		);
	});

	it('throws ApiError when not authenticated', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

		await expect(fetchAdminPuzzles()).rejects.toMatchObject({ status: 401 });
	});
});

// ─── deletePuzzle (force option) ─────────────────────────────────────────────

describe('API Service - deletePuzzle with force option', () => {
	it('appends ?force=true to URL when force option is set', async () => {
		let capturedUrl = '';
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((url: string) => {
				capturedUrl = url;
				return Promise.resolve(new Response(null, { status: 204 }));
			})
		);

		await deletePuzzle('abc', { force: true });
		expect(capturedUrl).toMatch(/\/api\/admin\/puzzles\/abc\?force=true$/);
	});

	it('does not append ?force=true when force option is false', async () => {
		let capturedUrl = '';
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((url: string) => {
				capturedUrl = url;
				return Promise.resolve(new Response(null, { status: 204 }));
			})
		);

		await deletePuzzle('abc', { force: false });
		expect(capturedUrl).not.toMatch(/[?&]force=/);
	});
});

// ─── handleResponse edge cases ───────────────────────────────────────────────

describe('API Service - handleResponse edge cases (via fetchPuzzle)', () => {
	it('throws when response body is a JSON array instead of object', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify([1, 2, 3]), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(fetchPuzzle('p1')).rejects.toThrow(/Unexpected response format/);
	});

	it('throws when response body is invalid JSON', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('not valid json', {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(fetchPuzzle('p1')).rejects.toThrow(/Invalid JSON response/);
	});

	it('throws ApiError with fallback message when error response has no message field', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'oops' }), {
					status: 400,
					statusText: 'Bad Request',
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const err = await fetchPuzzle('p1').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.error).toBe('oops');
		expect(err.message).toBe('Bad Request');
	});

	it('throws ApiError with Unknown error when response body is not an object', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('"just a string"', {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const err = await fetchPuzzle('p1').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.error).toBe('Unknown error');
	});
});

// ─── handleVoidResponse edge cases ───────────────────────────────────────────

describe('API Service - handleVoidResponse edge cases (via logout)', () => {
	it('resolves when response has content-length 0', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('', {
					status: 200,
					headers: { 'content-length': '0' }
				})
			)
		);

		await expect(logout()).resolves.toBeUndefined();
	});

	it('resolves when response has no content-type header', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('', {
					status: 200
				})
			)
		);

		await expect(logout()).resolves.toBeUndefined();
	});

	it('resolves when response has non-JSON content-type', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('ok', {
					status: 200,
					headers: { 'Content-Type': 'text/plain' }
				})
			)
		);

		await expect(logout()).resolves.toBeUndefined();
	});

	it('resolves after best-effort JSON parse for JSON content-type', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(logout()).resolves.toBeUndefined();
	});
});
