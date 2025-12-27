<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { PuzzlePiece } from '$lib/types/puzzle';
	import { getPieceImageUrl } from '$lib/services/api';
	import {
		selectedPieceId,
		setSelectedPiece,
		clearSelectedPiece
	} from '$lib/stores/pieceSelection';

	interface Props {
		piece: PuzzlePiece;
		isPlaced: boolean;
		onDragStart?: (piece: PuzzlePiece) => void;
		onDragMove?: (piece: PuzzlePiece, x: number, y: number) => void;
		onDragEnd?: (piece: PuzzlePiece, x: number, y: number) => void;
	}

	let { piece, isPlaced, onDragStart, onDragMove, onDragEnd }: Props = $props();

	let isTouchDragging = $state(false);
	let touchTranslateX = $state(0);
	let touchTranslateY = $state(0);
	let activeTouchId: number | null = null;
	let startClientX = 0;
	let startClientY = 0;
	let lastClientX = 0;
	let lastClientY = 0;
	let activeDropZone: HTMLElement | null = null;
	let touchListenersAttached = false;
	let currentSelectedId = $state<number | null>(null);

	const unsubscribeSelection = selectedPieceId.subscribe((value) => {
		currentSelectedId = value;
	});

	// Piece sizing constants (must match server TAB_RATIO = 0.2)
	const TAB_RATIO = 0.2;
	const expansionFactor = 1 + 2 * TAB_RATIO; // 1.4 (140%)
	const baseOffset = TAB_RATIO / expansionFactor; // ~14.29%

	function handleDragStart(event: DragEvent) {
		if (isPlaced || !event.dataTransfer) return;

		event.dataTransfer.setData('text/plain', piece.id.toString());
		event.dataTransfer.effectAllowed = 'move';
		onDragStart?.(piece);
	}

	function getTouchById(list: TouchList, id: number) {
		for (let i = 0; i < list.length; i++) {
			const t = list.item(i);
			if (t && t.identifier === id) return t;
		}
		return null;
	}

	function getDropZoneAtPoint(x: number, y: number): HTMLElement | null {
		const element = document.elementFromPoint(x, y);
		if (!element) return null;
		return element.closest('.drop-zone') as HTMLElement | null;
	}

	function createDataTransfer(pieceId: number): DataTransfer {
		if (typeof DataTransfer !== 'undefined') {
			const dt = new DataTransfer();
			dt.setData('text/plain', pieceId.toString());
			dt.effectAllowed = 'move';
			return dt;
		}

		const store = new SvelteMap<string, string>();
		const items: DataTransferItem[] = [];
		const emptyItemList = items as unknown as DataTransferItemList;
		const emptyFileList = [] as unknown as FileList;
		const getTypes = () => Array.from(store.keys());

		store.set('text/plain', pieceId.toString());
		items.push({
			kind: 'string',
			type: 'text/plain',
			getAsFile: () => null,
			getAsString: (callback: (data: string) => void) => callback(pieceId.toString())
		} as unknown as DataTransferItem);

		return {
			dropEffect: 'none',
			effectAllowed: 'move',
			get types() {
				return getTypes();
			},
			files: emptyFileList,
			items: emptyItemList,
			clearData(format?: string) {
				if (format) {
					store.delete(format);
					const idx = items.findIndex((i) => i.type === format);
					if (idx >= 0) items.splice(idx, 1);
				} else {
					store.clear();
					items.splice(0, items.length);
				}
			},
			getData: (type: string) => store.get(type) ?? '',
			setData(format: string, data: string) {
				store.set(format, data);
				const existingIndex = items.findIndex((i) => i.type === format);
				const item = {
					kind: 'string',
					type: format,
					getAsFile: () => null,
					getAsString: (callback: (value: string) => void) => callback(data)
				} as unknown as DataTransferItem;

				if (existingIndex >= 0) {
					items.splice(existingIndex, 1, item);
				} else {
					items.push(item);
				}
			}
		} as unknown as DataTransfer;
	}

	function dispatchSyntheticDragEvent(
		target: HTMLElement,
		type: 'dragover' | 'dragleave' | 'drop',
		dataTransfer?: DataTransfer
	) {
		let event: DragEvent;
		try {
			event = new DragEvent(type, {
				bubbles: true,
				cancelable: true,
				dataTransfer
			});
		} catch {
			event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
			if (dataTransfer) {
				try {
					Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
				} catch {
					// Ignore if dataTransfer property cannot be defined
				}
			}
		}

		if (dataTransfer && !('dataTransfer' in event)) {
			try {
				Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
			} catch {
				// Ignore if dataTransfer property cannot be defined
			}
		}

		target.dispatchEvent(event);
	}

	function cleanupTouchListeners() {
		window.removeEventListener('touchmove', handleWindowTouchMove);
		window.removeEventListener('touchend', handleWindowTouchEnd);
		window.removeEventListener('touchcancel', handleWindowTouchEnd);
		touchListenersAttached = false;
	}

	function resetTouchDragState(forceLeave = false) {
		isTouchDragging = false;
		touchTranslateX = 0;
		touchTranslateY = 0;
		activeTouchId = null;
		startClientX = 0;
		startClientY = 0;
		lastClientX = 0;
		lastClientY = 0;

		if (activeDropZone && forceLeave) {
			dispatchSyntheticDragEvent(activeDropZone, 'dragleave');
			activeDropZone = null;
		}
	}

	function handleWindowTouchMove(event: TouchEvent) {
		if (!isTouchDragging || activeTouchId === null) return;
		const touch = getTouchById(event.touches, activeTouchId);
		if (!touch) return;

		event.preventDefault();

		lastClientX = touch.clientX;
		lastClientY = touch.clientY;
		touchTranslateX = lastClientX - startClientX;
		touchTranslateY = lastClientY - startClientY;
		onDragMove?.(piece, lastClientX, lastClientY);

		const dropZone = getDropZoneAtPoint(lastClientX, lastClientY);
		if (dropZone !== activeDropZone) {
			if (activeDropZone) {
				dispatchSyntheticDragEvent(activeDropZone, 'dragleave');
			}
			activeDropZone = dropZone;
			if (activeDropZone) {
				dispatchSyntheticDragEvent(activeDropZone, 'dragover');
			}
		} else if (activeDropZone) {
			dispatchSyntheticDragEvent(activeDropZone, 'dragover');
		}
	}

	function handleWindowTouchEnd(event: TouchEvent) {
		if (!isTouchDragging || activeTouchId === null) {
			cleanupTouchListeners();
			resetTouchDragState();
			return;
		}

		const touch = getTouchById(event.changedTouches, activeTouchId);
		if (touch) {
			lastClientX = touch.clientX;
			lastClientY = touch.clientY;
		}

		const dropZone = getDropZoneAtPoint(lastClientX, lastClientY);
		if (dropZone) {
			const dt = createDataTransfer(piece.id);
			dispatchSyntheticDragEvent(dropZone, 'drop', dt);
		}

		onDragEnd?.(piece, lastClientX, lastClientY);
		cleanupTouchListeners();
		resetTouchDragState();
	}

	function handleTouchStart(event: TouchEvent) {
		if (isPlaced) return;

		const touch = event.changedTouches.item(0);
		if (!touch) return;

		event.preventDefault();
		if (touchListenersAttached) {
			cleanupTouchListeners();
			resetTouchDragState();
		}

		activeTouchId = touch.identifier;
		startClientX = touch.clientX;
		startClientY = touch.clientY;
		lastClientX = touch.clientX;
		lastClientY = touch.clientY;
		isTouchDragging = true;

		window.addEventListener('touchmove', handleWindowTouchMove, { passive: false });
		window.addEventListener('touchend', handleWindowTouchEnd);
		window.addEventListener('touchcancel', handleWindowTouchEnd);
		touchListenersAttached = true;
		onDragStart?.(piece);
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (isPlaced) return;
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();

		if (currentSelectedId === piece.id) {
			clearSelectedPiece();
		} else {
			setSelectedPiece(piece.id);
			onDragStart?.(piece);
		}
	}

	onDestroy(() => {
		cleanupTouchListeners();
		resetTouchDragState(true);
		unsubscribeSelection();
	});
