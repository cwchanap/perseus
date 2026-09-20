import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import type { PlayerStatRow, PuzzleDifficulty } from '@perseus/types';
import { getPlayerStats } from '$lib/services/api';
import { createClearedDifficultiesStore } from './clearedDifficulties';
import type { PlayerAuthState } from './playerAuth';

vi.mock('$lib/services/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/api')>();
	return {
		...actual,
		getPlayerStats: vi.fn()
	};
});

type StatsPage = { stats: PlayerStatRow[]; nextCursor?: string };

function statRow(
	familyId: string,
	difficulty: PuzzleDifficulty,
	totalCompletions = 1
): PlayerStatRow {
	return {
		familyId,
		familyName: `Family ${familyId}`,
		difficulty,
		standardBestTimeSeconds: 90,
		rotationBestTimeSeconds: null,
		totalCompletions,
		firstCompletedAt: 10,
		lastCompletedAt: 20
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

// Manual page promise; when a signal is provided it rejects with AbortError on
// abort, mirroring fetch cancellation.
function deferredPage(signal?: AbortSignal) {
	let resolve!: (page: StatsPage) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<StatsPage>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
		once: true
	});
	return { promise, resolve, reject };
}

// Flush pending microtasks so an in-flight page chain can consume a resolved
// page and issue the next request before assertions run.
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.mocked(getPlayerStats).mockReset();
});

