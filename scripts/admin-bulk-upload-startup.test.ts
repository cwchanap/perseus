import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	selectEntries,
	imagePathFor,
	mimeForPath,
	fetchExistingNames,
	uploadWithRetry,
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
		category: 'nature',
		aspectRatio: '1:1',
		pieceCount: 100,
		prompt: 'test'
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
		) as typeof fetch;

		const names = await fetchExistingNames('http://localhost', {}, 'session=1');
		expect(names.has('Alpha')).toBe(true);
		expect(names.has('Beta')).toBe(true);
		expect(names.has('Gamma')).toBe(true);
		expect(names.size).toBe(3);
	});

	it('returns empty set on non-OK response', async () => {
		globalThis.fetch = mock(async () => new Response('nope', { status: 401 })) as typeof fetch;

		const names = await fetchExistingNames('http://localhost', {}, 'session=1');
		expect(names.size).toBe(0);
	});

	it('returns empty set on network error', async () => {
		globalThis.fetch = mock(async () => {
			throw new Error('connection refused');
		}) as typeof fetch;

		const names = await fetchExistingNames('http://localhost', {}, 'session=1');
		expect(names.size).toBe(0);
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
		) as typeof fetch;

		const names = await fetchExistingNames('http://localhost', {}, 'session=1');
		expect(names.size).toBe(1);
		expect(names.has('Alpha')).toBe(true);
	});
});

describe('uploadWithRetry', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns response immediately on success (200)', async () => {
		globalThis.fetch = mock(async () => new Response('ok', { status: 200 })) as typeof fetch;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData());
		expect(res.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('returns response immediately on 4xx (no retry)', async () => {
		globalThis.fetch = mock(async () => new Response('bad', { status: 400 })) as typeof fetch;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData());
		expect(res.status).toBe(400);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('retries on 5xx then succeeds', async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			if (calls < 3) return new Response('err', { status: 500 });
			return new Response('ok', { status: 200 });
		}) as typeof fetch;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData());
		expect(res.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
	});

	it('throws after exhausting retries on persistent 5xx', async () => {
		globalThis.fetch = mock(async () => new Response('err', { status: 503 })) as typeof fetch;

		await expect(uploadWithRetry('http://localhost', {}, 's=1', new FormData())).rejects.toThrow();
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
	});

	it('retries on network error then succeeds', async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			if (calls < 2) throw new Error('ECONNRESET');
			return new Response('ok', { status: 200 });
		}) as typeof fetch;

		const res = await uploadWithRetry('http://localhost', {}, 's=1', new FormData());
		expect(res.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});
});
