// Shared "highest cleared difficulty" read model for puzzle families.
//
// A family's cleared difficulty is the hardest variant the player has
// completed either locally (localStorage stats) or on their account
// (player stats). Clears are never inferred downward: clearing Hard does
// not imply Easy or Normal.

import type { PuzzleDifficulty, PuzzleFamilySummary } from '@perseus/types';
import { PUZZLE_DIFFICULTIES } from '@perseus/types';
import { getStats } from '$lib/services/stats';

// Derived once from the canonical tuple and reused for every family.
const CLEAR_RANK_DESC: readonly PuzzleDifficulty[] = [...PUZZLE_DIFFICULTIES].reverse();

export function resolveHighestClearedDifficulty(
	family: PuzzleFamilySummary,
	localClearedVariantIds: ReadonlySet<string>,
	accountClearedByFamily: ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>
): PuzzleDifficulty | null {
	const accountCleared = accountClearedByFamily.get(family.id);
	// Highest first: hard -> normal -> easy.
	for (const difficulty of CLEAR_RANK_DESC) {
		if (
			(accountCleared !== undefined && accountCleared.has(difficulty)) ||
			localClearedVariantIds.has(family.variants[difficulty].id)
		) {
			return difficulty;
		}
	}
	return null;
}

export function readLocalClearedVariantIds(
	families: readonly PuzzleFamilySummary[]
): ReadonlySet<string> {
	const cleared = new Set<string>();
	for (const family of families) {
		for (const variant of Object.values(family.variants)) {
			if ((getStats(variant.id)?.totalCompletions ?? 0) > 0) cleared.add(variant.id);
		}
	}
	return cleared;
}

export function resolveHighestClearedForFamilies(
	families: readonly PuzzleFamilySummary[],
	accountClearedByFamily: ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>,
	// Reactive tracking input only — never read for computation. The
	// getStats() localStorage reads below register no dependency of their
	// own, so callers pass the statsRevision store value to re-run local
	// discovery when a completion write lands while the route is mounted.
	_localStatsRevision: number
): ReadonlyMap<string, PuzzleDifficulty> {
	const localClearedVariantIds = readLocalClearedVariantIds(families);
	const highestByFamilyId = new Map<string, PuzzleDifficulty>();
	for (const family of families) {
		const highest = resolveHighestClearedDifficulty(
			family,
			localClearedVariantIds,
			accountClearedByFamily
		);
		if (highest !== null) highestByFamilyId.set(family.id, highest);
	}
	return highestByFamilyId;
}
