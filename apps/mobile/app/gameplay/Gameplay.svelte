<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Application } from '@nativescript/core';
	import {
		createDefaultClock,
		createPuzzleSession,
		createRunIdFactory,
		serializeSession,
		validationContextFrom,
		type PuzzleSessionOutcome,
		type PuzzleSessionState,
		type PuzzleSession,
		type Rotation,
		type SessionStorageAdapter
	} from '@perseus/game-core';
	import { classifyProgress, type GameplayLaunch } from '../library/downloadedLibrary';
	import { sessionSpecFromManifest } from '../library/downloadManifest';
	import PuzzleCanvas from './PuzzleCanvas.svelte';
	import { resolveMobileCrypto } from './runtime';
	import type { BoardCell } from './boardViewModel';

	export let launch: GameplayLaunch;
	export let storage: SessionStorageAdapter;
	export let onExit: () => void;

	const spec = sessionSpecFromManifest(launch.install.manifest);
	const context = validationContextFrom(spec);
	const loadResult = storage.peekSession(spec.puzzleId, context);
	const progress = classifyProgress(loadResult, storage);

	const restored =
		launch.mode === 'resume' && loadResult.status === 'loaded' && progress.kind === 'resumable'
			? loadResult.snapshot
			: undefined;

	const canStart = launch.mode === 'start' && progress.kind === 'none';
	const canResume = launch.mode === 'resume' && restored !== undefined;
	const launchUnavailable = !canStart && !canResume;

	const session: PuzzleSession | null = launchUnavailable
		? null
		: createPuzzleSession({
				metadata: spec,
				clock: createDefaultClock(),
				runIdFactory: createRunIdFactory(resolveMobileCrypto()),
				restored,
				initialTrayOrder: spec.pieces.map((piece) => piece.id),
				createTrayOrder: () => spec.pieces.map((piece) => piece.id),
				createRotations: (ids) =>
					Object.fromEntries(ids.map((id) => [id, 0])) as Record<number, Rotation>
			});

	let sessionState: Readonly<PuzzleSessionState> | null = session?.getState() ?? null;
	let lastAction = 'ready';
	let unsubscribe: (() => void) | null = null;

	function persist(): void {
		if (!session) return;
		session.checkpointTime();
		const snapshot = serializeSession(session.getState());
		if (snapshot) storage.saveSession(spec.puzzleId, snapshot);
	}

	if (session) {
		unsubscribe = session.subscribe(() => {
			sessionState = session.getState();
		});

		session.dispatch({ type: 'start' });
		sessionState = session.getState();
		persist();
	}

	function onSuspend(): void {
		persist();
		if (session) session.setDocumentHidden(true);
	}

	function onResume(): void {
		if (session) session.setDocumentHidden(false);
	}

	function exitToLibrary(): void {
		persist();
		onExit();
	}

	onMount(() => {
		Application.on(Application.suspendEvent, onSuspend);
		Application.on(Application.resumeEvent, onResume);
		Application.on(Application.exitEvent, persist);

		return () => {
			Application.off(Application.suspendEvent, onSuspend);
			Application.off(Application.resumeEvent, onResume);
			Application.off(Application.exitEvent, persist);
		};
	});

	onDestroy(() => {
		persist();
		unsubscribe?.();
		session?.dispose();
	});

	function selectPiece(pieceId: number): void {
		if (!session) return;
		const outcome = session.dispatch({ type: 'select_piece', pieceId });
		lastAction = outcome.type === 'selection_changed' ? `selected piece-${pieceId}` : outcome.type;
	}

	function attemptPlacement(pieceId: number, cell: BoardCell): PuzzleSessionOutcome {
		if (!session) {
			return {
				type: 'placement',
				outcome: { status: 'noop', reason: 'lifecycle_disallows_gameplay' }
			};
		}
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
		if (outcome.type === 'placement' && outcome.outcome.status !== 'noop') persist();
		return outcome;
	}
</script>

{#if launchUnavailable}
	<gridLayout rows="auto,auto,*" backgroundColor="#111820">
		<label
			row="0"
			text="Saved progress changed. Return to Downloaded."
			textWrap="true"
			color="#f7fafc"
			fontSize="24"
			margin="12,12,4,12"
		/>
		<button row="1" text="BACK TO LIBRARY" class="library-button" on:tap={exitToLibrary} />
	</gridLayout>
{:else if sessionState}
	<gridLayout rows="auto,auto,auto,auto,*,auto" backgroundColor="#111820">
		<label
			row="0"
			text={launch.install.manifest.puzzle.name}
			fontSize="24"
			color="#f7fafc"
			margin="12,12,4,12"
		/>
		<label
			row="1"
			text="Tap a piece, then a cell, or drag a piece into its cell."
			textWrap="true"
			color="#cbd5e0"
			margin="2,12"
		/>
		<label
			row="2"
			text={`puzzle=${sessionState.puzzleId} grid=${sessionState.gridCols}x${sessionState.gridRows} lifecycle=${sessionState.lifecycle} placed=${sessionState.placedPieces.length}/${sessionState.pieceCount} wrong=${sessionState.counters.incorrectAttempts}`}
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
				piecePaths={launch.install.piecePaths}
				onSelectPiece={selectPiece}
				onAttemptPlacement={attemptPlacement}
			/>
		</gridLayout>
		<button row="5" text="LIBRARY" class="library-button" on:tap={exitToLibrary} />
	</gridLayout>
{/if}
