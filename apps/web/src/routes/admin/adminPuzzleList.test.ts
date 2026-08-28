import { describe, expect, it } from 'vitest';
import type { PuzzleFamilySummary } from '@perseus/types';
import { filterAdminPuzzles, formatFamilyPieceCounts, pageSlice } from './adminPuzzleList';

function familySummary(
	id: string,
	overrides: Partial<PuzzleFamilySummary> = {}
): PuzzleFamilySummary {
	return {
		id,
		name: `Family ${id}`,
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1000,
		variants: {
			easy: { id: `${id}-e`, difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: `${id}-n`, difficulty: 'normal', pieceCount: 49, status: 'ready' },
			hard: { id: `${id}-h`, difficulty: 'hard', pieceCount: 100, status: 'ready' }
		},
		...overrides
	};
}

const families: PuzzleFamilySummary[] = [
	familySummary('forest-ready', { name: 'Forest Trail', category: 'Nature' }),
	familySummary('forest-processing', {
		name: 'Forest River',
		status: 'processing',
		category: 'Nature',
		variants: {
			easy: { id: 'forest-processing-e', difficulty: 'easy', pieceCount: 16, status: 'processing' },
			normal: {
				id: 'forest-processing-n',
				difficulty: 'normal',
				pieceCount: 49,
				status: 'processing'
			},
			hard: { id: 'forest-processing-h', difficulty: 'hard', pieceCount: 100, status: 'processing' }
		}
	}),
	familySummary('city-failed', {
		name: 'City Lights',
		status: 'failed',
		category: 'Architecture',
		variants: {
			easy: { id: 'city-failed-e', difficulty: 'easy', pieceCount: 16, status: 'failed' },
			normal: { id: 'city-failed-n', difficulty: 'normal', pieceCount: 49, status: 'failed' },
			hard: { id: 'city-failed-h', difficulty: 'hard', pieceCount: 100, status: 'failed' }
		}
	}),
	familySummary('legacy-ready', { name: 'Legacy Mission' })
];

describe('filterAdminPuzzles', () => {
	it('trims the query and matches family names case-insensitively', () => {
		const result = filterAdminPuzzles(families, {
			query: '  FoReSt  ',
			category: 'all',
			status: 'all'
		});

		expect(result.map(({ id }) => id)).toEqual(['forest-ready', 'forest-processing']);
	});

	it('combines query, category, and status filters with AND semantics', () => {
		const result = filterAdminPuzzles(families, {
			query: 'forest',
			category: 'Nature',
			status: 'processing'
		});

		expect(result.map(({ id }) => id)).toEqual(['forest-processing']);
	});

	it('excludes an uncategorized legacy family from a concrete category', () => {
		const result = filterAdminPuzzles(families, {
			query: '',
			category: 'Nature',
			status: 'all'
		});

		expect(result.map(({ id }) => id)).toEqual(['forest-ready', 'forest-processing']);
	});

	it('includes an uncategorized legacy family for the all category', () => {
		const result = filterAdminPuzzles(families, {
			query: '',
			category: 'all',
			status: 'all'
		});

		expect(result).toEqual(families);
	});

	it('returns an empty list when no families match', () => {
		const result = filterAdminPuzzles(families, {
			query: 'ocean',
			category: 'all',
			status: 'all'
		});

		expect(result).toEqual([]);
	});
});

describe('formatFamilyPieceCounts', () => {
	it('joins easy, normal, and hard piece counts', () => {
		expect(formatFamilyPieceCounts(families[0])).toBe('16 / 49 / 100');
	});
});

describe('pageSlice', () => {
	const items = [1, 2, 3, 4, 5];

	it('returns the first page', () => {
		expect(pageSlice(items, 0, 2)).toEqual({
			page: [1, 2],
			totalPages: 3,
			clampedIndex: 0
		});
	});

	it('returns the final page', () => {
		expect(pageSlice(items, 2, 2)).toEqual({
			page: [5],
			totalPages: 3,
			clampedIndex: 2
		});
	});

	it('clamps an out-of-range page to the final page', () => {
		expect(pageSlice(items, 10, 2)).toEqual({
			page: [5],
			totalPages: 3,
			clampedIndex: 2
		});
	});

	it('returns an empty first page for an empty list', () => {
		expect(pageSlice([], 3, 2)).toEqual({
			page: [],
			totalPages: 1,
			clampedIndex: 0
		});
	});

	it('clamps a negative page to the first page', () => {
		expect(pageSlice(items, -1, 2)).toEqual({
			page: [1, 2],
			totalPages: 3,
			clampedIndex: 0
		});
	});

	it.each([0, -1])('throws for an invalid page size of %s', (pageSize) => {
		expect(() => pageSlice(items, 0, pageSize)).toThrow(RangeError);
	});
});
