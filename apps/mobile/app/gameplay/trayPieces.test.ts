import { describe, expect, it } from 'vitest';
import {
	shuffleIds,
	shuffledUnplacedPieceIds,
	unplacedPieceIds,
	visibleUnplacedPieceIds,
	type TrayProjectionState
} from './trayPieces';

const pieces = Array.from({ length: 9 }, (_, id) => ({
	id,
	correctX: id % 3,
	correctY: Math.floor(id / 3)
}));

const state: TrayProjectionState = {
	gridCols: 3,
	gridRows: 3,
	trayOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8],
	placedPieces: [{ pieceId: 4, x: 1, y: 1 }],
	organization: {
		filter: 'corners',
		activeTray: 'main',
		membership: {},
		names: {}
	}
};

describe('trayPieces', () => {
	it('lists unplaced piece ids in tray order', () => {
		expect(unplacedPieceIds(state)).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
	});

	it('projects only unplaced ids matching the organization filter', () => {
		expect(visibleUnplacedPieceIds(state, pieces)).toEqual([0, 2, 6, 8]);
	});

	it('shuffles every unplaced id with the injected RNG', () => {
		expect(new Set(shuffledUnplacedPieceIds(state, () => 0.25))).toEqual(
			new Set([0, 1, 2, 3, 5, 6, 7, 8])
		);
	});

	it('does not mutate the input order', () => {
		const input = [3, 1, 2];
		shuffleIds(input, () => 0.5);
		expect(input).toEqual([3, 1, 2]);
	});

	it('is deterministic for a fixed injected RNG', () => {
		const first = shuffleIds([1, 2, 3, 4, 5], () => 0.25);
		const second = shuffleIds([1, 2, 3, 4, 5], () => 0.25);
		expect(first).toEqual(second);
	});
});
