import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	selectEntries,
	imagePathFor,
	mimeForPath,
	fetchExistingNames,
	uploadWithRetry,
	validateCatalog,
	cmdUpload,
	retryConfig,
	parseImageDimensions,
	aspectRatiosMatch,
	accessAppFor,
	adminUiFor,
	tokenBasenameFor,
	FatalError,
	type CatalogEntry,
	type Options
} from './admin-bulk-upload-startup';

function makeOptions(overrides: Partial<Options> = {}): Options {
	return {
		command: 'upload',
		server: 'http://localhost:3000',
		passkey: 'test-passkey',
		catalogPath: '/dev/null',
		imagesDir: '/dev/null',
		tokenCachePath: '/dev/null',
		dryRun: false,
		from: 1,
		to: 70,
		delayMs: 0,
		skipAccess: true,
		...overrides
	};
}

function makeEntry(id: string, name: string): CatalogEntry {
	return {
		id,
		name,
		category: 'Nature',
		aspectRatio: '1:1',
		pieceCount: 100
	};
}

const CATALOG: CatalogEntry[] = [
	makeEntry('01', 'Alpha'),
	makeEntry('02', 'Beta'),
	makeEntry('03', 'Gamma'),
	makeEntry('04', 'Delta'),
	makeEntry('05', 'Epsilon')
];

describe('selectEntries', () => {
	it('filters by from/to range', () => {
		const selected = selectEntries(CATALOG, makeOptions({ from: 2, to: 4 }));
		expect(selected.map((e) => e.id)).toEqual(['02', '03', '04']);
	});

	it('returns all when to is MAX_SAFE_INTEGER', () => {
		const selected = selectEntries(CATALOG, makeOptions({ from: 1, to: Number.MAX_SAFE_INTEGER }));
		expect(selected).toHaveLength(5);
	});

	it('applies limit after filtering', () => {
		const selected = selectEntries(CATALOG, makeOptions({ from: 1, to: 5, limit: 2 }));
		expect(selected.map((e) => e.id)).toEqual(['01', '02']);
	});

	it('returns empty when range matches nothing', () => {
		const selected = selectEntries(CATALOG, makeOptions({ from: 10, to: 20 }));
		expect(selected).toHaveLength(0);
	});

	it('limit greater than filtered count returns all filtered', () => {
		const selected = selectEntries(CATALOG, makeOptions({ from: 1, to: 3, limit: 10 }));
		expect(selected).toHaveLength(3);
	});
});

describe('imagePathFor', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'perseus-test-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('finds a .jpg file by id prefix', () => {
		writeFileSync(join(dir, '01-alpine.jpg'), 'x');
		const result = imagePathFor(makeEntry('01', 'Alpha'), dir);
		expect(result).not.toBeNull();
		expect(result).toContain('01-alpine.jpg');
	});

	it('finds a file without a hyphen suffix (e.g. 01.jpg)', () => {
		writeFileSync(join(dir, '01.jpg'), 'x');
		const result = imagePathFor(makeEntry('01', 'Alpha'), dir);
		expect(result).not.toBeNull();
		expect(result).toContain('01.jpg');
	});

	it('finds .png files, not just .jpg', () => {
		writeFileSync(join(dir, '02-spring.png'), 'x');
		const result = imagePathFor(makeEntry('02', 'Beta'), dir);
		expect(result).not.toBeNull();
		expect(result).toContain('02-spring.png');
	});

	it('finds .webp files', () => {
		writeFileSync(join(dir, '03-ocean.webp'), 'x');
		const result = imagePathFor(makeEntry('03', 'Gamma'), dir);
		expect(result).not.toBeNull();
		expect(result).toContain('03-ocean.webp');
	});

	it('finds .jpeg files', () => {
		writeFileSync(join(dir, '04-sunset.jpeg'), 'x');
		const result = imagePathFor(makeEntry('04', 'Delta'), dir);
		expect(result).not.toBeNull();
		expect(result).toContain('04-sunset.jpeg');
	});

	it('does not match a different id prefix', () => {
		writeFileSync(join(dir, '10-other.jpg'), 'x');
		const result = imagePathFor(makeEntry('01', 'Alpha'), dir);
		expect(result).toBeNull();
	});

	it('returns null when no image exists', () => {
		const result = imagePathFor(makeEntry('99', 'Missing'), dir);
		expect(result).toBeNull();
	});

	it('ignores non-image files', () => {
		writeFileSync(join(dir, '01-readme.txt'), 'x');
		const result = imagePathFor(makeEntry('01', 'Alpha'), dir);
		expect(result).toBeNull();
	});
});

