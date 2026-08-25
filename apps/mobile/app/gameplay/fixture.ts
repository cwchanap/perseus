import type { SessionPuzzleSpec } from '@perseus/game-core';

export const HPA1_FIXTURE: SessionPuzzleSpec = {
	puzzleId: 'hpa-1-offline-fixture',
	source: 'local',
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
