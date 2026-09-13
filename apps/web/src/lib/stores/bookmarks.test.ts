import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import { createBookmarksStore } from './bookmarks';
import { ApiError, bookmarkFamily, getPlayerBookmarks, unbookmarkFamily } from '$lib/services/api';
import type { PlayerAuthState } from './playerAuth';
import type {
	PlayerBookmarkListResponse,
	PuzzleDifficulty,
	PuzzleFamilySummary
} from '@perseus/types';

vi.mock('$lib/services/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/api')>();
	return {
		...actual,
		getPlayerBookmarks: vi.fn(),
		bookmarkFamily: vi.fn(),
		unbookmarkFamily: vi.fn()
	};
});

let nextFamilyId = 0;

function makeFamily(id = `fam-${++nextFamilyId}`): PuzzleFamilySummary {
	const pieceCounts: Record<PuzzleDifficulty, number> = { easy: 12, normal: 48, hard: 108 };
	return {
		id,
		name: `Family ${id}`,
		aspectRatio: '4:3',
		status: 'ready',
		createdAt: 1716500000000,
		variants: {
			easy: { id: `${id}-easy`, difficulty: 'easy', pieceCount: pieceCounts.easy, status: 'ready' },
			normal: {
				id: `${id}-normal`,
				difficulty: 'normal',
				pieceCount: pieceCounts.normal,
				status: 'ready'
			},
			hard: { id: `${id}-hard`, difficulty: 'hard', pieceCount: pieceCounts.hard, status: 'ready' }
		}
	};
}

function makeAuth(user: { id: string } | null): PlayerAuthState {
	return {
		status: user ? 'authenticated' : 'anonymous',
		user: user
			? {
					id: user.id,
					email: `${user.id}@example.com`,
					name: 'Player One',
					createdAt: 1716500000000,
					lastLoginAt: 1716500000000
				}
			: null,
		error: null
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.mocked(getPlayerBookmarks).mockReset();
	vi.mocked(bookmarkFamily).mockReset();
	vi.mocked(unbookmarkFamily).mockReset();
});