describe('mimeForPath', () => {
	it('returns image/jpeg for .jpg', () => {
		expect(mimeForPath('foo.jpg')).toBe('image/jpeg');
	});

	it('returns image/jpeg for .jpeg', () => {
		expect(mimeForPath('foo.jpeg')).toBe('image/jpeg');
	});

	it('returns image/png for .png', () => {
		expect(mimeForPath('foo.png')).toBe('image/png');
	});

	it('returns image/webp for .webp', () => {
		expect(mimeForPath('foo.webp')).toBe('image/webp');
	});

	it('is case-insensitive', () => {
		expect(mimeForPath('FOO.JPG')).toBe('image/jpeg');
	});

	it('falls back to octet-stream for unknown extensions', () => {
		expect(mimeForPath('foo.gif')).toBe('application/octet-stream');
	});
});

// Build a minimal PNG file header with the given dimensions.
// PNG: 8-byte signature + IHDR chunk (4-byte length + "IHDR" + 4-byte width + 4-byte height + ...)
function minimalPng(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	// PNG signature
	buf[0] = 0x89;
	buf.write('PNG', 1, 'ascii');
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	// IHDR chunk length = 13
	buf.writeUInt32BE(13, 8);
	// "IHDR"
	buf.write('IHDR', 12, 'ascii');
	// width (4 bytes big-endian at offset 16)
	buf.writeUInt32BE(width, 16);
	// height (4 bytes big-endian at offset 20)
	buf.writeUInt32BE(height, 20);
	return buf;
}

describe('parseImageDimensions', () => {
	it('parses PNG dimensions from header bytes', async () => {
		const tmp = join(tmpdir(), `perseus-png-${Date.now()}.png`);
		writeFileSync(tmp, minimalPng(400, 300));
		try {
			const file = Bun.file(tmp);
			const dims = await parseImageDimensions(file, 'image/png');
			expect(dims).toEqual({ width: 400, height: 300 });
		} finally {
			rmSync(tmp, { force: true });
		}
	});

	it('returns null for a truncated PNG header', async () => {
		const tmp = join(tmpdir(), `perseus-png-trunc-${Date.now()}.png`);
		writeFileSync(tmp, Buffer.alloc(10)); // too short
		try {
			const file = Bun.file(tmp);
			const dims = await parseImageDimensions(file, 'image/png');
			expect(dims).toBeNull();
		} finally {
			rmSync(tmp, { force: true });
		}
	});

	it('returns null for unsupported MIME types', async () => {
		const tmp = join(tmpdir(), `perseus-gif-${Date.now()}.gif`);
		writeFileSync(tmp, Buffer.alloc(100));
		try {
			const file = Bun.file(tmp);
			const dims = await parseImageDimensions(file, 'image/gif');
			expect(dims).toBeNull();
		} finally {
			rmSync(tmp, { force: true });
		}
	});
});

describe('aspectRatiosMatch', () => {
	it('matches exact 1:1 ratio', () => {
		expect(aspectRatiosMatch(400, 400, '1:1')).toBe(true);
	});

	it('matches exact 4:3 ratio', () => {
		expect(aspectRatiosMatch(400, 300, '4:3')).toBe(true);
	});

	it('matches 3:4 ratio', () => {
		expect(aspectRatiosMatch(300, 400, '3:4')).toBe(true);
	});

	it('allows 5% tolerance for rounding', () => {
		// 3:4 at 300px wide → 400px tall expected, 398 is within 5%
		expect(aspectRatiosMatch(300, 398, '3:4')).toBe(true);
	});

	it('rejects a clearly wrong ratio', () => {
		expect(aspectRatiosMatch(400, 300, '1:1')).toBe(false);
	});

	it('rejects 16:9 image for 4:3 target', () => {
		expect(aspectRatiosMatch(1920, 1080, '4:3')).toBe(false);
	});
});

