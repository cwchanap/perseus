import { expect } from 'vitest';
import type { PuzzleFamilyMetadata } from '@perseus/types';

export const PIECE_COUNTS_1_1 = { easy: 16, normal: 49, hard: 100 };

export function variantIdsForFamily(familyId: string) {
	return {
		easy: `${familyId}-easy`,
		normal: `${familyId}-normal`,
		hard: `${familyId}-hard`
	};
}

export function makeFamilyMetadata(
	id: string,
	status: PuzzleFamilyMetadata['status'] = 'ready',
	overrides: Partial<PuzzleFamilyMetadata> = {}
): PuzzleFamilyMetadata {
	return {
		id,
		name: `Family ${id}`,
		status,
		createdAt: 1700000000000,
		aspectRatio: '1:1',
		variants: variantIdsForFamily(id),
		...overrides
	};
}

export function cleanupRecordMatcher(familyId: string) {
	return expect.objectContaining({
		familyId,
		variantIds: variantIdsForFamily(familyId),
		pieceCounts: PIECE_COUNTS_1_1
	});
}

export const DELETE_FAMILY_ID = '550e8400-e29b-41d4-a716-446655440000';
