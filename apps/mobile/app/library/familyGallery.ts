import {
	PUZZLE_DIFFICULTIES,
	type PuzzleDifficulty,
	type PuzzleFamilySummary
} from '@perseus/types';

export const DIFFICULTY_LABELS: Record<PuzzleDifficulty, string> = {
	easy: 'Easy',
	normal: 'Normal',
	hard: 'Hard'
};

export function getDifficultyLabel(difficulty: PuzzleDifficulty): string {
	return DIFFICULTY_LABELS[difficulty];
}

export function selectVariantId(family: PuzzleFamilySummary, difficulty: PuzzleDifficulty): string {
	return family.variants[difficulty].id;
}

export const GALLERY_DIFFICULTIES = PUZZLE_DIFFICULTIES;