describe('accessAppFor', () => {
	it('derives Access app URL from server', () => {
		expect(accessAppFor('https://example.com')).toBe('https://example.com/api/admin');
	});

	it('strips trailing slashes', () => {
		expect(accessAppFor('https://example.com/')).toBe('https://example.com/api/admin');
	});
});

describe('adminUiFor', () => {
	it('derives admin UI URL from server', () => {
		expect(adminUiFor('https://example.com')).toBe('https://example.com/admin');
	});

	it('strips trailing slashes', () => {
		expect(adminUiFor('https://example.com/')).toBe('https://example.com/admin');
	});
});

describe('tokenBasenameFor', () => {
	it('derives token basename from hostname and AUD', () => {
		expect(tokenBasenameFor('https://perseus.cwchanap.dev', 'abc123')).toBe(
			'perseus.cwchanap.dev-abc123-token'
		);
	});

	it('handles server with path', () => {
		expect(tokenBasenameFor('https://example.com/some/path', 'aud')).toBe('example.com-aud-token');
	});
});

describe('fetchExistingNames', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('collects puzzle names from the response', async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						puzzles: [{ name: 'Alpha' }, { name: 'Beta' }, { name: '  Gamma  ' }]
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;

		const names = await fetchExistingNames('http://localhost', {}, 'session=1');
		expect(names.has('Alpha')).toBe(true);
		expect(names.has('Beta')).toBe(true);
		expect(names.has('Gamma')).toBe(true);
		expect(names.size).toBe(3);
	});

	it('throws on non-OK response instead of silently degrading', async () => {
		globalThis.fetch = mock(
			async () => new Response('nope', { status: 401 })
		) as unknown as typeof fetch;

		await expect(fetchExistingNames('http://localhost', {}, 'session=1')).rejects.toThrow(
			/Could not fetch existing puzzles/
		);
	});

	it('throws on network error instead of silently degrading', async () => {
		globalThis.fetch = mock(async () => {
			throw new Error('connection refused');
		}) as unknown as typeof fetch;

		await expect(fetchExistingNames('http://localhost', {}, 'session=1')).rejects.toThrow(
			/connection refused/
		);
	});

	it('skips entries with non-string or empty names', async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						puzzles: [{ name: 'Alpha' }, { name: 123 }, { name: '   ' }, { other: 'x' }]
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;

		const names = await fetchExistingNames('http://localhost', {}, 'session=1');
		expect(names.size).toBe(1);
		expect(names.has('Alpha')).toBe(true);
	});
});

