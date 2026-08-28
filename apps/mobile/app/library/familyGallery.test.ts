import { describe, expect, it } from 'vitest';
import {
	getDifficultyPieceCount,
	PUZZLE_DIFFICULTIES,
	type PuzzleFamilySummary
} from '@perseus/types';
import { getDifficultyLabel, selectVariantId } from './familyGallery';

const FAMILY_ID = '123e4567-e89b-42d3-a456-426614174000';
const EASY_VARIANT_ID = '223e4567-e89b-42d3-a456-426614174001';
const NORMAL_VARIANT_ID = '323e4567-e89b-42d3-a456-426614174002';
const HARD_VARIANT_ID = '423e4567-e89b-42d3-a456-426614174003';

function makeFamily(overrides: Partial<PuzzleFamilySummary> = {}): PuzzleFamilySummary {
	const aspectRatio = '4:3';
	return {
		id: FAMILY_ID,
		name: 'Mountain Vista',
		category: 'Nature',
		aspectRatio,
		status: 'ready',
		createdAt: 1716500000000,
		variants: {
			easy: {
				id: EASY_VARIANT_ID,
				difficulty: 'easy',
				pieceCount: getDifficultyPieceCount(aspectRatio, 'easy'),
				status: 'ready'
			},
			normal: {
				id: NORMAL_VARIANT_ID,
				difficulty: 'normal',
				pieceCount: getDifficultyPieceCount(aspectRatio, 'normal'),
				status: 'ready'
			},
			hard: {
				id: HARD_VARIANT_ID,
				difficulty: 'hard',
				pieceCount: getDifficultyPieceCount(aspectRatio, 'hard'),
				status: 'ready'
			}
		},
		...overrides
	};
}

describe('familyGallery helpers', () => {
	it('maps each difficulty to its display label', () => {
		expect(getDifficultyLabel('easy')).toBe('Easy');
		expect(getDifficultyLabel('normal')).toBe('Normal');
		expect(getDifficultyLabel('hard')).toBe('Hard');
	});

	it('returns the concrete variant id for a family difficulty', () => {
		const family = makeFamily();

		for (const difficulty of PUZZLE_DIFFICULTIES) {
			const expectedId =
				difficulty === 'easy'
					? EASY_VARIANT_ID
					: difficulty === 'normal'
						? NORMAL_VARIANT_ID
						: HARD_VARIANT_ID;
			expect(selectVariantId(family, difficulty)).toBe(expectedId);
		}
	});

	it('does not return the family id when selecting a variant', () => {
		const family = makeFamily();

		for (const difficulty of PUZZLE_DIFFICULTIES) {
			expect(selectVariantId(family, difficulty)).not.toBe(FAMILY_ID);
		}
	});
});
