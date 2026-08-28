import { describe, expect, it } from 'vitest';
import type { PuzzleSummary } from '$lib/types/puzzle';
import { filterAdminPuzzles, pageSlice } from './adminPuzzleList';

const puzzles: PuzzleSummary[] = [
	{
		id: 'forest-ready',
		name: 'Forest Trail',
		pieceCount: 100,
		status: 'ready',
		category: 'Nature'
	},
	{
		id: 'forest-processing',
		name: 'Forest River',
		pieceCount: 100,
		status: 'processing',
		category: 'Nature'
	},
	{
		id: 'city-failed',
		name: 'City Lights',
		pieceCount: 100,
		status: 'failed',
		category: 'Architecture'
	},
	{
		id: 'legacy-ready',
		name: 'Legacy Mission',
		pieceCount: 100,
		status: 'ready'
	}
];

describe('filterAdminPuzzles', () => {
	it('trims the query and matches puzzle names case-insensitively', () => {
		const result = filterAdminPuzzles(puzzles, {
			query: '  FoReSt  ',
			category: 'all',
			status: 'all'
		});

		expect(result.map(({ id }) => id)).toEqual(['forest-ready', 'forest-processing']);
	});

	it('combines query, category, and status filters with AND semantics', () => {
		const result = filterAdminPuzzles(puzzles, {
			query: 'forest',
			category: 'Nature',
			status: 'processing'
		});

		expect(result.map(({ id }) => id)).toEqual(['forest-processing']);
	});

	it('excludes an uncategorized legacy puzzle from a concrete category', () => {
		const result = filterAdminPuzzles(puzzles, {
			query: '',
			category: 'Nature',
			status: 'all'
		});

		expect(result.map(({ id }) => id)).toEqual(['forest-ready', 'forest-processing']);
	});

	it('includes an uncategorized legacy puzzle for the all category', () => {
		const result = filterAdminPuzzles(puzzles, {
			query: '',
			category: 'all',
			status: 'all'
		});

		expect(result).toEqual(puzzles);
	});

	it('returns an empty list when no puzzles match', () => {
		const result = filterAdminPuzzles(puzzles, {
			query: 'ocean',
			category: 'all',
			status: 'all'
		});

		expect(result).toEqual([]);
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
