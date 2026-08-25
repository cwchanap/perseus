<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		createDefaultClock,
		createPuzzleSession,
		createRunIdFactory,
		type PuzzleSessionOutcome,
		type Rotation
	} from '@perseus/game-core';
	import PuzzleCanvas from './PuzzleCanvas.svelte';
	import { HPA1_FIXTURE } from './fixture';
	import { resolveMobileCrypto } from './runtime';
	import type { BoardCell } from './boardViewModel';

	const session = createPuzzleSession({
		metadata: HPA1_FIXTURE,
		clock: createDefaultClock(),
		runIdFactory: createRunIdFactory(resolveMobileCrypto()),
		initialTrayOrder: [0, 1, 2, 3],
		createTrayOrder: () => [0, 1, 2, 3],
		createRotations: (ids) =>
			Object.fromEntries(ids.map((id) => [id, 0])) as Record<number, Rotation>
	});

	let sessionState = session.getState();
	let lastAction = 'ready';

	const unsubscribe = session.subscribe(() => {
		sessionState = session.getState();
	});

	session.dispatch({ type: 'start' });
	sessionState = session.getState();

	onDestroy(() => {
		unsubscribe();
		session.dispose();
	});

	function selectPiece(pieceId: number): void {
		const outcome = session.dispatch({ type: 'select_piece', pieceId });
		lastAction = outcome.type === 'selection_changed' ? `selected piece-${pieceId}` : outcome.type;
	}

	function attemptPlacement(pieceId: number, cell: BoardCell): PuzzleSessionOutcome {
		const outcome = session.dispatch({
			type: 'attempt_placement',
			pieceId,
			x: cell.x,
			y: cell.y
		});
		if (outcome.type === 'placement') {
			if (outcome.outcome.status === 'accepted') {
				lastAction = `placement accepted piece-${pieceId}`;
			} else if (outcome.outcome.status === 'rejected') {
				lastAction = `placement rejected ${outcome.outcome.reason} counted`;
			} else {
				lastAction = `placement ${outcome.outcome.reason}`;
			}
		} else {
			lastAction = outcome.type;
		}
		return outcome;
	}
</script>

<page>
	<gridLayout rows="auto,auto,auto,auto,*" backgroundColor="#111820">
		<label row="0" text="HPA-1 Offline 2x2" fontSize="24" color="#f7fafc" margin="12,12,4,12" />
		<label
			row="1"
			text="Tap a piece, then a cell, or drag a piece into its cell."
			textWrap="true"
			color="#cbd5e0"
			margin="2,12"
		/>
		<label
			row="2"
			text={`fixture=2x2 lifecycle=${sessionState.lifecycle} placed=${sessionState.placedPieces.length}/4 wrong=${sessionState.counters.incorrectAttempts}`}
			textWrap="true"
			color="#f7fafc"
			margin="2,12"
		/>
		<label
			row="3"
			text={`selected=${sessionState.selectedPieceId === null ? 'none' : `piece-${sessionState.selectedPieceId}`} last=${lastAction}`}
			textWrap="true"
			color="#f6e05e"
			margin="2,12"
		/>
		<gridLayout row="4">
			<PuzzleCanvas
				{sessionState}
				onSelectPiece={selectPiece}
				onAttemptPlacement={attemptPlacement}
			/>
		</gridLayout>
	</gridLayout>
</page>
