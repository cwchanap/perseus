import { describe, it, expect } from 'vitest';
import { validationContextFrom, type SessionPuzzleSpec } from './types';

describe('validationContextFrom', () => {
	it('derives the validation context from a session puzzle spec', () => {
		const spec: SessionPuzzleSpec = {
			puzzleId: 'pz1',
			source: 'api',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			pieces: [
				{ id: 0, correctX: 0, correctY: 0 },
				{ id: 1, correctX: 1, correctY: 0 },
				{ id: 2, correctX: 0, correctY: 1 },
				{ id: 3, correctX: 1, correctY: 1 }
			]
		};

		expect(validationContextFrom(spec)).toEqual({
			puzzleId: 'pz1',
			source: 'api',
			pieceIds: [0, 1, 2, 3],
			gridCols: 2,
			gridRows: 2,
			pieceCount: 4,
			pieces: spec.pieces
		});
	});
});
