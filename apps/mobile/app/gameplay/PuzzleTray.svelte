<script lang="ts">
	import { GestureStateTypes } from '@nativescript/core';
	import type { PuzzleSessionState, SessionPuzzleSpec } from '@perseus/game-core';
	import { visibleUnplacedPieceIds } from './trayPieces';

	export let sessionState: Readonly<PuzzleSessionState>;
	export let pieces: SessionPuzzleSpec['pieces'];
	export let piecePaths: Record<number, string>;
	export let onSelectPiece: (pieceId: number) => void;
	export let onPieceDragStart: (pieceId: number, screenX: number, screenY: number) => void;
	export let onPieceDragMove: (screenX: number, screenY: number) => void;
	export let onPieceDragEnd: () => void;

	const TILE_SIZE = 120;

	let dragArmed = false;

	$: visibleIds = visibleUnplacedPieceIds(sessionState, pieces);

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
		} else if (args.action === 'up' || args.action === 'cancel') {
			dragArmed = false;
			onPieceDragEnd();
		}
	}
</script>

<scroll-view class="tray-scroll" isScrollEnabled={!dragArmed}>
	<wrapLayout padding="8">
		{#each visibleIds as pieceId (pieceId)}
			<gridLayout
				class={sessionState.selectedPieceId === pieceId ? 'tray-piece-selected' : 'tray-piece'}
				style={`width: ${TILE_SIZE}; height: ${TILE_SIZE};`}
				on:tap={() => onSelectPiece(pieceId)}
				on:longPress={(args) => onLongPress(args, pieceId)}
				on:touch={(args) => onTouch(args)}
			>
				<image src={piecePaths[pieceId]} stretch="aspectFit" margin="8" />
			</gridLayout>
		{/each}
	</wrapLayout>
</scroll-view>
