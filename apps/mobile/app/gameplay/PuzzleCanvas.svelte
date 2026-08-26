<script lang="ts">
	import { ImageAsset } from '@nativescript/canvas';
	import { Screen } from '@nativescript/core';
	import type { PuzzleSessionState, PuzzleSessionOutcome } from '@perseus/game-core';
	import {
		createBoardViewModel,
		type BoardCell,
		type BoardDrawRecord,
		type BoardViewModel
	} from './boardViewModel';

	export let sessionState: Readonly<PuzzleSessionState>;
	export let piecePaths: Record<number, string>;
	export let onSelectPiece: (pieceId: number) => void;
	export let onAttemptPlacement: (pieceId: number, cell: BoardCell) => PuzzleSessionOutcome;
	export let onLoadError: ((failedPieceIds: number[]) => void) | undefined = undefined;

	const CANVAS_WIDTH = 700;
	const CANVAS_HEIGHT = 800;

	let canvas: any;
	let viewModel: BoardViewModel | null = null;
	let pieceImages: Record<number, ImageAsset> = {};
	let surfaceReady = false;
	let draggingPieceId: number | null = null;
	let dragOffsetX = 0;
	let dragOffsetY = 0;
	let dragX = 0;
	let dragY = 0;
	let dragStartX = 0;
	let dragStartY = 0;

	$: if (surfaceReady && viewModel && sessionState) draw();

	function loadPieces(): void {
		pieceImages = {};
		const failedPieceIds: number[] = [];
		for (const [rawPieceId, imagePath] of Object.entries(piecePaths)) {
			const pieceId = Number(rawPieceId);
			if (!Number.isInteger(pieceId)) {
				failedPieceIds.push(pieceId);
				continue;
			}
			const image = new ImageAsset();
			if (image.fromFileSync(imagePath)) {
				pieceImages[pieceId] = image;
			} else {
				failedPieceIds.push(pieceId);
			}
		}
		if (failedPieceIds.length > 0 && onLoadError) {
			onLoadError(failedPieceIds);
		}
	}

	function onLoaded(args: any): void {
		canvas = args.object;
		const width = Number(canvas.width) || CANVAS_WIDTH;
		const height = Number(canvas.height) || CANVAS_HEIGHT;
		viewModel = createBoardViewModel({
			canvasWidth: width,
			canvasHeight: height,
			gridCols: sessionState.gridCols,
			gridRows: sessionState.gridRows
		});
		loadPieces();

		// The native surface can be reported as loaded before its backing surface
		// accepts draw calls. Wait for the first post-layout turn before painting.
		setTimeout(() => {
			surfaceReady = true;
			draw();
		}, 100);
	}

	function draw(): void {
		if (!canvas || !viewModel || !sessionState) return;
		const context = canvas.getContext('2d');
		if (!context) return;
		const width = Number(canvas.width) || CANVAS_WIDTH;
		const height = Number(canvas.height) || CANVAS_HEIGHT;
		const render = viewModel.state(sessionState);

		context.clearRect(0, 0, width, height);
		context.fillStyle = '#111820';
		context.fillRect(0, 0, width, height);
		context.fillStyle = '#1f2b38';
		context.fillRect(render.boardX, render.boardY, render.boardWidth, render.boardHeight);
		context.strokeStyle = '#718096';
		context.lineWidth = 2;
		for (let x = 0; x <= sessionState.gridCols; x += 1) {
			const lineX = render.boardX + x * render.cellWidth;
			context.beginPath();
			context.moveTo(lineX, render.boardY);
			context.lineTo(lineX, render.boardY + render.boardHeight);
			context.stroke();
		}
		for (let y = 0; y <= sessionState.gridRows; y += 1) {
			const lineY = render.boardY + y * render.cellHeight;
			context.beginPath();
			context.moveTo(render.boardX, lineY);
			context.lineTo(render.boardX + render.boardWidth, lineY);
			context.stroke();
		}

		for (const record of render.drawRecords.filter((item) => !item.placed)) {
			if (record.pieceId !== draggingPieceId) drawRecord(context, record);
		}
		for (const record of render.drawRecords.filter((item) => item.placed)) {
			drawRecord(context, record);
		}
		if (draggingPieceId !== null) {
			const record = render.drawRecords.find((item) => item.pieceId === draggingPieceId);
			if (record) drawRecord(context, { ...record, x: dragX, y: dragY });
		}
	}

	function drawRecord(context: any, record: BoardDrawRecord): void {
		const image = pieceImages[record.pieceId];
		if (!image) return;
		context.drawImage(image, record.x, record.y, record.width, record.height);
		if (record.selected) {
			context.strokeStyle = '#f6e05e';
			context.lineWidth = 4;
			context.strokeRect(record.x, record.y, record.width, record.height);
		}
	}

	function toCanvasPoint(event: any, x: number, y: number): { x: number; y: number } {
		const scale = Screen.mainScreen.scale || 1;
		const viewSize = event.view?.getActualSize?.() ?? {
			width: Number(canvas.width) / scale,
			height: Number(canvas.height) / scale
		};
		const displayWidth = Number(canvas.width) / scale;
		const displayHeight = Number(canvas.height) / scale;
		return {
			x: (x - (viewSize.width - displayWidth) / 2) * scale,
			y: (y - (viewSize.height - displayHeight) / 2) * scale
		};
	}

	function pointFromPan(event: any): { x: number; y: number } | null {
		try {
			if (event.ios?.locationInView && event.view?.nativeViewProtected) {
				const point = event.ios.locationInView(event.view.nativeViewProtected);
				return toCanvasPoint(event, point.x, point.y);
			}
		} catch {
			// Fall through to the delta-based position used by the installed runtime.
		}
		const current = event.android?.current;
		if (current && typeof current.getX === 'function' && typeof current.getY === 'function') {
			return toCanvasPoint(event, current.getX(), current.getY());
		}
		if (draggingPieceId !== null) {
			const scale = Screen.mainScreen.scale || 1;
			return { x: dragStartX + event.deltaX * scale, y: dragStartY + event.deltaY * scale };
		}
		return null;
	}

	function onTap(event: any): void {
		if (!viewModel || typeof event.getX !== 'function' || typeof event.getY !== 'function') return;
		const point = toCanvasPoint(event, event.getX(), event.getY());
		const x = point.x;
		const y = point.y;
		const pieceId = viewModel.pieceAt(x, y, sessionState);
		if (pieceId !== null) {
			onSelectPiece(pieceId);
			return;
		}
		const cell = viewModel.cellAt(x, y);
		if (cell && sessionState.selectedPieceId !== null) {
			onAttemptPlacement(sessionState.selectedPieceId, cell);
		}
	}

	function onPan(event: any): void {
		if (!viewModel) return;
		if (event.state === 1) {
			const start = pointFromPan(event);
			if (!start) return;
			const pieceId = viewModel.pieceAt(start.x, start.y, sessionState);
			if (pieceId === null) return;
			const record = viewModel
				.state(sessionState)
				.drawRecords.find((item) => item.pieceId === pieceId);
			if (!record) return;
			draggingPieceId = pieceId;
			dragStartX = start.x;
			dragStartY = start.y;
			dragOffsetX = start.x - record.x;
			dragOffsetY = start.y - record.y;
			dragX = start.x - dragOffsetX;
			dragY = start.y - dragOffsetY;
			draw();
			return;
		}
		if (draggingPieceId === null) return;
		const point = pointFromPan(event);
		if (event.state === 2 && point) {
			dragX = point.x - dragOffsetX;
			dragY = point.y - dragOffsetY;
			draw();
			return;
		}
		if (event.state === 0) {
			draggingPieceId = null;
			draw();
			return;
		}
		if (event.state === 3) {
			const scale = Screen.mainScreen.scale || 1;
			const release = point ?? {
				x: dragStartX + event.deltaX * scale,
				y: dragStartY + event.deltaY * scale
			};
			const cell = viewModel.cellAt(release.x, release.y);
			const pieceId = draggingPieceId;
			draggingPieceId = null;
			if (cell) onAttemptPlacement(pieceId, cell);
			draw();
		}
	}
</script>

<canvas
	bind:this={canvas}
	width={CANVAS_WIDTH}
	height={CANVAS_HEIGHT}
	backgroundColor="#111820"
	on:loaded={onLoaded}
	on:tap={onTap}
	on:pan={onPan}
/>
