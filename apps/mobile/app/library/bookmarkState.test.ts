import { describe, expect, it } from 'vitest';
import {
	getDifficultyPieceCount,
	type PuzzleFamilySummary,
	type PuzzleVariantSummary
} from '@perseus/types';
import {
	applyBookmarkAdd,
	applyBookmarkAddFailure,
	applyBookmarkRemove,
	applyBookmarkRemoveFailure,
	applyBookmarksLoad,
	applyBookmarksLoadFailure,
	beginBookmarksLoad,
	clearBookmarks,
	createBookmarkState,
	setFamilyPending
} from './bookmarkState';

const FAMILY_A = 'fam-a';
const FAMILY_B = 'fam-b';

function familySummary(id: string): PuzzleFamilySummary {
	const variants: Record<'easy' | 'normal' | 'hard', PuzzleVariantSummary> = {
		easy: {
			id: `${id}-easy`,
			difficulty: 'easy',
			pieceCount: getDifficultyPieceCount('4:3', 'easy'),
			status: 'ready'
		},
		normal: {
			id: `${id}-normal`,
			difficulty: 'normal',
			pieceCount: getDifficultyPieceCount('4:3', 'normal'),
			status: 'ready'
		},
		hard: {
			id: `${id}-hard`,
			difficulty: 'hard',
			pieceCount: getDifficultyPieceCount('4:3', 'hard'),
			status: 'ready'
		}
	};
	return {
		id,
		name: `Family ${id}`,
		category: 'Nature',
		aspectRatio: '4:3',
		status: 'ready',
		createdAt: 1716500000000,
		variants
	};
}

describe('createBookmarkState', () => {
	it('starts empty with no loading, error, or pending families', () => {
		expect(createBookmarkState()).toEqual({
			families: [],
			loading: false,
			error: null,
			pendingIds: []
		});
	});
});

describe('clearBookmarks', () => {
	it('returns the empty state regardless of prior bookmark content', () => {
		const state = applyBookmarksLoad(
			setFamilyPending(beginBookmarksLoad(createBookmarkState()), FAMILY_A, true),
			1,
			1,
			[familySummary(FAMILY_A)]
		);
		expect(clearBookmarks()).toEqual(createBookmarkState());
	});
});

describe('beginBookmarksLoad', () => {
	it('sets loading and clears any prior error', () => {
		const failed = applyBookmarksLoadFailure(createBookmarkState(), 1, 1, 'player_api_http_503');
		expect(beginBookmarksLoad(failed)).toEqual({
			families: [],
			loading: true,
			error: null,
			pendingIds: []
		});
	});
});

describe('applyBookmarksLoad', () => {
	it('replaces families and clears loading', () => {
		const state = beginBookmarksLoad(createBookmarkState());
		const loaded = applyBookmarksLoad(state, 3, 3, [familySummary(FAMILY_A)]);
		expect(loaded.families).toEqual([familySummary(FAMILY_A)]);
		expect(loaded.loading).toBe(false);
		expect(loaded.error).toBe(null);
	});

	it('preserves pending markers for toggles still in flight', () => {
		const state = setFamilyPending(beginBookmarksLoad(createBookmarkState()), FAMILY_A, true);
		const loaded = applyBookmarksLoad(state, 1, 1, [familySummary(FAMILY_B)]);
		expect(loaded.pendingIds).toEqual([FAMILY_A]);
	});

	it('ignores a stale load result and returns the prior state unchanged', () => {
		const state = beginBookmarksLoad(createBookmarkState());
		const stale = applyBookmarksLoad(state, 2, 3, [familySummary(FAMILY_A)]);
		expect(stale).toBe(state);
	});
});

describe('applyBookmarksLoadFailure', () => {
	it('clears loading and records the bookmark error', () => {
		const state = beginBookmarksLoad(createBookmarkState());
		const failed = applyBookmarksLoadFailure(state, 1, 1, 'player_api_http_503');
		expect(failed.loading).toBe(false);
		expect(failed.error).toBe('player_api_http_503');
	});

	it('ignores a stale load failure and returns the prior state unchanged', () => {
		const state = beginBookmarksLoad(createBookmarkState());
		expect(applyBookmarksLoadFailure(state, 2, 3, 'player_api_http_503')).toBe(state);
	});
});

describe('setFamilyPending', () => {
	it('tracks pending per family without touching other families', () => {
		let state = setFamilyPending(createBookmarkState(), FAMILY_A, true);
		expect(state.pendingIds).toEqual([FAMILY_A]);
		state = setFamilyPending(state, FAMILY_B, true);
		expect(state.pendingIds).toEqual([FAMILY_A, FAMILY_B]);
		state = setFamilyPending(state, FAMILY_A, false);
		expect(state.pendingIds).toEqual([FAMILY_B]);
	});

	it('does not duplicate an already-pending family', () => {
		const state = setFamilyPending(createBookmarkState(), FAMILY_A, true);
		expect(setFamilyPending(state, FAMILY_A, true)).toBe(state);
	});
});