</script>

<div
	class="puzzle-piece relative h-full w-full cursor-grab touch-none transition-transform select-none hover:scale-105 focus:outline-hidden"
	class:opacity-50={isPlaced}
	class:cursor-not-allowed={isPlaced}
	class:cursor-grabbing={isTouchDragging}
	class:z-50={isTouchDragging}
	class:pointer-events-none={isTouchDragging}
	class:ring-2={currentSelectedId === piece.id}
	class:ring-blue-400={currentSelectedId === piece.id}
	draggable={!isPlaced}
	ondragstart={handleDragStart}
	ontouchstart={handleTouchStart}
	onkeydown={handleKeyDown}
	role="button"
	tabindex={isPlaced ? -1 : 0}
	aria-label="Puzzle piece {piece.id}"
	aria-grabbed={currentSelectedId === piece.id}
	aria-pressed={currentSelectedId === piece.id}
	aria-disabled={isPlaced}
	data-testid="puzzle-piece"
	data-piece-id={piece.id}
	data-selected={currentSelectedId === piece.id}
	style={isTouchDragging
		? `transform: translate3d(${touchTranslateX}px, ${touchTranslateY}px, 0);`
		: undefined}
>
	<!-- Shadow wrapper: drop-shadow respects PNG transparency -->
	<div
		class="piece-shadow-wrapper h-full w-full"
		class:dragging={isTouchDragging}
		class:placed={isPlaced}
	>
		<!-- Pre-masked jigsaw piece from server (140% size, offset to show tabs) -->
		<div
			class="pointer-events-none relative"
			style="
				width: {expansionFactor * 100}%;
				height: {expansionFactor * 100}%;
				left: -{baseOffset * 100}%;
				top: -{baseOffset * 100}%;
			"
		>
			<img
				src={getPieceImageUrl(piece.puzzleId, piece.id)}
				alt="Piece {piece.id}"
				class="h-full w-full"
				draggable="false"
			/>
		</div>
	</div>
</div>

<style>
	.puzzle-piece {
		overflow: visible;
	}

	.puzzle-piece:not(.cursor-not-allowed):active {
		cursor: grabbing;
	}

	/* Drop shadow that respects clip-path shape */
	.piece-shadow-wrapper {
		filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.25));
	}

	/* Lifted/dragging state - more prominent shadow */
	.piece-shadow-wrapper.dragging {
		filter: drop-shadow(4px 8px 12px rgba(0, 0, 0, 0.35));
	}

	/* Placed piece - subtle shadow */
	.piece-shadow-wrapper.placed {
		filter: drop-shadow(1px 2px 3px rgba(0, 0, 0, 0.15));
	}
</style>
