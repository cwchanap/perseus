import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { PuzzleFamilySummary } from '@perseus/types';
import { ApiError, bookmarkFamily, getPlayerBookmarks, unbookmarkFamily } from '$lib/services/api';
import { playerAuth, type PlayerAuthState } from './playerAuth';

export interface BookmarksState {
	accountId: string | null;
	status: 'idle' | 'loading' | 'loaded' | 'error';
	families: PuzzleFamilySummary[];
	ids: string[];
	error: string | null;
	pendingIds: string[];
}

const initialState: BookmarksState = {
	accountId: null,
	status: 'idle',
	families: [],
	ids: [],
	error: null,
	pendingIds: []
};

function toErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.error;
	if (error instanceof Error) return error.message;
	return fallback;
}

export function createBookmarksStore(auth: Readable<PlayerAuthState> = playerAuth) {
	const { subscribe, set, update } = writable<BookmarksState>(initialState);
	let state = initialState;
	let currentAccountId: string | null = null;
	let observedAccountId: string | null | undefined = undefined;
	let loadedAccountId: string | null = null;
	let loadPromise: Promise<void> | null = null;
	// Bumped on every identity change/clear; async results captured against it
	// are dropped when it moves on, so old-account responses never land.
	let version = 0;
	// Bumped on every successful mutation; a GET that captured an older value
	// carries a snapshot older than local state and must not be applied.
	let mutationRevision = 0;

	subscribe((value) => {
		state = value;
	});

	// Auth is only observed to detect login/logout/account switches and clear
	// stale bookmark state; fetching stays explicit via load().
	auth.subscribe((authState) => {
		// A refresh emits {status:'loading', user:null} mid-flight; that is not
		// a logout, so keep existing state while an account is still tracked.
		if (authState.status === 'loading' && observedAccountId) return;
		currentAccountId = authState.user?.id ?? null;
		if (observedAccountId !== undefined && observedAccountId === currentAccountId) return;
		observedAccountId = currentAccountId;
		version++;
		loadedAccountId = null;
		loadPromise = null;
		set({ ...initialState, accountId: currentAccountId });
	});

	function stale(at: number): boolean {
		return at !== version;
	}

	return {
		subscribe,
		load(): Promise<void> {
			if (!currentAccountId) return Promise.resolve();
			if (loadedAccountId === currentAccountId) return Promise.resolve();
			if (loadPromise) return loadPromise;

			const at = version;
			const accountId = currentAccountId;
			const runLoad = async (): Promise<void> => {
				update((value) => ({ ...value, status: 'loading', error: null }));
				try {
					const revisionBefore = mutationRevision;
					const response = await getPlayerBookmarks();
					if (stale(at)) return;
					if (mutationRevision !== revisionBefore) {
						// A mutation completed while this GET was in flight, so the
						// snapshot is older than local state: discard it and refetch.
						// Converges — a retry only runs when a mutation landed mid-GET.
						await runLoad();
						return;
					}
					loadedAccountId = accountId;
					set({
						accountId,
						status: 'loaded',
						families: response.families,
						ids: response.families.map((family) => family.id),
						error: null,
						// Pending markers belong to in-flight toggles; a load apply
						// must not clear them or the family could double-submit.
						pendingIds: state.pendingIds
					});
				} catch (error) {
					if (stale(at)) return;
					update((value) => ({
						...value,
						status: 'error',
						error: toErrorMessage(error, 'Failed to load bookmarks')
					}));
				}
			};
			loadPromise = (async () => {
				try {
					await runLoad();
				} finally {
					if (!stale(at)) loadPromise = null;
				}
			})();
			return loadPromise;
		},
		async toggle(family: PuzzleFamilySummary): Promise<void> {
			// Serialize behind an in-flight load: the mutation must start against
			// post-load membership and cannot race a GET that began before it.
			const at = version;
			if (loadPromise) await loadPromise;
			// The account may have changed while the load was in flight; a
			// toggle issued under the old account must not fire against the new
			// one (wasBookmarked below reads the new account's membership).
			if (stale(at)) return;
			if (!currentAccountId || state.pendingIds.includes(family.id)) return;
			const wasBookmarked = state.ids.includes(family.id);
			update((value) => ({
				...value,
				pendingIds: [...value.pendingIds, family.id],
				error: null
			}));

			try {
				if (wasBookmarked) {
					await unbookmarkFamily(family.id);
				} else {
					await bookmarkFamily(family.id);
				}
				if (stale(at)) return;
				mutationRevision++;
				update((value) => {
					// GET returns newest-first, so a fresh bookmark slots to the front.
					const families = wasBookmarked
						? value.families.filter((candidate) => candidate.id !== family.id)
						: [family, ...value.families];
					return {
						...value,
						families,
						ids: families.map((entry) => entry.id),
						pendingIds: value.pendingIds.filter((id) => id !== family.id)
					};
				});
			} catch (error) {
				if (stale(at)) return;
				update((value) => ({
					...value,
					pendingIds: value.pendingIds.filter((id) => id !== family.id),
					error: toErrorMessage(error, 'Failed to update bookmark')
				}));
			}
		},
		clear(): void {
			version++;
			loadedAccountId = null;
			loadPromise = null;
			set({ ...initialState, accountId: currentAccountId });
		}
	};
}

export const bookmarks = createBookmarksStore();
