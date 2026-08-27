import type { PuzzleCategory } from '$lib/constants/categories';
import type { PuzzleStatus } from '$lib/types/puzzle';
import type { PuzzleFamilySummary } from '@perseus/types';
import { PUZZLE_DIFFICULTIES } from '@perseus/types';

export type AdminPuzzleFilters = {
	query: string;
	category: 'all' | PuzzleCategory;
	status: 'all' | PuzzleStatus;
};

export function filterAdminPuzzles(
	families: readonly PuzzleFamilySummary[],
	filters: AdminPuzzleFilters
): PuzzleFamilySummary[] {
	const query = filters.query.trim().toLowerCase();

	return families.filter((family) => {
		const matchesQuery = family.name.toLowerCase().includes(query);
		const matchesCategory = filters.category === 'all' || family.category === filters.category;
		const matchesStatus = filters.status === 'all' || family.status === filters.status;

		return matchesQuery && matchesCategory && matchesStatus;
	});
}

export function formatFamilyPieceCounts(family: PuzzleFamilySummary): string {
	return PUZZLE_DIFFICULTIES.map((difficulty) => family.variants[difficulty].pieceCount).join(
		' / '
	);
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
