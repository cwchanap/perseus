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

	subscribe((value) => {
		state = value;
	});

	// Auth is only observed to detect login/logout/account switches and clear
	// stale bookmark state; fetching stays explicit via load().
	auth.subscribe((authState) => {
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
			loadPromise = (async () => {
				update((value) => ({ ...value, status: 'loading', error: null }));
				try {
					const response = await getPlayerBookmarks();
					if (stale(at)) return;
					loadedAccountId = accountId;
					set({
						accountId,
						status: 'loaded',
						families: response.families,
						ids: response.families.map((family) => family.id),
						error: null,
						pendingIds: []
					});
				} catch (error) {
					if (stale(at)) return;
					update((value) => ({
						...value,
						status: 'error',
						error: toErrorMessage(error, 'Failed to load bookmarks')
					}));
				} finally {
					if (!stale(at)) loadPromise = null;
				}
			})();
			return loadPromise;
		},
		async toggle(family: PuzzleFamilySummary): Promise<void> {
			if (!currentAccountId || state.pendingIds.includes(family.id)) return;
			const wasBookmarked = state.ids.includes(family.id);
			const at = version;
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
				update((value) => {
					const families = wasBookmarked
						? value.families.filter((candidate) => candidate.id !== family.id)
						: [...value.families, family];
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
