import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createQuick, openQuick, evictBlobUrls, removeQuick, getReferenceImage } from './index';
import { deleteQuick } from './storage';

async function makeTestImageFile(width = 200, height = 200): Promise<File> {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#f00';
	ctx.fillRect(0, 0, width, height);
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
	return new File([blob], 'test.jpg', { type: 'image/jpeg' });
}

describe('createQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('returns stored puzzle, persisted=true, and seeds blob cache', async () => {
		const file = await makeTestImageFile();
		const result = await createQuick(file, 4, 'Hello');

		expect(result.stored.name).toBe('Hello');
		expect(result.persisted).toBe(true);

		const opened = await openQuick(result.stored.id);
		expect(opened).not.toBeNull();
		expect(opened!.resolvePieceImage(result.stored.pieces[0])).toMatch(/^blob:/);

		evictBlobUrls(result.stored.id);
	});
});

describe('openQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('returns null for unknown ids', async () => {
		expect(await openQuick('q-missing')).toBeNull();
	});

	it('re-renders pieces from imageDataUrl when blob cache is empty', async () => {
		const file = await makeTestImageFile();
		const created = await createQuick(file, 4, 'Reload');
		const id = created.stored.id;

		// Simulate page-reload: drop the in-memory cache.
		evictBlobUrls(id);

		const opened = await openQuick(id);
		expect(opened).not.toBeNull();
		expect(opened!.resolvePieceImage(created.stored.pieces[0])).toMatch(/^blob:/);

		evictBlobUrls(id);
	});

	it('deduplicates concurrent renders for the same id', async () => {
		const file = await makeTestImageFile();
		const created = await createQuick(file, 4, 'Race');
		const id = created.stored.id;

		// Evict so both calls need to re-render.
		evictBlobUrls(id);

		// Fire two concurrent openQuick calls without awaiting either.
		const [openedA, openedB] = await Promise.all([openQuick(id), openQuick(id)]);

		// Both must resolve successfully and share the same URL map —
		// the second call should piggyback on the first's in-flight render
		// rather than producing a separate set of blob URLs.
		const piece0 = created.stored.pieces[0];
		const urlA = openedA!.resolvePieceImage(piece0);
		const urlB = openedB!.resolvePieceImage(piece0);
		expect(urlA).toBe(urlB);

		evictBlobUrls(id);
	});

	it('finds session-only puzzles when storage save failed', async () => {
		// Make every per-puzzle setItem fail to simulate quota exhaustion.
		const original = Storage.prototype.setItem;
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
			this: Storage,
			key: string,
			value: string
		) {
			if (key.startsWith('quickPuzzle:') && key !== 'quickPuzzle:index') {
				throw new DOMException('Quota exceeded', 'QuotaExceededError');
			}
			original.call(this, key, value);
		});

		try {
			const file = await makeTestImageFile();
			const created = await createQuick(file, 4, 'SessionOnly');
			expect(created.persisted).toBe(false);

			const opened = await openQuick(created.stored.id);
			expect(opened).not.toBeNull();
			expect(opened!.stored.name).toBe('SessionOnly');
			expect(opened!.resolvePieceImage(created.stored.pieces[0])).toMatch(/^blob:/);

			// evictBlobUrls preserves session-only metadata so the puzzle remains reopenable.
			evictBlobUrls(created.stored.id);
			const reopened = await openQuick(created.stored.id);
			expect(reopened).not.toBeNull();
			expect(reopened!.stored.name).toBe('SessionOnly');
			expect(reopened!.resolvePieceImage(created.stored.pieces[0])).toMatch(/^blob:/);

			// removeQuick is the explicit kill-switch that drops session-only metadata too.
			removeQuick(created.stored.id);
			expect(await openQuick(created.stored.id)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('getReferenceImage', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('returns the imageDataUrl for a stored puzzle', async () => {
		const file = await makeTestImageFile();
		const created = await createQuick(file, 4, 'Ref');
		const ref = getReferenceImage(created.stored.id);
		expect(ref).toBe(created.stored.imageDataUrl);
		evictBlobUrls(created.stored.id);
	});

	it('returns null for unknown ids', () => {
		expect(getReferenceImage('q-missing')).toBeNull();
	});
});

describe('evictBlobUrls', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('revokes URLs and drops the cache entry', async () => {
		const file = await makeTestImageFile();
		const result = await createQuick(file, 4, 'Cleanup');
		evictBlobUrls(result.stored.id);

		// Subsequent open() must re-render (blobs should be different).
		const reopen1 = await openQuick(result.stored.id);
		const url1 = reopen1!.resolvePieceImage(result.stored.pieces[0]);
		evictBlobUrls(result.stored.id);

		const reopen2 = await openQuick(result.stored.id);
		const url2 = reopen2!.resolvePieceImage(result.stored.pieces[0]);
		expect(url1).not.toBe(url2);
		evictBlobUrls(result.stored.id);

		deleteQuick(result.stored.id);
	});

	it('makes previously-returned resolver throw after eviction', async () => {
		const canvas = new OffscreenCanvas(200, 200);
		canvas.getContext('2d')!.fillRect(0, 0, 200, 200);
		const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
		const file = new File([blob], 'a.jpg', { type: 'image/jpeg' });

		const created = await createQuick(file, 4, 'StaleResolver');
		const opened = await openQuick(created.stored.id);
		const resolver = opened!.resolvePieceImage;
		const firstPiece = created.stored.pieces[0];

		// Before eviction the resolver works.
		expect(resolver(firstPiece)).toMatch(/^blob:/);

		evictBlobUrls(created.stored.id);

		// After eviction the captured resolver should throw, not return a stale URL.
		expect(() => resolver(firstPiece)).toThrow(/unavailable/);
	});
});