describe('uploadWithRetry', () => {
	const originalFetch = globalThis.fetch;
	const originalSleepFn = retryConfig.sleepFn;

	beforeEach(() => {
		// Avoid real-time backoff sleeps in tests
		retryConfig.sleepFn = async () => {};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		retryConfig.sleepFn = originalSleepFn;
	});

	// Helper: mock fetch that returns empty puzzle list for GET (re-fetch checks
	// between retries) and routes POST to the provided handler. Returns the
	// number of POST calls made.
	function mockFetchPostOnly(postHandler: (postCalls: number) => Promise<Response>): {
		mock: typeof fetch;
		getPostCalls: () => number;
	} {
		let postCalls = 0;
		const fn = mock(async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'GET') {
				return new Response(JSON.stringify({ puzzles: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			postCalls++;
			return postHandler(postCalls);
		}) as unknown as typeof fetch;
		return { mock: fn, getPostCalls: () => postCalls };
	}

	it('returns response immediately on success (201)', async () => {
		const { mock: fn, getPostCalls } = mockFetchPostOnly(
			async () => new Response('ok', { status: 201 })
		);
		globalThis.fetch = fn;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData(), 'Test');
		expect(res.status).toBe(201);
		expect(getPostCalls()).toBe(1);
	});

	it('returns response immediately on 4xx (no retry)', async () => {
		const { mock: fn, getPostCalls } = mockFetchPostOnly(
			async () => new Response('bad', { status: 400 })
		);
		globalThis.fetch = fn;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData(), 'Test');
		expect(res.status).toBe(400);
		expect(getPostCalls()).toBe(1);
	});

	it('retries on 5xx then succeeds', async () => {
		const { mock: fn, getPostCalls } = mockFetchPostOnly(async (n) => {
			if (n < 3) return new Response('err', { status: 500 });
			return new Response('ok', { status: 201 });
		});
		globalThis.fetch = fn;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData(), 'Test');
		expect(res.status).toBe(201);
		expect(getPostCalls()).toBe(3);
	});

	it('throws after exhausting retries on persistent 5xx', async () => {
		const { mock: fn, getPostCalls } = mockFetchPostOnly(
			async () => new Response('err', { status: 503 })
		);
		globalThis.fetch = fn;

		await expect(
			uploadWithRetry('http://localhost', {}, 's=1', new FormData(), 'Test')
		).rejects.toThrow();
		expect(getPostCalls()).toBe(3);
	});

	it('retries on network error then succeeds', async () => {
		const { mock: fn, getPostCalls } = mockFetchPostOnly(async (n) => {
			if (n < 2) throw new Error('ECONNRESET');
			return new Response('ok', { status: 201 });
		});
		globalThis.fetch = fn;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData(), 'Test');
		expect(res.status).toBe(201);
		expect(getPostCalls()).toBe(2);
	});

	it('does not re-POST when the first attempt succeeded but response was lost', async () => {
		// Simulate: POST throws (network error — response lost), but the puzzle
		// was actually created. The re-fetch between retries should find the name
		// and return a synthetic OK instead of re-POSTing (which would duplicate).
		let postCalls = 0;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'GET') {
				return new Response(JSON.stringify({ puzzles: [{ name: 'DuplicateMe' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			postCalls++;
			throw new Error('ECONNRESET');
		}) as unknown as typeof fetch;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData(), 'DuplicateMe');
		expect(res.status).toBe(200);
		expect(postCalls).toBe(1); // only one POST — no retry
		const body = (await res.json()) as { id?: string; status?: string };
		expect(body.id).toBe('verified');
	});
});

