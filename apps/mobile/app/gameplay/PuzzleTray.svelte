<script lang="ts">
	import { GestureStateTypes } from '@nativescript/core';
	import type { InventoryFilter, PuzzleSessionState, SessionPuzzleSpec } from '@perseus/game-core';
	import { unplacedPieceIds, visibleUnplacedPieceIds } from './trayPieces';

	export let sessionState: Readonly<PuzzleSessionState>;
	export let pieces: SessionPuzzleSpec['pieces'];
	export let piecePaths: Record<number, string>;
	export let hintPieceId: number | null = null;
	export let onSelectPiece: (pieceId: number) => void;
	export let onPieceDragStart: (pieceId: number, screenX: number, screenY: number) => void;
	export let onPieceDragMove: (screenX: number, screenY: number) => void;
	export let onPieceDragEnd: () => void;
	export let onPieceDragCancel: () => void;
	export let onSetFilter: (filter: InventoryFilter) => void;
	export let onShuffle: () => void;
	export let onRotateSelected: () => void;

	const TILE_SIZE = 120;
	const FILTERS: ReadonlyArray<{ filter: InventoryFilter; label: string }> = [
		{ filter: 'all', label: 'ALL' },
		{ filter: 'corners', label: 'CORNERS' },
		{ filter: 'edges', label: 'EDGES' },
		{ filter: 'center', label: 'CENTER' }
	];

	let dragArmed = false;

	$: visibleIds = visibleUnplacedPieceIds(sessionState, pieces);
	$: remainingCount = unplacedPieceIds(sessionState).length;
	$: activeFilter = sessionState.organization?.filter ?? 'all';
	$: canRotate = sessionState.selectedPieceId !== null && sessionState.rotationEnabled;

	function tileClass(pieceId: number): string {
		if (sessionState.selectedPieceId === pieceId) return 'tray-piece-selected';
		if (hintPieceId === pieceId) return 'tray-piece-hinted';
		return 'tray-piece';
	}

	// Rendered rotation follows the same gate as placement validation: when
	// rotation is off, pieceRotations may still hold stale non-zero values but
	// sideways pieces are accepted upright, so render them upright.
	function tileRotation(pieceId: number): number {
		return sessionState.rotationEnabled ? (sessionState.pieceRotations[pieceId] ?? 0) : 0;
	}

	// Tray-piece gesture points are view-local DIPs; the Gameplay overlay
	// consumes true screen DIPs, so add the view's on-screen origin.
	function screenPoint(args: any): { x: number; y: number } | null {
		const origin = args?.object?.getLocationOnScreen?.();
		if (!origin || typeof args.getX !== 'function' || typeof args.getY !== 'function') {
			return null;
		}
		return { x: origin.x + args.getX(), y: origin.y + args.getY() };
	}

	function onLongPress(args: any, pieceId: number): void {
		if (dragArmed || args.state !== GestureStateTypes.began) return;
		dragArmed = true;
		const origin = args.object?.getLocationOnScreen?.();
		onPieceDragStart(pieceId, (origin?.x ?? 0) + TILE_SIZE / 2, (origin?.y ?? 0) + TILE_SIZE / 2);
	}

	function onTouch(args: any): void {
		if (!dragArmed) return;
		if (args.action === 'move') {
			const point = screenPoint(args);
			if (point) onPieceDragMove(point.x, point.y);
		} else if (args.action === 'up') {
			dragArmed = false;
			// Forward the release coordinates before ending the drag: endPieceDrag
			// hit-tests activePieceDrag.screenX/screenY, which movePieceDrag
			// updates only on `move`. A finger can drift between the last move
			// and the up event, so without this the placement would hit-test the
			// stale last-move position.
			const point = screenPoint(args);
			if (point) onPieceDragMove(point.x, point.y);
			onPieceDragEnd();
		} else if (args.action === 'cancel') {
			// A system/recognizer cancellation aborts the drag: clear the
			// armed/overlay state without hit-testing or placing the piece.
			dragArmed = false;
			onPieceDragCancel();
		}
	}
</script>

<gridLayout rows="auto,auto,*">
	<gridLayout row={0} class="tray-header" columns="auto,*,auto,auto">
		<label
			col={0}
			text={`REMAINING ${remainingCount}`}
			class="tray-count"
			verticalAlignment="middle"
		/>
		<button col={2} text="SHUFFLE" class="tray-action" on:tap={onShuffle} />
		<button
			col={3}
			text="ROTATE"
			class={canRotate ? 'tray-action' : 'tray-action-disabled'}
			isEnabled={canRotate}
			on:tap={onRotateSelected}
		/>
	</gridLayout>
	<gridLayout row={1} columns="*,*,*,*">
		{#each FILTERS as entry, index (entry.filter)}
			<button
				col={index}
				text={entry.label}
				class={activeFilter === entry.filter ? 'tray-filter-selected' : 'tray-filter'}
				on:tap={() => onSetFilter(entry.filter)}
			/>
		{/each}
	</gridLayout>
	<scrollView row={2} class="tray-scroll" isScrollEnabled={!dragArmed}>
		<wrapLayout padding="8">
			{#each visibleIds as pieceId (pieceId)}
				<gridLayout
					class={tileClass(pieceId)}
					style={`width: ${TILE_SIZE}; height: ${TILE_SIZE};`}
					on:tap={() => onSelectPiece(pieceId)}
					on:longPress={(args) => onLongPress(args, pieceId)}
					on:touch={(args) => onTouch(args)}
				>
					<image
						src={piecePaths[pieceId]}
						rotate={tileRotation(pieceId)}
						stretch="aspectFit"
						margin="8"
					/>
				</gridLayout>
			{/each}
		</wrapLayout>
	</scrollView>
</gridLayout>
