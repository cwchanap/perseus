<script lang="ts">
	import { ImageAsset } from '@nativescript/canvas';
	import { Screen } from '@nativescript/core';
	import type { PuzzleSessionState, PuzzleSessionOutcome } from '@perseus/game-core';
	import {
		backingSizeFromLayout,
		createBoardTransform,
		screenPointToCanvas,
		type BoardTransform,
		type CanvasSurfaceMetrics
	} from './boardViewport';
	import {
		createBoardViewModel,
		type BoardCell,
		type BoardDrawRecord,
		type BoardViewModel
	} from './boardViewModel';

	export let sessionState: Readonly<PuzzleSessionState>;
	export let piecePaths: Record<number, string>;
	export let onAttemptPlacement: (pieceId: number, cell: BoardCell) => PuzzleSessionOutcome;
	export let onLoadError: ((failedPieceIds: number[]) => void) | undefined = undefined;

	let canvas: any;
	let surfaceMetrics: CanvasSurfaceMetrics | null = null;
	let transform: BoardTransform | null = null;
	let viewModel: BoardViewModel | null = null;
	let firstPaintScheduled = false;
	let pieceImages: Record<number, ImageAsset> = {};
	let surfaceReady = false;

	$: if (surfaceReady && viewModel && sessionState) draw();
	$: if (piecePaths) loadPieces();

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

	function syncSurface(args: any): void {
		const view = args.object ?? canvas;
		const size = view?.getActualSize?.();
		const density = Screen.mainScreen.scale || 1;
		if (!size) return;

		const backing = backingSizeFromLayout(size.width, size.height, density);
		if (!backing) return;

		// Canvas backing dimensions are integers on the native surface; round
		// once and keep the surface metrics consistent with what we set.
		const width = Math.round(backing.width);
		const height = Math.round(backing.height);
		canvas.width = width;
		canvas.height = height;
		surfaceMetrics = {
			layoutWidthDip: size.width,
			layoutHeightDip: size.height,
			backingWidth: width,
			backingHeight: height
		};
		transform = createBoardTransform({
			canvasWidth: width,
			canvasHeight: height,
			gridCols: sessionState.gridCols,
			gridRows: sessionState.gridRows,
			viewport: sessionState.viewport
		});
		viewModel = createBoardViewModel(transform);

		if (!firstPaintScheduled) {
			firstPaintScheduled = true;
			// The native surface can be reported as loaded before its backing
			// surface accepts draw calls. Paint on the first post-layout turn.
			setTimeout(() => {
				surfaceReady = true;
				draw();
			}, 0);
		} else if (surfaceReady) {
			draw();
		}
	}

	function draw(): void {
		if (!canvas || !viewModel || !sessionState) return;
		const context = canvas.getContext('2d');
		if (!context) return;
		const render = viewModel.state(sessionState);

		context.clearRect(0, 0, canvas.width, canvas.height);
		context.fillStyle = '#111820';
		context.fillRect(0, 0, canvas.width, canvas.height);
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

		for (const record of render.drawRecords) {
			drawRecord(context, record);
		}
	}

	function drawRecord(context: any, record: BoardDrawRecord): void {
		const image = pieceImages[record.pieceId];
		if (!image) return;
		context.drawImage(image, record.x, record.y, record.width, record.height);
	}

	// Single conversion for every local gesture point: view-local DIPs into
	// Canvas backing coordinates through the rendered surface's actual
	// backing/layout ratios.
	function toCanvasPoint(x: number, y: number): { x: number; y: number } | null {
		if (!surfaceMetrics) return null;
		return screenPointToCanvas(x, y, 0, 0, surfaceMetrics);
	}

	function onTap(event: any): void {
		if (!transform || typeof event.getX !== 'function' || typeof event.getY !== 'function') return;
		const point = toCanvasPoint(event.getX(), event.getY());
		if (!point) return;
		const cell = transform.cellAt(point.x, point.y);
		if (cell && sessionState.selectedPieceId !== null) {
			onAttemptPlacement(sessionState.selectedPieceId, cell);
		}
	}

	// Overlay drags arrive in TRUE screen DIPs (unlike local gesture points,
	// whose origin is the view itself), so the canvas origin on screen is the
	// one place the nonzero origin is correct.
	export function cellAtScreenPoint(screenX: number, screenY: number): BoardCell | null {
		const origin = canvas?.getLocationOnScreen?.();
		if (!origin || !surfaceMetrics || !transform) return null;
		const point = screenPointToCanvas(screenX, screenY, origin.x, origin.y, surfaceMetrics);
		return point ? transform.cellAt(point.x, point.y) : null;
	}
</script>

<canvas
	bind:this={canvas}
	horizontalAlignment="stretch"
	verticalAlignment="stretch"
	backgroundColor="#111820"
	on:loaded={syncSurface}
	on:layoutChanged={syncSurface}
	on:tap={onTap}
/>