describe('validateCatalog', () => {
	const validEntry = (id: string): CatalogEntry => ({
		id,
		name: `Puzzle ${id}`,
		category: 'Nature',
		aspectRatio: '1:1',
		pieceCount: 100
	});

	it('accepts a well-formed catalog', () => {
		const catalog = [validEntry('01'), validEntry('02')];
		expect(validateCatalog(catalog, 'catalog.json')).toEqual(catalog);
	});

	it('rejects a non-array', () => {
		expect(() => validateCatalog({ not: 'array' }, 'catalog.json')).toThrow(/must be a JSON array/);
	});

	it('rejects an empty array', () => {
		expect(() => validateCatalog([], 'catalog.json')).toThrow(/is empty/);
	});

	it('rejects a non-object entry', () => {
		expect(() => validateCatalog(['not-object'], 'catalog.json')).toThrow(/must be an object/);
	});

	it('rejects a missing required field', () => {
		const entry = validEntry('01') as Partial<CatalogEntry>;
		delete entry.name;
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/missing required field: name/);
	});

	it('rejects a wrong-typed field', () => {
		const entry = { ...validEntry('01'), pieceCount: '100' };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(
			/field "pieceCount" must be a number/
		);
	});

	it('rejects a blank string field', () => {
		const entry = { ...validEntry('01'), name: '   ' };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/must not be blank/);
	});

	it('rejects a non-integer pieceCount', () => {
		const entry = { ...validEntry('01'), pieceCount: 100.5 };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/must be an integer/);
	});

	it('rejects a non-positive pieceCount', () => {
		const entry = { ...validEntry('01'), pieceCount: 0 };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/must be positive/);
	});

	it('rejects a pieceCount below the server minimum (1-3)', () => {
		for (const pieceCount of [1, 2, 3]) {
			const entry = { ...validEntry('01'), pieceCount };
			expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/must be at least 4/);
		}
	});

	it('accepts pieceCount exactly 4 (server minimum)', () => {
		const entry = { ...validEntry('01'), pieceCount: 4 };
		expect(validateCatalog([entry], 'catalog.json')).toEqual([entry]);
	});

	it('rejects duplicate ids', () => {
		const catalog = [validEntry('01'), validEntry('01')];
		expect(() => validateCatalog(catalog, 'catalog.json')).toThrow(/duplicate id: 01/);
	});

	it('rejects duplicate names (case-insensitive after trim)', () => {
		const catalog = [
			{ ...validEntry('01'), name: 'Sunset' },
			{ ...validEntry('02'), name: '  Sunset  ' }
		];
		expect(() => validateCatalog(catalog, 'catalog.json')).toThrow(/duplicate name: "Sunset"/);
	});

	it('rejects a non-numeric id', () => {
		const entry = { ...validEntry('01'), id: 'anime-01' };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/non-numeric id "anime-01"/);
	});

	it('accepts zero-padded numeric ids', () => {
		const catalog = [validEntry('01'), validEntry('70')];
		expect(validateCatalog(catalog, 'catalog.json')).toEqual(catalog);
	});

	it('rejects an invalid aspectRatio', () => {
		const entry = { ...validEntry('01'), aspectRatio: '16:9' };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/invalid aspectRatio "16:9"/);
	});

	it('rejects a pieceCount invalid for the aspectRatio', () => {
		const entry = { ...validEntry('01'), pieceCount: 7 };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(
			/pieceCount 7 which is not valid for aspectRatio 1:1/
		);
	});

	it('rejects an invalid category', () => {
		const entry = { ...validEntry('01'), category: 'Space' };
		expect(() => validateCatalog([entry], 'catalog.json')).toThrow(/category "Space"/);
	});
});

