import { describe, expect, it } from 'vitest';
import {
	createPuzzleSession,
	type Clock,
	type PuzzleSession,
	type SessionPuzzleSpec
} from '@perseus/game-core';
import { createBoardTransform } from './boardViewport';
import { createBoardViewModel } from './boardViewModel';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PIECE_IDS = [2, 7, 11, 19];
const PUZZLE_ID = '223e4567-e89b-42d3-a456-426614174001';

const canonicalPieces = PIECE_IDS.map((id, index) => ({
	id,
	correctX: index % 2,
	correctY: Math.floor(index / 2)
}));

class ManualClock implements Clock {
	monotonicNow(): number {
		return 0;
	}

	wallNow(): number {
		return 1_000;
	}

	setInterval(): unknown {
		return null;
	}

	clearInterval(): void {}
}

function sessionSpec(): SessionPuzzleSpec {
	return {
		puzzleId: PUZZLE_ID,
		source: 'api',
		pieceCount: PIECE_IDS.length,
		gridCols: 2,
		gridRows: 2,
		pieces: canonicalPieces
	};
}

function makeSession(): PuzzleSession {
	return createPuzzleSession({
		metadata: sessionSpec(),
		clock: new ManualClock(),
		runIdFactory: { create: () => RUN_ID },
		initialTrayOrder: [...PIECE_IDS]
	});
}

describe('BoardViewModel', () => {
	it('projects placed draw records from the supplied transform', () => {
		const transform = createBoardTransform({
			canvasWidth: 800,
			canvasHeight: 600,
			gridCols: 2,
			gridRows: 2,
			viewport: null
		});
		const session = makeSession();
		session.dispatch({ type: 'start' });
		session.dispatch({ type: 'attempt_placement', pieceId: 2, x: 0, y: 0 });

		const render = createBoardViewModel(transform).state(session.getState());

		expect(render.boardX).toBe(100);
		expect(render.boardY).toBe(0);
		expect(render.boardWidth).toBe(600);
		expect(render.cellWidth).toBe(300);
		expect(render.drawRecords).toEqual([
			{
				pieceId: 2,
				x: 40,
				y: -60,
				width: 420,
				height: 420,
				rotation: 0
			}
		]);
	});

	it('maps canvas points to canonical cells through the transform', () => {
		const transform = createBoardTransform({
			canvasWidth: 800,
			canvasHeight: 600,
			gridCols: 2,
			gridRows: 2,
			viewport: null
		});

		expect(transform.cellAt(250, 150)).toEqual({ x: 0, y: 0 });
		expect(transform.cellAt(550, 450)).toEqual({ x: 1, y: 1 });
		expect(transform.cellAt(5, 5)).toBeNull();
	});

	it('projects 0° for a placed piece after rotation is disabled, even when pieceRotations is stale', () => {
		const transform = createBoardTransform({
			canvasWidth: 800,
			canvasHeight: 600,
			gridCols: 2,
			gridRows: 2,
			viewport: null
		});
		const session = makeSession();
		session.dispatch({ type: 'configure_setup', mode: 'relaxed', rotationEnabled: true });
		session.dispatch({ type: 'start' });
		// Rotate the piece so pieceRotations holds a non-zero value, then
		// disable rotation: pieceRotations is left intact, but placement no
		// longer checks orientation, so the piece is accepted sideways.
		session.dispatch({ type: 'rotate_piece', pieceId: 2 });
		session.dispatch({ type: 'set_rotation_mode', enabled: false });
		expect(session.getState().pieceRotations[2]).not.toBe(0);
		session.dispatch({ type: 'attempt_placement', pieceId: 2, x: 0, y: 0 });

		const render = createBoardViewModel(transform).state(session.getState());

		expect(render.drawRecords).toHaveLength(1);
		expect(render.drawRecords[0].rotation).toBe(0);
	});
});
