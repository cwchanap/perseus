import { PUZZLE_CATEGORIES } from '@perseus/types';
import type { PuzzleCategory } from '@perseus/types';

export { PUZZLE_CATEGORIES };
export type { PuzzleCategory };

export const CATEGORY_ALL = 'All' as const;

export const CATEGORY_COLORS: Record<PuzzleCategory, string> = {
	Animals: 'bg-amber-100 text-amber-800',
	Nature: 'bg-green-100 text-green-800',
	Art: 'bg-purple-100 text-purple-800',
	Architecture: 'bg-slate-100 text-slate-800',
	Abstract: 'bg-pink-100 text-pink-800',
	Food: 'bg-orange-100 text-orange-800',
	Travel: 'bg-sky-100 text-sky-800'
};
