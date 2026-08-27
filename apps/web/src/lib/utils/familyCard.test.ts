import { describe, it, expect } from 'vitest';
import { ownedFamilyToGalleryFamily } from './familyCard';
import { PUZZLE_DIFFICULTIES } from '@perseus/types';
import type { PlayerOwnedFamilySummary } from '$lib/types/puzzle';

const ownedFamily: PlayerOwnedFamilySummary = {
	id: 'fam-owned',
	name: 'Owned Puzzle',
	aspectRatio: '1:1',
	status: 'ready',
	createdAt: 1
};

describe('ownedFamilyToGalleryFamily', () => {
	it('does not reuse the family id as a playable variant id', () => {
		const galleryFamily = ownedFamilyToGalleryFamily(ownedFamily);

		for (const difficulty of PUZZLE_DIFFICULTIES) {
			expect(galleryFamily.variants[difficulty].id).not.toBe(ownedFamily.id);
		}
	});
});
