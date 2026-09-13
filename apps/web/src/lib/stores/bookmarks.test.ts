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
		// Newest-first list: the fresh bookmark slots to the front and the
		// existing order is preserved behind it.
		expect(get(store)).toMatchObject({
			families: [familyTwo, familyOne],
			ids: ['fam-2', 'fam-1'],
			pendingIds: [],
			error: null
		});
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
		const second = store.toggle(family);

		expect(bookmarkFamily).toHaveBeenCalledOnce();

		pendingBookmark.resolve();
		await Promise.all([first, second]);

		expect(bookmarkFamily).toHaveBeenCalledOnce();
		expect(get(store)).toMatchObject({
			ids: ['fam-1'],
			families: [family],
			pendingIds: [],
			error: null
		});
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

		expect(get(store)).toMatchObject({ ids: ['fam-2', 'fam-1'], pendingIds: [] });
	});

	it('starts a toggle mutation only after an in-flight load resolves', async () => {
		const familyOne = makeFamily('fam-1');
		const pendingLoad = deferred<PlayerBookmarkListResponse>();
		vi.mocked(getPlayerBookmarks).mockReturnValueOnce(pendingLoad.promise);
		vi.mocked(bookmarkFamily).mockResolvedValue(undefined);
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));

		const loadPromise = store.load();
		const togglePromise = store.toggle(makeFamily('fam-2'));

		// The PUT must wait for the GET: issuing it early would let the load
		// result land later and overwrite the mutation.
		expect(bookmarkFamily).not.toHaveBeenCalled();
		pendingLoad.resolve({ families: [familyOne] });
		await Promise.all([loadPromise, togglePromise]);

		expect(bookmarkFamily).toHaveBeenCalledOnce();
		expect(get(store)).toMatchObject({ ids: ['fam-2', 'fam-1'], pendingIds: [] });
	});

	it('discards a GET that resolves after a completed mutation and refetches', async () => {
		const familyOne = makeFamily('fam-1');
		const familyTwo = makeFamily('fam-2');
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));

		// Initial load fails, leaving the store unloaded so a later load can run.
		vi.mocked(getPlayerBookmarks).mockRejectedValueOnce(new Error('offline'));
		await store.load();
		expect(get(store).status).toBe('error');

		// Toggle starts while no load is in flight; its PUT stays pending.
		const pendingPut = deferred<void>();
		vi.mocked(bookmarkFamily).mockReturnValueOnce(pendingPut.promise);
		const togglePromise = store.toggle(familyTwo);
		expect(bookmarkFamily).toHaveBeenCalledOnce();

		// A fresh load starts (route mount/retry) and its GET stays pending until
		// after the PUT completes, so its snapshot cannot include the new bookmark.
		const staleGet = deferred<PlayerBookmarkListResponse>();
		vi.mocked(getPlayerBookmarks)
			.mockReturnValueOnce(staleGet.promise)
			.mockResolvedValueOnce({ families: [familyOne, familyTwo] });
		const reloadPromise = store.load();

		pendingPut.resolve();
		await togglePromise;
		staleGet.resolve({ families: [familyOne] });
		await reloadPromise;

		// The stale snapshot was discarded and a second GET reissued; the final
		// families include the PUT.
		expect(getPlayerBookmarks).toHaveBeenCalledTimes(3);
		expect(get(store)).toMatchObject({
			status: 'loaded',
			families: [familyOne, familyTwo],
			ids: ['fam-1', 'fam-2'],
			error: null
		});
	});

	it('keeps pendingIds when a load result lands while a toggle is in flight', async () => {
		const familyOne = makeFamily('fam-1');
		const familyTwo = makeFamily('fam-2');
		const store = createBookmarksStore(writable(makeAuth({ id: 'player-1' })));

		vi.mocked(getPlayerBookmarks).mockRejectedValueOnce(new Error('offline'));
		await store.load();

		const pendingPut = deferred<void>();
		vi.mocked(bookmarkFamily).mockReturnValueOnce(pendingPut.promise);
		const togglePromise = store.toggle(familyTwo);
		expect(get(store).pendingIds).toEqual(['fam-2']);

		// A load resolves while the PUT is still in flight; it must not wipe the
		// pending marker or the same family could double-submit.
		const pendingLoad = deferred<PlayerBookmarkListResponse>();
		vi.mocked(getPlayerBookmarks).mockReturnValueOnce(pendingLoad.promise);
		const reloadPromise = store.load();
		pendingLoad.resolve({ families: [familyOne] });
		await reloadPromise;

		expect(get(store)).toMatchObject({ families: [familyOne], pendingIds: ['fam-2'] });

		pendingPut.resolve();
		await togglePromise;
		expect(get(store)).toMatchObject({ ids: ['fam-2', 'fam-1'], pendingIds: [] });
	});

	it('keeps loaded bookmarks through a transient auth refresh for the same account', async () => {
		const family = makeFamily('fam-1');
		vi.mocked(getPlayerBookmarks).mockResolvedValue({ families: [family] });
		const auth = writable(makeAuth({ id: 'player-1' }));
		const store = createBookmarksStore(auth);
		await store.load();

		// playerAuth.refresh() emits {status:'loading', user:null} mid-refresh;
		// that must not be treated as a logout for the tracked account.
		auth.set({ status: 'loading', user: null, error: null });
		expect(get(store)).toMatchObject({ accountId: 'player-1', status: 'loaded', ids: ['fam-1'] });

		auth.set(makeAuth({ id: 'player-1' }));
		expect(get(store)).toMatchObject({ accountId: 'player-1', status: 'loaded', ids: ['fam-1'] });

		await store.load();
		expect(getPlayerBookmarks).toHaveBeenCalledOnce();
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

	it('drops a toggle issued under an account that changes during an in-flight load', async () => {
		const auth = writable(makeAuth({ id: 'player-1' }));
		const pendingLoad = deferred<PlayerBookmarkListResponse>();
		vi.mocked(getPlayerBookmarks).mockReturnValue(pendingLoad.promise);
		const store = createBookmarksStore(auth);

		const loadPromise = store.load();
		const togglePromise = store.toggle(makeFamily('fam-1'));
		// The account switches while the GET the toggle is serialized behind
		// is still in flight; the queued mutation must never reach the API.
		auth.set(makeAuth({ id: 'player-2' }));
		pendingLoad.resolve({ families: [] });
		await Promise.all([loadPromise, togglePromise]);

		expect(bookmarkFamily).not.toHaveBeenCalled();
		expect(unbookmarkFamily).not.toHaveBeenCalled();
		expect(get(store)).toMatchObject({ accountId: 'player-2', pendingIds: [], ids: [] });
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
