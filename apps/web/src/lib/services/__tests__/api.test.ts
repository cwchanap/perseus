import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
	createPuzzle,
	createPlayerPuzzle,
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
	getPlayerSession,
	logoutPlayer,
	getGoogleLoginUrl,
	fetchPlayerAllowlist,
	addPlayerAllowlistEntry,
	removePlayerAllowlistEntry,
	getPlayerProfile,
	updatePlayerProfile,
	uploadPlayerAvatar,
	getPlayerPuzzles,
	getPlayerStats,
	recordCompletion,
	getAvatarUrl,
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
	it('returns paginated puzzle response on success', async () => {
		const responseBody = {
			puzzles: [
				{ id: 'p1', name: 'Puzzle 1', pieceCount: 25, status: 'ready' },
				{ id: 'p2', name: 'Puzzle 2', pieceCount: 100, status: 'ready' }
			],
			total: 2,
			offset: 0,
			limit: 20
		};
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(responseBody), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await fetchPuzzles();

		expect(result).toEqual(responseBody);
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/puzzles$/));
	});

	it('forwards an abort signal to fetch when provided', async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						puzzles: [],
						total: 0,
						offset: 0,
						limit: 20
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
		);

		await fetchPuzzles({ signal: controller.signal });

		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/puzzles$/),
			expect.objectContaining({ signal: controller.signal })
		);
	});

	it('appends q, category, offset, and limit query params when provided', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						puzzles: [],
						total: 0,
						offset: 10,
						limit: 5
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
		);

		await fetchPuzzles({ q: 'cats', category: 'Animals', offset: 10, limit: 5 });

		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/puzzles\?(.+&)?q=cats(&.+)?$/)
		);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/puzzles\?(.+&)?category=Animals(&.+)?$/)
		);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/puzzles\?(.+&)?offset=10(&.+)?$/)
		);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/puzzles\?(.+&)?limit=5(&.+)?$/)
		);
	});

	it('omits undefined and default query params', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						puzzles: [],
						total: 0,
						offset: 0,
						limit: 20
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
		);

		await fetchPuzzles({ offset: 0, limit: 20, q: undefined, category: undefined });

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

		const error = await fetchPuzzles().catch((e) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 500 });
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

	it('appends the selected aspect ratio to FormData', async () => {
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
		await createPuzzle('Test Puzzle', 48, image, undefined, '3:4');

		expect(capturedBody).toBeInstanceOf(FormData);
		expect(capturedBody!.get('aspectRatio')).toBe('3:4');
	});
});

describe('API Service - createPlayerPuzzle', () => {
	const mockPuzzleMetadata = {
		id: 'p1',
		name: 'Player Puzzle',
		pieceCount: 48,
		status: 'processing',
		createdAt: 0
	};

	it('posts player uploads to /api/puzzles with credentials', async () => {
		let capturedUrl = '';
		let capturedOptions: RequestInit | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((url: string, options: RequestInit) => {
				capturedUrl = url;
				capturedOptions = options;
				return Promise.resolve(
					new Response(JSON.stringify(mockPuzzleMetadata), {
						status: 201,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			})
		);

		const image = new File(['data'], 'test.png', { type: 'image/png' });
		await createPlayerPuzzle('Player Puzzle', 48, image, 'Art', '3:4');

		expect(capturedUrl).toMatch(/\/api\/puzzles$/);
		expect(capturedOptions?.method).toBe('POST');
		expect(capturedOptions?.credentials).toBe('include');
		expect(capturedOptions?.body).toBeInstanceOf(FormData);
		const body = capturedOptions!.body as FormData;
		expect(body.get('name')).toBe('Player Puzzle');
		expect(body.get('pieceCount')).toBe('48');
		expect(body.get('aspectRatio')).toBe('3:4');
		expect(body.get('category')).toBe('Art');
		expect(body.get('image')).toBe(image);
	});

	it('omits aspectRatio and category fields when not provided', async () => {
		let capturedOptions: RequestInit | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((_: string, options: RequestInit) => {
				capturedOptions = options;
				return Promise.resolve(
					new Response(JSON.stringify({ id: 'p2', status: 'processing' }), {
						status: 201,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			})
		);

		const image = new File(['data'], 'test.png', { type: 'image/png' });
		await createPlayerPuzzle('Minimal Puzzle', 16, image);

		const body = capturedOptions!.body as FormData;
		expect(body.get('name')).toBe('Minimal Puzzle');
		expect(body.get('pieceCount')).toBe('16');
		expect(body.has('aspectRatio')).toBe(false);
		expect(body.has('category')).toBe(false);
		expect(body.get('image')).toBe(image);
	});

	it('includes aspectRatio but omits category when only aspectRatio is provided', async () => {
		let capturedOptions: RequestInit | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((_: string, options: RequestInit) => {
				capturedOptions = options;
				return Promise.resolve(
					new Response(JSON.stringify({ id: 'p3', status: 'processing' }), {
						status: 201,
						headers: { 'Content-Type': 'application/json' }
					})
				);
			})
		);

		const image = new File(['data'], 'test.png', { type: 'image/png' });
		await createPlayerPuzzle('Aspect Only', 100, image, undefined, '4:3');

		const body = capturedOptions!.body as FormData;
		expect(body.get('aspectRatio')).toBe('4:3');
		expect(body.has('category')).toBe(false);
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

// ─── player auth ─────────────────────────────────────────────────────────────

describe('API Service - player auth', () => {
	it('gets player session with credentials and returns unauthenticated response', async () => {
		const responseBody = { authenticated: false };
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(responseBody), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await getPlayerSession();

		expect(result).toEqual(responseBody);
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/auth\/session$/), {
			credentials: 'include'
		});
	});

	it('logs out player with POST and credentials', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

		await expect(logoutPlayer()).resolves.toBeUndefined();

		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/auth\/logout$/), {
			method: 'POST',
			credentials: 'include'
		});
	});

	it('builds Google login URL with encoded returnTo', () => {
		const url = getGoogleLoginUrl('/puzzle/abc 123?tab=play&next=/');
		const expectedReturnTo = new URL(
			'/puzzle/abc 123?tab=play&next=/',
			window.location.origin
		).toString();
		const expectedUrl =
			`http://localhost:3999/api/auth/google/start?returnTo=` +
			encodeURIComponent(expectedReturnTo);

		expect(url).toBe(expectedUrl);
	});

	it('returns unmodified returnTo when it does not start with /', () => {
		const url = getGoogleLoginUrl('https://other.com/path');
		expect(url).toBe(
			'http://localhost:3999/api/auth/google/start?returnTo=https%3A%2F%2Fother.com%2Fpath'
		);
	});

	it('returns unmodified returnTo when it starts with //', () => {
		const url = getGoogleLoginUrl('//evil.com');
		expect(url).toBe('http://localhost:3999/api/auth/google/start?returnTo=%2F%2Fevil.com');
	});

	it('falls back to returnTo when URL construction throws', () => {
		const originalURL = globalThis.URL;
		vi.stubGlobal(
			'URL',
			class extends URL {
				constructor(href: string, base?: string | URL) {
					super(href, base);
					if (href === '/will-throw') {
						throw new Error('Invalid URL');
					}
				}
			}
		);
		try {
			const url = getGoogleLoginUrl('/will-throw');
			expect(url).toBe('http://localhost:3999/api/auth/google/start?returnTo=%2Fwill-throw');
		} finally {
			vi.stubGlobal('URL', originalURL);
		}
	});
});

// ─── player allowlist ────────────────────────────────────────────────────────

describe('API Service - player allowlist', () => {
	const entry = {
		email: 'player@example.com',
		createdAt: 1779530400000,
		addedBy: 'admin'
	};

	it('fetches player allowlist entries with credentials', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ entries: [entry] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await fetchPlayerAllowlist();

		expect(result).toEqual([entry]);
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/admin\/player-allowlist$/), {
			credentials: 'include'
		});
	});

	it('adds a player allowlist entry with JSON body and credentials', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ entry }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await addPlayerAllowlistEntry('player@example.com');

		expect(result).toEqual(entry);
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/admin\/player-allowlist$/), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ email: 'player@example.com' })
		});
	});

	it('removes a player allowlist entry with encoded email and credentials', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

		await expect(removePlayerAllowlistEntry('player+test@example.com')).resolves.toBeUndefined();

		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/admin\/player-allowlist\/player%2Btest%40example\.com$/),
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);
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

