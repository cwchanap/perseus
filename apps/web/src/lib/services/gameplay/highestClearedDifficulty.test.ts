import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PuzzleDifficulty, PuzzleFamilySummary } from '@perseus/types';
import { getStats } from '$lib/services/stats';
import {
	readLocalClearedVariantIds,
	resolveHighestClearedDifficulty,
	resolveHighestClearedForFamilies
} from './highestClearedDifficulty';

vi.mock('$lib/services/stats', () => ({ getStats: vi.fn() }));

function makeFamily(id: string): PuzzleFamilySummary {
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

// Local clears are expressed as explicit variant-id sets; account clears as an
// explicit family -> difficulties map. No localStorage involved.
function localCleared(ids: string[]): ReadonlySet<string> {
	return new Set(ids);
}

function accountCleared(
	entries: ReadonlyArray<readonly [string, PuzzleDifficulty[]]>
): ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>> {
	return new Map(entries.map(([familyId, difficulties]) => [familyId, new Set(difficulties)]));
}

function mockLocalStats(totalByVariantId: Record<string, number>): void {
	vi.mocked(getStats).mockImplementation((puzzleId) =>
		puzzleId in totalByVariantId
			? {
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: totalByVariantId[puzzleId],
					lastCompletedAt: 0,
					lastRecordedRunId: null,
					recordedRunIds: []
				}
			: null
	);
}

beforeEach(() => {
	vi.mocked(getStats).mockReset();
});

describe('resolveHighestClearedDifficulty', () => {
	it('returns null with no local or account clear', () => {
		const family = makeFamily('fam-1');

		expect(resolveHighestClearedDifficulty(family, new Set(), new Map())).toBeNull();
	});

	it('returns Easy for a local Easy clear', () => {
		const family = makeFamily('fam-1');

		expect(resolveHighestClearedDifficulty(family, localCleared(['fam-1-easy']), new Map())).toBe(
			'easy'
		);
	});

	it('returns Normal for a local Normal clear', () => {
		const family = makeFamily('fam-1');

		expect(resolveHighestClearedDifficulty(family, localCleared(['fam-1-normal']), new Map())).toBe(
			'normal'
		);
	});

	it('returns Hard for a local Hard clear', () => {
		const family = makeFamily('fam-1');

		expect(resolveHighestClearedDifficulty(family, localCleared(['fam-1-hard']), new Map())).toBe(
			'hard'
		);
	});

	it('returns Hard when Easy and Hard are locally cleared', () => {
		const family = makeFamily('fam-1');

		expect(
			resolveHighestClearedDifficulty(family, localCleared(['fam-1-easy', 'fam-1-hard']), new Map())
		).toBe('hard');
	});

	it.each(['easy', 'normal', 'hard'] as const)(
		'returns %s for an account-only clear',
		(difficulty) => {
			const family = makeFamily('fam-1');

			expect(
				resolveHighestClearedDifficulty(
					family,
					new Set(),
					accountCleared([['fam-1', [difficulty]]])
				)
			).toBe(difficulty);
		}
	);

	it('chooses the highest when local and account clears differ', () => {
		const family = makeFamily('fam-1');

		// Local Easy + account Hard -> Hard.
		expect(
			resolveHighestClearedDifficulty(
				family,
				localCleared(['fam-1-easy']),
				accountCleared([['fam-1', ['hard']]])
			)
		).toBe('hard');
		// Account Easy + local Hard -> Hard.
		expect(
			resolveHighestClearedDifficulty(
				family,
				localCleared(['fam-1-hard']),
				accountCleared([['fam-1', ['easy']]])
			)
		).toBe('hard');
	});

	it('returns Hard for a Hard-only clear without synthesizing lower clears', () => {
		const family = makeFamily('fam-1');
		const local = localCleared(['fam-1-hard']);

		expect(resolveHighestClearedDifficulty(family, local, new Map())).toBe('hard');
		// A Hard clear never implies Easy or Normal: the lower variant ids are
		// not injected into the local set.
		expect(local.size).toBe(1);
		expect(local.has('fam-1-hard')).toBe(true);
	});
});

describe('readLocalClearedVariantIds', () => {
	it('includes only variants with a positive totalCompletions', () => {
		mockLocalStats({ 'fam-1-easy': 0, 'fam-1-normal': 2, 'fam-2-hard': 1 });
		const families = [makeFamily('fam-1'), makeFamily('fam-2')];

		expect(readLocalClearedVariantIds(families)).toEqual(new Set(['fam-1-normal', 'fam-2-hard']));
	});

	it('returns an empty set when no stats are recorded', () => {
		mockLocalStats({});
		const families = [makeFamily('fam-1')];

		expect(readLocalClearedVariantIds(families)).toEqual(new Set());
	});
});

describe('resolveHighestClearedForFamilies', () => {
	it('maps each family to its highest cleared difficulty across local and account clears', () => {
		mockLocalStats({ 'fam-1-easy': 1 });
		const families = [makeFamily('fam-1'), makeFamily('fam-2'), makeFamily('fam-3')];
		const account = accountCleared([
			['fam-2', ['normal', 'easy']],
			['fam-3', ['hard']]
		]);

		expect(resolveHighestClearedForFamilies(families, account, 0)).toEqual(
			new Map([
				['fam-1', 'easy'],
				['fam-2', 'normal'],
				['fam-3', 'hard']
			])
		);
	});

	it('omits families with no clears and does not synthesize lower clears for a Hard-only clear', () => {
		mockLocalStats({ 'fam-2-hard': 1 });
		const families = [makeFamily('fam-1'), makeFamily('fam-2')];

		expect(resolveHighestClearedForFamilies(families, new Map(), 0)).toEqual(
			new Map([['fam-2', 'hard']])
		);
	});
});