describe('createBookmarksStore', () => {
	it('loads bookmarks for the authenticated account', async () => {
		const family = makeFamily('fam-1');
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [family] });
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));

		await store.load();

		expect(getPlayerBookmarks).toHaveBeenCalledOnce();
		expect(get(store)).toEqual({
			accountId: 'player-1',
			status: 'loaded',
			families: [family],
			ids: ['fam-1'],
			error: null,
			pendingIds: []
		});
	});

	it('dedupes in-flight and repeated loads for the same account', async () => {
		const pendingLoad = deferred<PlayerBookmarkListResponse>();
		vi.mocked(getPlayerBookmarks).mockReturnValue(pendingLoad.promise);
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));

		const first = store.load();
		const second = store.load();
		expect(getPlayerBookmarks).toHaveBeenCalledOnce();

		pendingLoad.resolve({ families: [makeFamily('fam-1')] });
		await Promise.all([first, second]);

		await store.load();

		expect(getPlayerBookmarks).toHaveBeenCalledOnce();
		expect(get(store).status).toBe('loaded');
	});

	it('does not fetch when anonymous', async () => {
		const store = createBookmarksStore(writable(makeAuth(null)));

		await store.load();

		expect(getPlayerBookmarks).not.toHaveBeenCalled();
		expect(get(store)).toMatchObject({ accountId: null, status: 'idle', families: [] });
	});

	it('adds a bookmark using the passed family without refetching', async () => {
		const familyOne = makeFamily('fam-1');
		const familyTwo = makeFamily('fam-2');
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [familyOne] });
		vi.mocked(bookmarkFamily).mockResolvedValue(undefined);
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));
		await store.load();

		await store.toggle(familyTwo);

		expect(bookmarkFamily).toHaveBeenCalledOnce();
		expect(bookmarkFamily).toHaveBeenCalledWith('fam-2');
		expect(unbookmarkFamily).not.toHaveBeenCalled();
		expect(getPlayerBookmarks).toHaveBeenCalledOnce();
		expect(get(store)).toMatchObject({ ids: ['fam-1', 'fam-2'], pendingIds: [], error: null });
	});

	it('removes a bookmark on toggle of a bookmarked family', async () => {
		const familyOne = makeFamily('fam-1');
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [familyOne] });
		vi.mocked(unbookmarkFamily).mockResolvedValue(undefined);
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));
		await store.load();

		await store.toggle(familyOne);

		expect(unbookmarkFamily).toHaveBeenCalledOnce();
		expect(unbookmarkFamily).toHaveBeenCalledWith('fam-1');
		expect(bookmarkFamily).not.toHaveBeenCalled();
		expect(get(store)).toMatchObject({ ids: [], pendingIds: [], error: null });
	});

	it('keeps prior membership and surfaces the error when a mutation fails with 409', async () => {
		const familyOne = makeFamily('fam-1');
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [familyOne] });
		vi.mocked(bookmarkFamily).mockRejectedValue(
			new ApiError(409, 'bookmark_limit_reached', 'Maximum 200 bookmarks reached')
		);
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));
		await store.load();

		await store.toggle(makeFamily('fam-2'));

		expect(get(store)).toMatchObject({
			ids: ['fam-1'],
			families: [familyOne],
			pendingIds: [],
			error: 'bookmark_limit_reached'
		});
	});

	it('rejects a second submit for a family that is already pending', async () => {
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [] });
		const pendingBookmark = deferred<void>();
		vi.mocked(bookmarkFamily).mockReturnValue(pendingBookmark.promise);
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));
		await store.load();
		const family = makeFamily('fam-1');

		const first = store.toggle(family);
		await store.toggle(family);

		expect(bookmarkFamily).toHaveBeenCalledOnce();

		pendingBookmark.resolve();
		await first;
		expect(get(store).pendingIds).toEqual([]);
	});

	it('keeps independent families pending concurrently', async () => {
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [] });
		const firstPending = deferred<void>();
		const secondPending = deferred<void>();
		vi.mocked(bookmarkFamily)
			.mockReturnValueOnce(firstPending.promise)
			.mockReturnValueOnce(secondPending.promise);
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));
		await store.load();

		const first = store.toggle(makeFamily('fam-1'));
		const second = store.toggle(makeFamily('fam-2'));

		expect(get(store).pendingIds).toEqual(['fam-1', 'fam-2']);
		expect(bookmarkFamily).toHaveBeenCalledTimes(2);

		firstPending.resolve();
		await first;
		secondPending.resolve();
		await second;

		expect(get(store)).toMatchObject({ ids: ['fam-1', 'fam-2'], pendingIds: [] });
	});

	it('clears old state on logout and reloads fresh state after account switch', async () => {
		const auth = writable(makeAuth({ id: 'player-1' }));
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [makeFamily('fam-1')] });
		const store = createBookmarksStore(auth);
		await store.load();

		auth.set(makeAuth(null));
		expect(get(store)).toEqual({
			accountId: null,
			status: 'idle',
			families: [],
			ids: [],
			error: null,
			pendingIds: []
		});

		auth.set(makeAuth({ id: 'player-2' }));
		expect(get(store).accountId).toBe('player-2');

		await store.load();

		expect(getPlayerBookmarks).toHaveBeenCalledTimes(2);
		expect(get(store)).toMatchObject({ accountId: 'player-2', ids: ['fam-1'] });
	});

	it('ignores a stale load result resolved after an account switch', async () => {
		const auth = writable(makeAuth({ id: 'player-1' }));
		const pendingLoad = deferred<PlayerBookmarkListResponse>();
		vi.mocked(getPlayerBookmarks).mockReturnValue(pendingLoad.promise);
		const store = createBookmarksStore(auth);

		const loadPromise = store.load();
		auth.set(makeAuth({ id: 'player-2' }));
		pendingLoad.resolve({ families: [makeFamily('fam-1')] });
		await loadPromise;

		expect(get(store)).toEqual({
			accountId: 'player-2',
			status: 'idle',
			families: [],
			ids: [],
			error: null,
			pendingIds: []
		});
	});

	it('ignores a stale mutation result resolved after logout', async () => {
		const auth = writable(makeAuth({ id: 'player-1' }));
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [] });
		const pendingBookmark = deferred<void>();
		vi.mocked(bookmarkFamily).mockReturnValue(pendingBookmark.promise);
		const store = createBookmarksStore(auth);
		await store.load();

		const togglePromise = store.toggle(makeFamily('fam-1'));
		auth.set(makeAuth(null));
		pendingBookmark.resolve();
		await togglePromise;

		expect(get(store)).toEqual({
			accountId: null,
			status: 'idle',
			families: [],
			ids: [],
			error: null,
			pendingIds: []
		});
	});
});
