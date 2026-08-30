<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Application } from '@nativescript/core';
	import {
		createDefaultClock,
		createPuzzleSession,
		createRunIdFactory,
		serializeSession,
		validationContextFrom,
		type PersistedViewport,
		type PuzzleSessionOutcome,
		type PuzzleSessionState,
		type PuzzleSession,
		type SessionStorageAdapter
	} from '@perseus/game-core';
	import { classifyProgress, type GameplayLaunch } from '../library/downloadedLibrary';
	import { sessionSpecFromManifest } from '../library/downloadManifest';
	import DiscardSheet from './DiscardSheet.svelte';
	import MissionSetupSheet from './MissionSetupSheet.svelte';
	import PauseSheet from './PauseSheet.svelte';
	import PuzzleCanvas from './PuzzleCanvas.svelte';
	import PuzzleTray from './PuzzleTray.svelte';
	import { shuffleIds } from './trayPieces';
	import { resolveMobileCrypto } from './runtime';
	import {
		commitViewport as commitSessionViewport,
		discardProgress,
		entrySheetFor,
		suspendSession
	} from './gameplaySessionPolicy';
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
				initialTrayOrder: shuffleIds(spec.pieces.map((piece) => piece.id)),
				createTrayOrder: () => shuffleIds(spec.pieces.map((piece) => piece.id))
			});

	let sessionState: Readonly<PuzzleSessionState> | null = session?.getState() ?? null;
	let lastAction = 'ready';
	let unsubscribe: (() => void) | null = null;
	let sheet: 'setup' | 'pause' | 'discard' | null = entrySheetFor(restored);
	let setupDraft = { mode: sessionState?.mode ?? 'timed', rotationEnabled: false };
	let discardError = '';

	function saveCurrentSnapshot(): void {
		if (!session) return;
		session.checkpointTime();
		const snapshot = serializeSession(session.getState());
		if (snapshot) storage.saveSession(spec.puzzleId, snapshot);
	}

	if (session) {
		unsubscribe = session.subscribe(() => {
			sessionState = session.getState();
		});
	}

	function startMission(): void {
		if (!session) return;
		session.dispatch({
			type: 'configure_setup',
			mode: setupDraft.mode,
			rotationEnabled: setupDraft.rotationEnabled
		});
		session.dispatch({ type: 'start' });
		saveCurrentSnapshot();
		sheet = null;
	}

	function pauseSession(): void {
		const outcome = session?.dispatch({ type: 'pause' });
		if (outcome?.type !== 'lifecycle_transitioned') return;
		saveCurrentSnapshot();
		sheet = 'pause';
	}

	function resumeSession(): void {
		const outcome = session?.dispatch({ type: 'resume' });
		if (outcome?.type !== 'lifecycle_transitioned') return;
		saveCurrentSnapshot();
		sheet = null;
	}

	function restartSession(): void {
		if (!session || !sessionState) return;
		const setupDraftSeed = {
			mode: sessionState.mode,
			rotationEnabled: sessionState.rotationEnabled
		};
		const outcome = session.dispatch({ type: 'restart' });
		if (outcome.type !== 'lifecycle_transitioned') return;
		setupDraft = setupDraftSeed;
		saveCurrentSnapshot();
		sheet = 'setup';
	}

	function requestDiscard(): void {
		discardError = '';
		sheet = 'discard';
	}

	function cancelDiscard(): void {
		discardError = '';
		sheet = 'pause';
	}

	function confirmDiscard(): void {
		if (!discardProgress(storage, spec.puzzleId)) {
			discardError = 'Unable to discard saved progress.';
			return;
		}
		// Dispose before exiting so onDestroy's save cannot resurrect the
		// cleared save (serializeSession returns null for disposed sessions).
		session?.dispatch({ type: 'dispose' });
		onExit();
	}

	function onSuspend(): void {
		if (!session) return;
		suspendSession(session, saveCurrentSnapshot);
	}

	function onResume(): void {
		session?.setDocumentHidden(false);
	}

	function exitToLibrary(): void {
		saveCurrentSnapshot();
		onExit();
	}

	onMount(() => {
		Application.on(Application.suspendEvent, onSuspend);
		Application.on(Application.resumeEvent, onResume);
		Application.on(Application.exitEvent, saveCurrentSnapshot);

		return () => {
			Application.off(Application.suspendEvent, onSuspend);
			Application.off(Application.resumeEvent, onResume);
			Application.off(Application.exitEvent, saveCurrentSnapshot);
		};
	});

	onDestroy(() => {
		saveCurrentSnapshot();
		unsubscribe?.();
		session?.dispose();
	});

	function selectPiece(pieceId: number): void {
		if (!session) return;
		const outcome = session.dispatch({ type: 'select_piece', pieceId });
		lastAction = outcome.type === 'selection_changed' ? `selected piece-${pieceId}` : outcome.type;
	}

	function handlePieceLoadError(failedPieceIds: number[]): void {
		lastAction = `piece load failed: ${failedPieceIds.length} piece(s)`;
	}

	function commitViewport(viewport: PersistedViewport | null): void {
		if (!session) return;
		commitSessionViewport(session, viewport, saveCurrentSnapshot);
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
		if (outcome.type === 'placement' && outcome.outcome.status !== 'noop') saveCurrentSnapshot();
		return outcome;
	}

	// Full-bleed cross-view drag: the overlay image follows the finger in
	// TRUE screen DIPs while the tray hands the piece over the board.
	interface ActivePieceDrag {
		pieceId: number;
		screenX: number;
		screenY: number;
	}

	const DRAG_OVERLAY_SIZE = 140;

	let activePieceDrag: ActivePieceDrag | null = null;
	let page: any = null;
	let puzzleCanvas: any = null;

	function startPieceDrag(pieceId: number, screenX: number, screenY: number): void {
		activePieceDrag = { pieceId, screenX, screenY };
	}

	function movePieceDrag(screenX: number, screenY: number): void {
		if (!activePieceDrag) return;
		activePieceDrag = { ...activePieceDrag, screenX, screenY };
	}

	function endPieceDrag(): void {
		if (!activePieceDrag) return;
		const cell =
			puzzleCanvas?.cellAtScreenPoint(activePieceDrag.screenX, activePieceDrag.screenY) ?? null;
		const pieceId = activePieceDrag.pieceId;
		activePieceDrag = null;
		if (cell) attemptPlacement(pieceId, cell);
	}

	function overlayOrigin(): { x: number; y: number } {
		return page?.getLocationOnScreen?.() ?? { x: 0, y: 0 };
	}

	function overlayLeft(screenX: number): number {
		return screenX - overlayOrigin().x - DRAG_OVERLAY_SIZE / 2;
	}

	function overlayTop(screenY: number): number {
		return screenY - overlayOrigin().y - DRAG_OVERLAY_SIZE / 2;
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
	<gridLayout bind:this={page} backgroundColor="#111820">
		<gridLayout rows="auto,auto,auto,auto,*,auto">
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
			<gridLayout row="4" columns="*,320">
				<gridLayout col={0}>
					<PuzzleCanvas
						bind:this={puzzleCanvas}
						{sessionState}
						piecePaths={launch.install.piecePaths}
						onAttemptPlacement={attemptPlacement}
						onLoadError={handlePieceLoadError}
						onViewportCommit={commitViewport}
					/>
				</gridLayout>
				<gridLayout col={1}>
					<PuzzleTray
						{sessionState}
						pieces={spec.pieces}
						piecePaths={launch.install.piecePaths}
						onSelectPiece={selectPiece}
						onPieceDragStart={startPieceDrag}
						onPieceDragMove={movePieceDrag}
						onPieceDragEnd={endPieceDrag}
					/>
				</gridLayout>
			</gridLayout>
			<button row="5" text="LIBRARY" class="library-button" on:tap={exitToLibrary} />
		</gridLayout>
		{#if activePieceDrag}
			<absoluteLayout>
				<image
					src={launch.install.piecePaths[activePieceDrag.pieceId]}
					left={overlayLeft(activePieceDrag.screenX)}
					top={overlayTop(activePieceDrag.screenY)}
					style={`width: ${DRAG_OVERLAY_SIZE}; height: ${DRAG_OVERLAY_SIZE};`}
					stretch="aspectFit"
				/>
			</absoluteLayout>
		{/if}
		{#if sheet === 'setup'}
			<gridLayout class="sheet-backdrop">
				<MissionSetupSheet
					bind:mode={setupDraft.mode}
					bind:rotationEnabled={setupDraft.rotationEnabled}
					onStart={startMission}
					onBack={exitToLibrary}
				/>
			</gridLayout>
		{:else if sheet === 'pause'}
			<gridLayout class="sheet-backdrop">
				<PauseSheet
					hasUserActivity={sessionState?.hasUserActivity ?? false}
					onResume={resumeSession}
					onRestart={restartSession}
					onDiscard={requestDiscard}
				/>
			</gridLayout>
		{:else if sheet === 'discard'}
			<gridLayout class="sheet-backdrop">
				<DiscardSheet error={discardError} onConfirm={confirmDiscard} onCancel={cancelDiscard} />
			</gridLayout>
		{/if}
	</gridLayout>
{/if}