describe('cmdUpload', () => {
	const originalFetch = globalThis.fetch;
	const originalSleepFn = retryConfig.sleepFn;
	let tmpDir: string;

	beforeEach(() => {
		retryConfig.sleepFn = async () => {};
		tmpDir = mkdtempSync(join(tmpdir(), 'perseus-cmdupload-'));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		retryConfig.sleepFn = originalSleepFn;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('verifies via re-fetch when uploadWithRetry exhausts retries and the puzzle was actually created', async () => {
		// Setup: write a catalog + image file so cmdUpload can read them.
		const entry = makeEntry('01', 'VerifiedPuzzle');
		const catalogPath = join(tmpDir, 'catalog.json');
		writeFileSync(catalogPath, JSON.stringify([entry]));
		writeFileSync(join(tmpDir, '01-test.jpg'), 'fake-image');

		// Track GET calls to /api/admin/puzzles. The initial fetchExistingNames
		// and the uploadWithRetry between-retry re-fetches should return empty.
		// The final catch-block re-fetch should find the name (puzzle was
		// created server-side but the response was lost on every attempt).
		let getCalls = 0;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/api/admin/login')) {
				return new Response('{"ok":true}', {
					status: 200,
					headers: { 'set-cookie': 'session=abc; Path=/' }
				});
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzles')) {
				getCalls++;
				// The 4th GET is the catch-block verify — return the name.
				// GETs 1-3: initial fetch + 2 between-retry re-fetches (empty).
				if (getCalls === 4) {
					return new Response(JSON.stringify({ puzzles: [{ name: 'VerifiedPuzzle' }] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				}
				return new Response(JSON.stringify({ puzzles: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzles')) {
				// Every POST attempt fails — simulates response lost on all 3 tries.
				throw new Error('ECONNRESET');
			}
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;

		const options = makeOptions({
			catalogPath,
			imagesDir: tmpDir,
			from: 1,
			to: 1,
			skipAccess: true,
			delayMs: 0
		});

		// Should NOT throw — the catch block verifies and marks as OK.
		await cmdUpload(options);
		// 4 GETs: initial + 2 retry re-fetches + 1 catch-block verify
		expect(getCalls).toBe(4);
	});

	it('records failure when catch-block re-fetch does not find the puzzle', async () => {
		const entry = makeEntry('01', 'LostPuzzle');
		const catalogPath = join(tmpDir, 'catalog.json');
		writeFileSync(catalogPath, JSON.stringify([entry]));
		writeFileSync(join(tmpDir, '01-test.jpg'), 'fake-image');

		// All GETs return empty — puzzle was never created, so the catch block
		// cannot verify and must record a failure (FatalError).
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/api/admin/login')) {
				return new Response('{"ok":true}', {
					status: 200,
					headers: { 'set-cookie': 'session=abc; Path=/' }
				});
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzles')) {
				return new Response(JSON.stringify({ puzzles: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzles')) {
				throw new Error('ECONNRESET');
			}
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;

		const options = makeOptions({
			catalogPath,
			imagesDir: tmpDir,
			from: 1,
			to: 1,
			skipAccess: true,
			delayMs: 0
		});

		// cmdUpload throws FatalError when fail > 0.
		await expect(cmdUpload(options)).rejects.toBeInstanceOf(FatalError);
	});

	it('rejects mis-cropped image locally before uploading', async () => {
		// Create a 400x300 (4:3) PNG but request 1:1 aspect ratio — should fail
		// pre-validation without hitting the network.
		const entry = { ...makeEntry('01', 'BadCrop'), aspectRatio: '1:1' };
		const catalogPath = join(tmpDir, 'catalog.json');
		writeFileSync(catalogPath, JSON.stringify([entry]));
		writeFileSync(join(tmpDir, '01-test.png'), minimalPng(400, 300));

		let postCalled = false;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/api/admin/login')) {
				return new Response('{"ok":true}', {
					status: 200,
					headers: { 'set-cookie': 'session=abc; Path=/' }
				});
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzles')) {
				return new Response(JSON.stringify({ puzzles: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzles')) {
				postCalled = true;
				return new Response('ok', { status: 201 });
			}
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;

		const options = makeOptions({
			catalogPath,
			imagesDir: tmpDir,
			from: 1,
			to: 1,
			skipAccess: true,
			delayMs: 0
		});

		await expect(cmdUpload(options)).rejects.toBeInstanceOf(FatalError);

		// Pre-validation should have caught the mismatch — no POST should fire
		expect(postCalled).toBe(false);
	});

	it('rejects oversized image locally before uploading (file size preflight)', async () => {
		// Create an 11MB file — exceeds the 10MB server limit. Should fail
		// pre-validation without hitting the network (no POST, no login).
		const entry = makeEntry('01', 'BigImage');
		const catalogPath = join(tmpDir, 'catalog.json');
		writeFileSync(catalogPath, JSON.stringify([entry]));
		// Write 11MB of zeros with a JPEG magic header so mimeForPath + size
		// checks are realistic.
		const bigBuf = Buffer.alloc(11 * 1024 * 1024);
		bigBuf[0] = 0xff;
		bigBuf[1] = 0xd8;
		bigBuf[2] = 0xff;
		writeFileSync(join(tmpDir, '01-big.jpg'), bigBuf);

		let postCalled = false;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/api/admin/login')) {
				return new Response('{"ok":true}', {
					status: 200,
					headers: { 'set-cookie': 'session=abc; Path=/' }
				});
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzles')) {
				return new Response(JSON.stringify({ puzzles: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzles')) {
				postCalled = true;
				return new Response('ok', { status: 201 });
			}
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;

		const options = makeOptions({
			catalogPath,
			imagesDir: tmpDir,
			from: 1,
			to: 1,
			skipAccess: true,
			delayMs: 0
		});

		// cmdUpload throws FatalError when fail > 0.
		await expect(cmdUpload(options)).rejects.toBeInstanceOf(FatalError);

		// Login still happens (it runs before per-entry processing), but the
		// oversized image must NOT be POSTed — preflight caught it.
		expect(postCalled).toBe(false);
	});

	it('skips entries whose name already exists on the server (idempotency)', async () => {
		// Entry "Alpha" already exists on the server — should be skipped, not re-uploaded.
		// Entry "Beta" does not exist — should be uploaded.
		const catalog = [makeEntry('01', 'Alpha'), makeEntry('02', 'Beta')];
		const catalogPath = join(tmpDir, 'catalog.json');
		writeFileSync(catalogPath, JSON.stringify(catalog));
		writeFileSync(join(tmpDir, '01-alpha.jpg'), 'fake-image');
		writeFileSync(join(tmpDir, '02-beta.jpg'), 'fake-image');

		let postCalled = false;
		let postBody: FormData | undefined;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/api/admin/login')) {
				return new Response('{"ok":true}', {
					status: 200,
					headers: { 'set-cookie': 'session=abc; Path=/' }
				});
			}
			if (init?.method === 'GET' && url.endsWith('/api/admin/puzzles')) {
				// Initial fetch returns Alpha as existing; Beta is not yet there.
				return new Response(JSON.stringify({ puzzles: [{ name: 'Alpha' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			if (init?.method === 'POST' && url.endsWith('/api/admin/puzzles')) {
				postCalled = true;
				postBody = init?.body as FormData;
				return new Response(JSON.stringify({ id: 'new-id', status: 'created' }), {
					status: 201,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;

		const options = makeOptions({
			catalogPath,
			imagesDir: tmpDir,
			from: 1,
			to: 2,
			skipAccess: true,
			delayMs: 0
		});

		await cmdUpload(options);

		// Only Beta should have been POSTed — Alpha was skipped.
		expect(postCalled).toBe(true);
		expect(postBody).toBeDefined();
		const postedName = postBody!.get('name');
		expect(postedName).toBe('Beta');
	});

	it('dry-run lists entries without logging in or uploading', async () => {
		const catalog = [makeEntry('01', 'Alpha'), makeEntry('02', 'Beta')];
		const catalogPath = join(tmpDir, 'catalog.json');
		writeFileSync(catalogPath, JSON.stringify(catalog));
		writeFileSync(join(tmpDir, '01-alpha.jpg'), 'fake-image');
		// Entry 02 has no image — dry-run should report MISSING.

		let fetchCalled = false;
		globalThis.fetch = mock(async () => {
			fetchCalled = true;
			return new Response('should not be called', { status: 500 });
		}) as unknown as typeof fetch;

		const options = makeOptions({
			catalogPath,
			imagesDir: tmpDir,
			from: 1,
			to: 2,
			skipAccess: true,
			delayMs: 0,
			dryRun: true
		});

		// Should NOT throw — dry-run does not upload, so no failures.
		await cmdUpload(options);

		// Dry-run must not make any network requests (no login, no fetch, no upload).
		expect(fetchCalled).toBe(false);
	});

	it('throws FatalError when admin login fails', async () => {
		const entry = makeEntry('01', 'Alpha');
		const catalogPath = join(tmpDir, 'catalog.json');
		writeFileSync(catalogPath, JSON.stringify([entry]));
		writeFileSync(join(tmpDir, '01-alpha.jpg'), 'fake-image');

		globalThis.fetch = mock(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith('/api/admin/login')) {
				return new Response(JSON.stringify({ message: 'Invalid passkey' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch;

		const options = makeOptions({
			catalogPath,
			imagesDir: tmpDir,
			from: 1,
			to: 1,
			skipAccess: true,
			delayMs: 0
		});

		// Login failure throws a plain Error (not FatalError) — cmdUpload does
		// not wrap it. The caller (main) catches and exits 1.
		await expect(cmdUpload(options)).rejects.toThrow(/Admin login failed/);
	});
});
