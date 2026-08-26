import type { PuzzleCategory } from '$lib/constants/categories';
import type { PuzzleStatus, PuzzleSummary } from '$lib/types/puzzle';

export type AdminPuzzleFilters = {
	query: string;
	category: 'all' | PuzzleCategory;
	status: 'all' | PuzzleStatus;
};

export function filterAdminPuzzles(
	puzzles: readonly PuzzleSummary[],
	filters: AdminPuzzleFilters
): PuzzleSummary[] {
	const query = filters.query.trim().toLowerCase();

	return puzzles.filter((puzzle) => {
		const matchesQuery = puzzle.name.toLowerCase().includes(query);
		const matchesCategory = filters.category === 'all' || puzzle.category === filters.category;
		const matchesStatus = filters.status === 'all' || puzzle.status === filters.status;

		return matchesQuery && matchesCategory && matchesStatus;
	});
}

export function pageSlice<T>(
	items: readonly T[],
	pageIndex: number,
	pageSize: number
): {
	page: T[];
	totalPages: number;
	clampedIndex: number;
} {
	if (pageSize <= 0) {
		throw new RangeError('pageSize must be greater than zero');
	}

	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const clampedIndex = Math.min(Math.max(pageIndex, 0), totalPages - 1);
	const start = clampedIndex * pageSize;

	return {
		page: items.slice(start, start + pageSize),
		totalPages,
		clampedIndex
	};
}
