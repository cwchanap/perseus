<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Application, GridLayout, Screen } from '@nativescript/core';
	import {
		createDefaultClock,
		createPuzzleSession,
		createRunIdFactory,
		serializeSession,
		validationContextFrom,
		type InventoryFilter,
		type PersistedViewport,
		type PuzzleSessionOutcome,
		type PuzzleSessionState,
		type PuzzleSession,
		type ReferenceMode,
		type SealedCompletion,
		type SessionStorageAdapter
	} from '@perseus/game-core';
	import { classifyProgress, type GameplayLaunch } from '../library/downloadedLibrary';
	import { sessionSpecFromManifest } from '../library/downloadManifest';
	import { getDifficultyLabel } from '../library/familyGallery';
	import CompletionSheet from './CompletionSheet.svelte';
	import DiscardSheet from './DiscardSheet.svelte';
	import GameplayToolbar from './GameplayToolbar.svelte';
	import MissionSetupSheet from './MissionSetupSheet.svelte';
	import PauseSheet from './PauseSheet.svelte';
	import PuzzleCanvas from './PuzzleCanvas.svelte';
	import PuzzleTray from './PuzzleTray.svelte';
	import { shuffledUnplacedPieceIds, shuffleIds } from './trayPieces';
	import { resolveMobileCrypto } from './runtime';
	import {
		commitViewport as commitSessionViewport,
		discardProgress,
		entrySheetFor,
		suspendSession
	} from './gameplaySessionPolicy';
	import type { BoardCell } from './boardViewModel';
	import {
		DEFAULT_GAMEPLAY_LAYOUT,
		createGameplayLayout,
		type GameplayLayout
	} from './gameplayLayout';

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

	// Ephemeral hint presentation from the engine's event stream; a later
	// hint replaces both, an accepted placement of the hinted piece clears both.
	let hintPieceId: number | null = null;
	let hintTarget: BoardCell | null = null;

	// The immutable local seal, captured from the engine's event stream; the
	// completion sheet projects it read-only.
	let completionSeal: SealedCompletion | null = null;

	const session: PuzzleSession | null = launchUnavailable
		? null
		: createPuzzleSession({
				metadata: spec,
				clock: createDefaultClock(),
				runIdFactory: createRunIdFactory(resolveMobileCrypto()),
				restored,
				initialTrayOrder: shuffleIds(spec.pieces.map((piece) => piece.id)),
				createTrayOrder: () => shuffleIds(spec.pieces.map((piece) => piece.id)),
				onEvent: (event) => {
					if (event.type === 'hint_target') {
						hintPieceId = event.pieceId;
						hintTarget = event.target;
					} else if (event.type === 'placement_accepted' && hintPieceId === event.pieceId) {
						hintPieceId = null;
						hintTarget = null;
					} else if (event.type === 'completion_sealed') {
						// The seal is already on state when this event fires, so the
						// immediate save contains the completed snapshot.
						saveCurrentSnapshot();
						completionSeal = event.seal;
					}
				}
			});

	let sessionState: Readonly<PuzzleSessionState> | null = session?.getState() ?? null;
	let unsubscribe: (() => void) | null = null;
	let sheet: 'setup' | 'pause' | 'discard' | null = entrySheetFor(restored);
	let setupDraft = { mode: sessionState?.mode ?? 'timed', rotationEnabled: false };
	let discardError = '';

	// One safe initial layout; layoutChanged on the outer page grid measures
	// the real page and keeps the last valid layout across invalid/zero events.
	let portraitTrayExpanded = false;
	let pageWidthDip = Screen.mainScreen.widthDIPs;
	let pageHeightDip = Screen.mainScreen.heightDIPs;
	let gameplayLayout =
		createGameplayLayout(pageWidthDip, pageHeightDip, portraitTrayExpanded) ??
		DEFAULT_GAMEPLAY_LAYOUT;

	// The content grid and tray wrapper are mounted once with the landscape
	// default geometry; orientation/drawer changes update the same native
	// GridLayout views imperatively instead of through reactive row/col/rows/
	// columns attributes. The Task 2A native smoke proved reactive child-
	// placement re-application drops the Canvas/tray from the layout on
	// portrait rotation, so the plan's stop-condition remedy is applied here:
	// the smallest imperative GridLayout property update on the same mounted
	// views, no duplicate portrait markup.
	function applyGameplayLayout(layout: GameplayLayout): void {
		const grid = contentGrid?.nativeView;
		const tray = trayWrapper?.nativeView;
		if (!grid || !tray) return;
		grid.rows = layout.rows;
		grid.columns = layout.columns;
		GridLayout.setRow(tray, layout.trayRow);
		GridLayout.setColumn(tray, layout.trayColumn);
		grid.requestLayout();
	}

	function onGameplayLayoutChanged(args: any): void {
		const size = args.object?.getActualSize?.();
		if (!size || size.width <= 0 || size.height <= 0) return;
		if (size.width === pageWidthDip && size.height === pageHeightDip) return;

		const next = createGameplayLayout(size.width, size.height, portraitTrayExpanded);
		if (!next) return;

		puzzleTray?.cancelActiveDrag?.();
		pageWidthDip = size.width;
		pageHeightDip = size.height;
		gameplayLayout = next;
		applyGameplayLayout(next);
	}

	// Ephemeral drawer state: recomputes the layout from the last valid page
	// size; never persisted.
	function togglePortraitTray(): void {
		portraitTrayExpanded = !portraitTrayExpanded;
		const next = createGameplayLayout(pageWidthDip, pageHeightDip, portraitTrayExpanded);
		if (next) {
			gameplayLayout = next;
			applyGameplayLayout(next);
		}
	}

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
		// The fresh run invalidates both ephemeral overlays.
		hintPieceId = null;
		hintTarget = null;
		clearPlacementFeedback();
		saveCurrentSnapshot();
		sheet = 'setup';
	}

	// Discard is reachable from the pause sheet AND the active toolbar; cancel
	// returns to wherever the sheet was opened from.
	let discardReturn: 'pause' | null = null;

	function requestDiscard(): void {
		discardError = '';
		discardReturn = sheet === 'pause' ? 'pause' : null;
		sheet = 'discard';
	}

	function cancelDiscard(): void {
		discardError = '';
		sheet = discardReturn;
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

		// The content grid is mounted with the landscape default geometry; sync
		// the native GridLayout to the seed layout so a device that starts in
		// portrait (or whose seed differs from the default) is correct before
		// the first layoutChanged event, which the equal-size guard would skip.
		applyGameplayLayout(gameplayLayout);

		return () => {
			Application.off(Application.suspendEvent, onSuspend);
			Application.off(Application.resumeEvent, onResume);
			Application.off(Application.exitEvent, saveCurrentSnapshot);
		};
	});

	onDestroy(() => {
		clearPlacementFeedback();
		saveCurrentSnapshot();
		unsubscribe?.();
		session?.dispose();
	});

	function selectPiece(pieceId: number): void {
		session?.dispatch({ type: 'select_piece', pieceId });
	}

	function commitViewport(viewport: PersistedViewport | null): void {
		if (!session) return;
		commitSessionViewport(session, viewport, saveCurrentSnapshot);
	}

	// Fit Board is always available, even with a piece selected; it dispatches
	// set_viewport null through the same policy helper as canvas gestures.
	function fitBoard(): void {
		commitViewport(null);
	}

	function undoMove(): void {
		const outcome = session?.dispatch({ type: 'undo' });
		if (outcome?.type === 'history_restored') saveCurrentSnapshot();
	}

	function redoMove(): void {
		const outcome = session?.dispatch({ type: 'redo' });
		if (outcome?.type === 'history_restored') saveCurrentSnapshot();
	}

	function useHint(): void {
		const outcome = session?.dispatch({ type: 'use_hint' });
		if (outcome?.type === 'hint_used') saveCurrentSnapshot();
	}

	function rotateSelected(): void {
		const pieceId = sessionState?.selectedPieceId;
		if (pieceId === null || pieceId === undefined) return;
		const outcome = session?.dispatch({ type: 'rotate_piece', pieceId });
		if (outcome?.type === 'piece_rotated') saveCurrentSnapshot();
	}

	function setRotationMode(enabled: boolean): void {
		const outcome = session?.dispatch({ type: 'set_rotation_mode', enabled });
		if (outcome?.type === 'rotation_mode_changed') saveCurrentSnapshot();
	}

	// Reference mode is runtime-only engine state; never persisted, no save.
	function setReferenceMode(mode: ReferenceMode | null): void {
		session?.dispatch({ type: 'set_reference_mode', mode });
	}

	function setTrayFilter(filter: InventoryFilter): void {
		const outcome = session?.dispatch({
			type: 'update_tray_organization',
			update: { type: 'set_filter', filter }
		});
		if (outcome?.type === 'tray_organization_applied') saveCurrentSnapshot();
	}

	// Shuffle reorders ALL unplaced pieces (never the filtered subset) — the
	// Task 3B Corners regression is the contract.
	function shuffleTray(): void {
		if (!session || !sessionState) return;
		const outcome = session.dispatch({
			type: 'update_tray_organization',
			update: {
				type: 'reorder',
				trayId: 'main',
				pieceIds: shuffledUnplacedPieceIds(sessionState)
			}
		});
		if (outcome.type === 'tray_organization_applied') saveCurrentSnapshot();
	}

	// One ephemeral placement feedback with one replaceable short timeout;
	// the canvas draws it — no reducer/animation framework.
	const PLACEMENT_FEEDBACK_MS = 800;
	let placementFeedback: {
		cell: BoardCell;
		kind: 'accepted' | 'rejected';
	} | null = null;
	let placementFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

	function showPlacementFeedback(cell: BoardCell, kind: 'accepted' | 'rejected'): void {
		if (placementFeedbackTimer !== null) clearTimeout(placementFeedbackTimer);
		placementFeedback = { cell, kind };
		placementFeedbackTimer = setTimeout(() => {
			placementFeedbackTimer = null;
			placementFeedback = null;
		}, PLACEMENT_FEEDBACK_MS);
	}

	function clearPlacementFeedback(): void {
		if (placementFeedbackTimer !== null) clearTimeout(placementFeedbackTimer);
		placementFeedbackTimer = null;
		placementFeedback = null;
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
			if (outcome.outcome.status === 'accepted' || outcome.outcome.status === 'rejected') {
				showPlacementFeedback(cell, outcome.outcome.status);
			}
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
	let puzzleTray: any = null;
	let contentGrid: any = null;
	let trayWrapper: any = null;

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

	// A recognizer/system cancellation aborts the drag without placing: the
	// overlay may be over the board, but the gesture was not a committed drop.
	function cancelPieceDrag(): void {
		activePieceDrag = null;
	}

	// The drag overlay mirrors the board/tray rotation gate: when rotation is
	// off, stale pieceRotations values must not render the dragged piece
	// sideways even though placement accepts it upright.
	function overlayRotation(pieceId: number): number {
		return sessionState?.rotationEnabled ? (sessionState?.pieceRotations[pieceId] ?? 0) : 0;
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
	<gridLayout bind:this={page} backgroundColor="#111820" on:layoutChanged={onGameplayLayoutChanged}>
		<gridLayout rows="auto,*">
			<GameplayToolbar
				puzzleName={launch.install.manifest.puzzle.name}
				difficultyLabel={getDifficultyLabel(launch.install.manifest.puzzle.difficulty)}
				elapsedSeconds={sessionState.elapsedActiveSeconds}
				canUndo={sessionState.canUndo}
				canRedo={sessionState.canRedo}
				rotationEnabled={sessionState.rotationEnabled}
				rotationToggleDisabled={sessionState.placedPieces.length > 0}
				hasUserActivity={sessionState.hasUserActivity}
				referenceAvailable={launch.install.referencePath !== undefined}
				referenceMode={sessionState.activeReferenceMode}
				onLibrary={exitToLibrary}
				onUndo={undoMove}
				onRedo={redoMove}
				onHint={useHint}
				onFitBoard={fitBoard}
				onSetRotationMode={setRotationMode}
				onPause={pauseSession}
				onRestart={restartSession}
				onDiscard={requestDiscard}
				onSetReferenceMode={setReferenceMode}
			/>
			<gridLayout
				bind:this={contentGrid}
				row={1}
				rows={DEFAULT_GAMEPLAY_LAYOUT.rows}
				columns={DEFAULT_GAMEPLAY_LAYOUT.columns}
			>
				<gridLayout row={0} col={0}>
					<PuzzleCanvas
						bind:this={puzzleCanvas}
						{sessionState}
						piecePaths={launch.install.piecePaths}
						referencePath={launch.install.referencePath}
						referenceMode={sessionState.activeReferenceMode}
						{hintTarget}
						{placementFeedback}
						onAttemptPlacement={attemptPlacement}
						onViewportCommit={commitViewport}
					/>
				</gridLayout>
				<gridLayout bind:this={trayWrapper} row={0} col={1}>
					<PuzzleTray
						bind:this={puzzleTray}
						{sessionState}
						pieces={spec.pieces}
						piecePaths={launch.install.piecePaths}
						{hintPieceId}
						onSelectPiece={selectPiece}
						onPieceDragStart={startPieceDrag}
						onPieceDragMove={movePieceDrag}
						onPieceDragEnd={endPieceDrag}
						onPieceDragCancel={cancelPieceDrag}
						onSetFilter={setTrayFilter}
						onShuffle={shuffleTray}
						onRotateSelected={rotateSelected}
						drawerMode={gameplayLayout.mode === 'portrait'}
						drawerExpanded={portraitTrayExpanded}
						onToggleDrawer={togglePortraitTray}
					/>
				</gridLayout>
			</gridLayout>
		</gridLayout>
		{#if activePieceDrag}
			<absoluteLayout>
				<image
					src={launch.install.piecePaths[activePieceDrag.pieceId]}
					rotate={overlayRotation(activePieceDrag.pieceId)}
					left={overlayLeft(activePieceDrag.screenX)}
					top={overlayTop(activePieceDrag.screenY)}
					style={`width: ${DRAG_OVERLAY_SIZE}; height: ${DRAG_OVERLAY_SIZE};`}
					stretch="aspectFit"
				/>
			</absoluteLayout>
		{/if}
		{#if completionSeal}
			<gridLayout class="sheet-backdrop">
				<CompletionSheet
					puzzleName={launch.install.manifest.puzzle.name}
					difficulty={launch.install.manifest.puzzle.difficulty}
					seal={completionSeal}
					onBackToLibrary={exitToLibrary}
				/>
			</gridLayout>
		{:else if sheet === 'setup'}
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