describe('createClearedDifficultiesStore', () => {
	it('publishes an empty map and skips fetching when anonymous', async () => {
		const store = createClearedDifficultiesStore(writable(makeAuth(null)));

		await store.load();

		expect(getPlayerStats).not.toHaveBeenCalled();
		expect(get(store)).toEqual(new Map());
	});

	it('fetches stats and groups account clears by familyId and difficulty', async () => {
		vi.mocked(getPlayerStats).mockResolvedValue({
			stats: [statRow('fam-1', 'easy'), statRow('fam-1', 'hard'), statRow('fam-2', 'normal')]
		});
		const store = createClearedDifficultiesStore(writable(makeAuth({ id: 'player-1' })));

		await store.load();

		expect(getPlayerStats).toHaveBeenCalledOnce();
		expect(get(store)).toEqual(
			new Map([
				['fam-1', new Set<PuzzleDifficulty>(['easy', 'hard'])],
				['fam-2', new Set<PuzzleDifficulty>(['normal'])]
			])
		);
	});

	it('ignores stat rows with totalCompletions <= 0', async () => {
		vi.mocked(getPlayerStats).mockResolvedValue({
			stats: [statRow('fam-1', 'easy', 0), statRow('fam-2', 'normal', 3)]
		});
		const store = createClearedDifficultiesStore(writable(makeAuth({ id: 'player-1' })));

		await store.load();

		expect(get(store)).toEqual(new Map([['fam-2', new Set<PuzzleDifficulty>(['normal'])]]));
	});

	it('requests limit: 100 on every page', async () => {
		const secondPage = deferredPage();
		vi.mocked(getPlayerStats)
			.mockResolvedValueOnce({ stats: [], nextCursor: 'cursor-2' })
			.mockReturnValueOnce(secondPage.promise);
		const store = createClearedDifficultiesStore(writable(makeAuth({ id: 'player-1' })));

		const loadPromise = store.load();
		await flush();

		secondPage.resolve({ stats: [] });
		await loadPromise;

		expect(getPlayerStats).toHaveBeenCalledTimes(2);
		expect(getPlayerStats).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 100 }));
		expect(getPlayerStats).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ limit: 100, cursor: 'cursor-2' })
		);
	});

	it('publishes no partial pages and one complete map when pagination completes', async () => {
		const secondPage = deferredPage();
		vi.mocked(getPlayerStats)
			.mockResolvedValueOnce({ stats: [statRow('fam-1', 'easy')], nextCursor: 'cursor-2' })
			.mockReturnValueOnce(secondPage.promise);
		const store = createClearedDifficultiesStore(writable(makeAuth({ id: 'player-1' })));

		const loadPromise = store.load();
		// The first page resolved but a cursor remains: nothing is published yet.
		await flush();
		expect(get(store)).toEqual(new Map());

		secondPage.resolve({ stats: [statRow('fam-2', 'hard')] });
		await loadPromise;

		expect(get(store)).toEqual(
			new Map([
				['fam-1', new Set<PuzzleDifficulty>(['easy'])],
				['fam-2', new Set<PuzzleDifficulty>(['hard'])]
			])
		);
	});

	it('dedupes in-flight and repeated loads for the same account', async () => {
		const pendingPage = deferredPage();
		vi.mocked(getPlayerStats).mockReturnValue(pendingPage.promise);
		const store = createClearedDifficultiesStore(writable(makeAuth({ id: 'player-1' })));

		const first = store.load();
		const second = store.load();
		expect(getPlayerStats).toHaveBeenCalledOnce();

		pendingPage.resolve({ stats: [statRow('fam-1', 'easy')] });
		await Promise.all([first, second]);

		await store.load();

		expect(getPlayerStats).toHaveBeenCalledOnce();
		expect(get(store)).toEqual(new Map([['fam-1', new Set<PuzzleDifficulty>(['easy'])]]));
	});

	it('clears old account data on logout', async () => {
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [statRow('fam-1', 'easy')] });
		const auth = writable(makeAuth({ id: 'player-1' }));
		const store = createClearedDifficultiesStore(auth);
		await store.load();
		expect(get(store).size).toBe(1);

		auth.set(makeAuth(null));

		expect(get(store)).toEqual(new Map());
	});

	it('clears old data on account switch before new data arrives', async () => {
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [statRow('fam-1', 'easy')] });
		const auth = writable(makeAuth({ id: 'player-1' }));
		const store = createClearedDifficultiesStore(auth);
		await store.load();

		const pendingPage = deferredPage();
		vi.mocked(getPlayerStats).mockReturnValue(pendingPage.promise);
		auth.set(makeAuth({ id: 'player-2' }));
		// Old account data is gone immediately, before the new load completes.
		expect(get(store)).toEqual(new Map());

		const loadPromise = store.load();
		pendingPage.resolve({ stats: [statRow('fam-2', 'hard')] });
		await loadPromise;

		expect(get(store)).toEqual(new Map([['fam-2', new Set<PuzzleDifficulty>(['hard'])]]));
	});

	it('cannot repopulate from a stale old-account response', async () => {
		const pendingPage = deferredPage();
		vi.mocked(getPlayerStats).mockReturnValue(pendingPage.promise);
		const auth = writable(makeAuth({ id: 'player-1' }));
		const store = createClearedDifficultiesStore(auth);

		const loadPromise = store.load();
		auth.set(makeAuth({ id: 'player-2' }));
		pendingPage.resolve({ stats: [statRow('fam-1', 'easy')] });
		await loadPromise;

		expect(get(store)).toEqual(new Map());
	});

	it('aborts the active request chain on identity change', async () => {
		let observedSignal: AbortSignal | undefined;
		vi.mocked(getPlayerStats).mockImplementation((params) => {
			observedSignal = params?.signal;
			return deferredPage(params?.signal).promise;
		});
		const auth = writable(makeAuth({ id: 'player-1' }));
		const store = createClearedDifficultiesStore(auth);

		const loadPromise = store.load();
		expect(observedSignal?.aborted).toBe(false);
		auth.set(makeAuth({ id: 'player-2' }));
		expect(observedSignal?.aborted).toBe(true);

		await loadPromise;
		expect(get(store)).toEqual(new Map());
	});

	it('leaves the published map unchanged on AbortError and stale-version completions', async () => {
		const auth = writable(makeAuth({ id: 'player-1' }));
		const store = createClearedDifficultiesStore(auth);

		// Stale-version completion: the old account's page resolves after the
		// identity switch and must not land.
		const stalePage = deferredPage();
		vi.mocked(getPlayerStats).mockReturnValue(stalePage.promise);
		const staleLoad = store.load();
		auth.set(makeAuth({ id: 'player-2' }));
		stalePage.resolve({ stats: [statRow('fam-1', 'easy')] });
		await staleLoad;
		expect(get(store)).toEqual(new Map());

		// AbortError: the next account's page rejects after a logout; the
		// rejection must not touch the (empty) map either.
		const abortedPage = deferredPage();
		vi.mocked(getPlayerStats).mockReturnValue(abortedPage.promise);
		const abortedLoad = store.load();
		abortedPage.reject(new DOMException('Aborted', 'AbortError'));
		await abortedLoad;
		expect(get(store)).toEqual(new Map());
	});

	it('keeps the map empty and unloaded on failure so a later load can retry', async () => {
		vi.mocked(getPlayerStats).mockRejectedValueOnce(new Error('offline'));
		const store = createClearedDifficultiesStore(writable(makeAuth({ id: 'player-1' })));

		await store.load();
		expect(get(store)).toEqual(new Map());

		vi.mocked(getPlayerStats).mockResolvedValueOnce({ stats: [statRow('fam-1', 'easy')] });
		await store.load();

		expect(getPlayerStats).toHaveBeenCalledTimes(2);
		expect(get(store)).toEqual(new Map([['fam-1', new Set<PuzzleDifficulty>(['easy'])]]));
	});

	it('keeps a loaded map through a transient auth loading for the same account', async () => {
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [statRow('fam-1', 'easy')] });
		const auth = writable(makeAuth({ id: 'player-1' }));
		const store = createClearedDifficultiesStore(auth);
		await store.load();

		// playerAuth.refresh() emits {status:'loading', user:null} mid-flight;
		// that is not a logout and must not clear the loaded map.
		auth.set({ status: 'loading', user: null, error: null });
		expect(get(store)).toEqual(new Map([['fam-1', new Set<PuzzleDifficulty>(['easy'])]]));

		auth.set(makeAuth({ id: 'player-1' }));
		expect(get(store)).toEqual(new Map([['fam-1', new Set<PuzzleDifficulty>(['easy'])]]));

		await store.load();
		expect(getPlayerStats).toHaveBeenCalledOnce();
	});
});
