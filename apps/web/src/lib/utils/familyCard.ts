import {
	getDifficultyPieceCount,
	PUZZLE_CATEGORIES,
	PUZZLE_DIFFICULTIES,
	type PuzzleFamilySummary
} from '@perseus/types';
import type { PlayerOwnedFamilySummary } from '$lib/types/puzzle';

function isKnownCategory(category: string): boolean {
	return (PUZZLE_CATEGORIES as readonly string[]).includes(category);
}

/** Build a gallery card family from a player-owned row (no variant ids from API). */
export function ownedFamilyToGalleryFamily(family: PlayerOwnedFamilySummary): PuzzleFamilySummary {
	const variants = {} as PuzzleFamilySummary['variants'];
	for (const difficulty of PUZZLE_DIFFICULTIES) {
		variants[difficulty] = {
			id: family.id,
			difficulty,
			pieceCount: getDifficultyPieceCount(family.aspectRatio, difficulty),
			status: family.status
		};
	}
	return {
		id: family.id,
		name: family.name,
		aspectRatio: family.aspectRatio,
		status: family.status,
		createdAt: family.createdAt,
		...(family.category && isKnownCategory(family.category) ? { category: family.category } : {}),
		variants
	};
}
