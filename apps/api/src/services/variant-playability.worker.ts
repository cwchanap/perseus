import type { PuzzleFamilyMetadata, PuzzleMetadata } from '@perseus/types';
import { getFamily, getPuzzle } from './storage.worker';

export type PlayableVariantResolution =
	| { playable: true; puzzle: PuzzleMetadata; family: PuzzleFamilyMetadata }
	| { playable: false; status: 404 }
	| { playable: false; status: 500; error: unknown };

export async function resolvePlayableVariant(
	kv: KVNamespace,
	variantId: string
): Promise<PlayableVariantResolution> {
	const puzzle = await getPuzzle(kv, variantId);
	if (!puzzle || puzzle.status !== 'ready') {
		return { playable: false, status: 404 };
	}
	try {
		const family = await getFamily(kv, puzzle.familyId);
		if (!family || family.status !== 'ready') {
			return { playable: false, status: 404 };
		}
		return { playable: true, puzzle, family };
	} catch (error) {
		return { playable: false, status: 500, error };
	}
}
