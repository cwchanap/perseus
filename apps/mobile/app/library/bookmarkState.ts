// Pure mobile bookmark state: no NativeScript, secure storage, HTTP, or
// Svelte imports. App.svelte owns the single BookmarkState value, captures
// accountEpoch at the start of every bookmark fetch/mutation, and applies
// async results through these transitions. Every apply function receives the
// captured requestEpoch plus the current epoch and returns the prior state
// unchanged when they differ (stale result from a signed-out/account switch).

import type { PuzzleFamilySummary } from '@perseus/types';

export interface BookmarkState {
	families: PuzzleFamilySummary[];
	loading: boolean;
	error: string | null;
	/** Family IDs with an in-flight add/remove request; tracked per family. */
	pendingIds: string[];
}

export function createBookmarkState(): BookmarkState {
	return { families: [], loading: false, error: null, pendingIds: [] };
}

/** Sign-out or account switch: everything resets to the empty state. */
export function clearBookmarks(): BookmarkState {
	return createBookmarkState();
}

export function setFamilyPending(
	state: BookmarkState,
	familyId: string,
	pending: boolean
): BookmarkState {
	if (pending) {
		if (state.pendingIds.includes(familyId)) return state;
		return { ...state, pendingIds: [...state.pendingIds, familyId] };
	}
	if (!state.pendingIds.includes(familyId)) return state;
	return { ...state, pendingIds: state.pendingIds.filter((id) => id !== familyId) };
}

export function beginBookmarksLoad(state: BookmarkState): BookmarkState {
	return { ...state, loading: true, error: null };
}

export function applyBookmarksLoad(
	state: BookmarkState,
	requestEpoch: number,
	currentEpoch: number,
	families: PuzzleFamilySummary[]
): BookmarkState {
	if (requestEpoch !== currentEpoch) return state;
	// Copy: the caller's array must not be mutated behind the state's back.
	return { ...state, families: [...families], loading: false, error: null };
}

export function applyBookmarksLoadFailure(
	state: BookmarkState,
	requestEpoch: number,
	currentEpoch: number,
	error: string
): BookmarkState {
	if (requestEpoch !== currentEpoch) return state;
	return { ...state, loading: false, error };
}

export function applyBookmarkAdd(
	state: BookmarkState,
	requestEpoch: number,
	currentEpoch: number,
	family: PuzzleFamilySummary
): BookmarkState {
	if (requestEpoch !== currentEpoch) return state;
	// GET returns newest-first, so a fresh bookmark slots to the front.
	const families = state.families.some((existing) => existing.id === family.id)
		? state.families
		: [family, ...state.families];
	return setFamilyPending({ ...state, families, error: null }, family.id, false);
}

export function applyBookmarkAddFailure(
	state: BookmarkState,
	requestEpoch: number,
	currentEpoch: number,
	familyId: string,
	error: string
): BookmarkState {
	if (requestEpoch !== currentEpoch) return state;
	// Membership is untouched; only the pending marker clears and the
	// bookmark error records.
	return setFamilyPending({ ...state, error }, familyId, false);
}

export function applyBookmarkRemove(
	state: BookmarkState,
	requestEpoch: number,
	currentEpoch: number,
	familyId: string
): BookmarkState {
	if (requestEpoch !== currentEpoch) return state;
	return setFamilyPending(
		{ ...state, families: state.families.filter((family) => family.id !== familyId), error: null },
		familyId,
		false
	);
}

export function applyBookmarkRemoveFailure(
	state: BookmarkState,
	requestEpoch: number,
	currentEpoch: number,
	familyId: string,
	error: string
): BookmarkState {
	if (requestEpoch !== currentEpoch) return state;
	// A failed removal keeps the family bookmarked; only pending clears and
	// the bookmark error records.
	return setFamilyPending({ ...state, error }, familyId, false);
}