describe('applyBookmarkAdd', () => {
	it('inserts the family, clears its pending marker, and clears the error', () => {
		let state = setFamilyPending(
			applyBookmarksLoadFailure(createBookmarkState(), 1, 1, 'player_api_http_503'),
			FAMILY_A,
			true
		);
		state = applyBookmarkAdd(state, 2, 2, familySummary(FAMILY_A));
		expect(state.families).toEqual([familySummary(FAMILY_A)]);
		expect(state.pendingIds).toEqual([]);
		expect(state.error).toBe(null);
	});

	it('prepends a new family ahead of the existing newest-first bookmarks', () => {
		const state = applyBookmarksLoad(createBookmarkState(), 1, 1, [familySummary(FAMILY_A)]);
		const added = applyBookmarkAdd(
			setFamilyPending(state, FAMILY_B, true),
			1,
			1,
			familySummary(FAMILY_B)
		);
		expect(added.families.map((entry) => entry.id)).toEqual([FAMILY_B, FAMILY_A]);
		expect(added.pendingIds).toEqual([]);
	});

	it('inserts a family only once when it is already bookmarked', () => {
		const state = applyBookmarksLoad(createBookmarkState(), 1, 1, [familySummary(FAMILY_A)]);
		const added = applyBookmarkAdd(
			setFamilyPending(state, FAMILY_A, true),
			1,
			1,
			familySummary(FAMILY_A)
		);
		expect(added.families).toEqual([familySummary(FAMILY_A)]);
		expect(added.pendingIds).toEqual([]);
	});

	it('ignores a stale add result and returns the prior state unchanged', () => {
		const state = setFamilyPending(createBookmarkState(), FAMILY_A, true);
		expect(applyBookmarkAdd(state, 2, 3, familySummary(FAMILY_A))).toBe(state);
	});
});

describe('applyBookmarkAddFailure', () => {
	it('preserves previous family membership, clears pending, and records the error', () => {
		const state = applyBookmarksLoad(createBookmarkState(), 1, 1, [familySummary(FAMILY_A)]);
		const failed = applyBookmarkAddFailure(
			setFamilyPending(state, FAMILY_B, true),
			1,
			1,
			FAMILY_B,
			'bookmark_limit_reached'
		);
		expect(failed.families).toEqual([familySummary(FAMILY_A)]);
		expect(failed.pendingIds).toEqual([]);
		expect(failed.error).toBe('bookmark_limit_reached');
	});

	it('ignores a stale add failure and returns the prior state unchanged', () => {
		const state = setFamilyPending(createBookmarkState(), FAMILY_A, true);
		expect(applyBookmarkAddFailure(state, 2, 3, FAMILY_A, 'player_api_http_409')).toBe(state);
	});
});

describe('applyBookmarkRemove', () => {
	it('deletes only the target family and clears its pending marker', () => {
		const state = applyBookmarksLoad(createBookmarkState(), 1, 1, [
			familySummary(FAMILY_A),
			familySummary(FAMILY_B)
		]);
		const removed = applyBookmarkRemove(setFamilyPending(state, FAMILY_A, true), 1, 1, FAMILY_A);
		expect(removed.families).toEqual([familySummary(FAMILY_B)]);
		expect(removed.pendingIds).toEqual([]);
		expect(removed.error).toBe(null);
	});

	it('ignores a stale remove result and returns the prior state unchanged', () => {
		const state = applyBookmarksLoad(createBookmarkState(), 1, 1, [familySummary(FAMILY_A)]);
		expect(applyBookmarkRemove(state, 2, 3, FAMILY_A)).toBe(state);
	});
});

describe('applyBookmarkRemoveFailure', () => {
	it('keeps the family bookmarked, clears pending, and records the error', () => {
		const state = applyBookmarksLoad(createBookmarkState(), 1, 1, [familySummary(FAMILY_A)]);
		const failed = applyBookmarkRemoveFailure(
			setFamilyPending(state, FAMILY_A, true),
			1,
			1,
			FAMILY_A,
			'player_api_http_503'
		);
		expect(failed.families).toEqual([familySummary(FAMILY_A)]);
		expect(failed.pendingIds).toEqual([]);
		expect(failed.error).toBe('player_api_http_503');
	});

	it('ignores a stale remove failure and returns the prior state unchanged', () => {
		const state = setFamilyPending(createBookmarkState(), FAMILY_A, true);
		expect(applyBookmarkRemoveFailure(state, 2, 3, FAMILY_A, 'player_api_http_503')).toBe(state);
	});
});