describe('player profile service functions', () => {
	it('getPlayerProfile GETs /api/player/profile', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						id: 'p1',
						email: 'e',
						name: 'N',
						picture: null,
						createdAt: 1,
						lastLoginAt: 2,
						summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
					}),
					{ status: 200 }
				)
			)
		);
		const profile = await getPlayerProfile();
		expect(profile.name).toBe('N');
		expect(vi.mocked(fetch)).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/player\/profile$/),
			{ credentials: 'include' }
		);
	});

	it('updatePlayerProfile PATCHes with credentials', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
		await updatePlayerProfile({ displayName: 'X' });
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/api\/player\/profile$/),
			expect.objectContaining({ method: 'PATCH', credentials: 'include' })
		);
	});

	it('uploadPlayerAvatar POSTs FormData', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ avatarUrl: '/api/player/p1/avatar' }), {
					status: 200
				})
			)
		);
		const file = new File(['x'], 'a.png', { type: 'image/png' });
		const result = await uploadPlayerAvatar(file);
		expect(result.avatarUrl).toContain('p1');
		const calls = vi.mocked(fetch).mock.calls;
		const init = calls[0]?.[1] as RequestInit;
		expect(init.body).toBeInstanceOf(FormData);
	});

	it('getPlayerPuzzles appends cursor/limit', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: [], nextCursor: undefined }), {
					status: 200
				})
			)
		);
		await getPlayerPuzzles({ limit: 5, cursor: '1000|abc' });
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toMatch(/limit=5/);
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toMatch(/cursor=1000%7Cabc/);
	});

	it('getPlayerPuzzles with no params requests /api/player/puzzles without query string', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: [], nextCursor: undefined }), {
					status: 200
				})
			)
		);
		await getPlayerPuzzles();
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toMatch(/\/api\/player\/puzzles$/);
	});

	it('getPlayerPuzzles forwards an explicit limit of 0 (not dropped by a truthy check)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: [], nextCursor: undefined }), {
					status: 200
				})
			)
		);
		await getPlayerPuzzles({ limit: 0 });
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toMatch(/limit=0/);
	});

	it('getPlayerStats forwards an explicit limit of 0', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ stats: [] }), { status: 200 }))
		);
		await getPlayerStats({ limit: 0 });
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toMatch(/limit=0/);
	});

	it('getPlayerStats GETs /api/player/stats', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ stats: [] }), { status: 200 }))
		);
		const { stats } = await getPlayerStats();
		expect(stats).toEqual([]);
	});

	it('recordCompletion POSTs timeSeconds', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
		await recordCompletion('pz1', 90);
		const calls = vi.mocked(fetch).mock.calls;
		const init = calls[0]?.[1] as RequestInit;
		expect(init.body).toBe(JSON.stringify({ timeSeconds: 90 }));
	});

	it('getAvatarUrl builds the path', () => {
		expect(getAvatarUrl('p1')).toMatch(/\/api\/player\/p1\/avatar$/);
	});
});
