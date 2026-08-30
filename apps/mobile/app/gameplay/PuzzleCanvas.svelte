<script lang="ts">
	import { ImageAsset } from '@nativescript/canvas';
	import { Screen } from '@nativescript/core';
	import type {
		PersistedViewport,
		PuzzleSessionOutcome,
		PuzzleSessionState
	} from '@perseus/game-core';
	import {
		backingSizeFromLayout,
		canFitOnDoubleTap,
		createBoardTransform,
		screenPointToCanvas,
		transformViewportForTwoPointers,
		type BoardTransform,
		type BoardViewportInput,
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
	// One commit per gesture: pinch/pan redraws transiently and commits the
	// final viewport once on gesture end; doubleTap commits Fit as null.
	export let onViewportCommit: (viewport: PersistedViewport | null) => void;
	export let onLoadError: ((failedPieceIds: number[]) => void) | undefined = undefined;

	let canvas: any;
	let surfaceMetrics: CanvasSurfaceMetrics | null = null;
	let transform: BoardTransform | null = null;
	let viewModel: BoardViewModel | null = null;
	let firstPaintScheduled = false;
	let pieceImages: Record<number, ImageAsset> = {};
	let surfaceReady = false;

	// undefined = no gesture in flight; null = a valid transient Fit frame.
	let transientViewport: PersistedViewport | null | undefined = undefined;
	let effectiveViewport: PersistedViewport | null = null;
	let activePointerCount = 0;
	let suppressFitUntilMs = 0;

	// A placement tap advances this past the platform double-tap window so
	// place -> selection cleared -> doubleTap cannot chain into a Fit.
	const PLACEMENT_FIT_SUPPRESS_MS = 500;

	interface TwoPointerGesture {
		startViewport: PersistedViewport | null;
		startFocusX: number;
		startFocusY: number;
		startDistance: number;
	}

	let gesture: TwoPointerGesture | null = null;
	let lastPointerPoints: Array<{ x: number; y: number } | null> = [null, null];

	$: effectiveViewport =
		transientViewport !== undefined ? transientViewport : sessionState.viewport;

	$: if (surfaceReady && sessionState) {
		rebuildTransform(effectiveViewport);
		draw();
	}
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

	function rebuildTransform(viewport: PersistedViewport | null): void {
		if (!sessionState || !surfaceMetrics) return;
		transform = createBoardTransform({
			canvasWidth: surfaceMetrics.backingWidth,
			canvasHeight: surfaceMetrics.backingHeight,
			gridCols: sessionState.gridCols,
			gridRows: sessionState.gridRows,
			viewport
		});
		viewModel = createBoardViewModel(transform);
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
		rebuildTransform(sessionState.viewport);

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

	function boardInput(): BoardViewportInput | null {
		if (!sessionState || !surfaceMetrics) return null;
		return {
			canvasWidth: surfaceMetrics.backingWidth,
			canvasHeight: surfaceMetrics.backingHeight,
			gridCols: sessionState.gridCols,
			gridRows: sessionState.gridRows,
			viewport: effectiveViewport
		};
	}

	// NativeScript aggregates every pointer into getAllPointers() on both
	// platforms (view-local DIPs); anything unexpected degrades to an empty
	// read and the gesture simply waits for a well-formed frame.
	function readPointerPoints(args: any): Array<{ x: number; y: number }> {
		if (typeof args?.getAllPointers !== 'function') return [];
		const points: Array<{ x: number; y: number }> = [];
		for (const pointer of args.getAllPointers()) {
			const point = toCanvasPoint(pointer?.getX?.() ?? NaN, pointer?.getY?.() ?? NaN);
			if (point) points.push(point);
		}
		return points.slice(0, 2);
	}

	function updateTwoPointerGesture(
		first: { x: number; y: number },
		second: { x: number; y: number }
	): void {
		const input = boardInput();
		if (!input) return;
		const focusX = (first.x + second.x) / 2;
		const focusY = (first.y + second.y) / 2;
		const distance = Math.hypot(second.x - first.x, second.y - first.y);
		if (!gesture) {
			if (!(distance > 0)) return;
			// First frame at exactly two pointers: capture the start baseline.
			gesture = {
				startViewport: effectiveViewport,
				startFocusX: focusX,
				startFocusY: focusY,
				startDistance: distance
			};
		}
		// Every frame derives from the START baseline, so no drift accumulates.
		transientViewport = transformViewportForTwoPointers(input, {
			startViewport: gesture.startViewport,
			startFocusX: gesture.startFocusX,
			startFocusY: gesture.startFocusY,
			currentFocusX: focusX,
			currentFocusY: focusY,
			scale: distance / gesture.startDistance
		});
	}

	function endTwoPointerGesture(): void {
		if (!gesture) return;
		const viewport = transientViewport === undefined ? null : transientViewport;
		gesture = null;
		transientViewport = undefined;
		lastPointerPoints = [null, null];
		onViewportCommit(viewport);
	}

	function onTouch(args: any): void {
		const action = typeof args?.action === 'string' ? args.action : '';
		if (action === 'down') {
			activePointerCount += 1;
		} else if (action === 'up' || action === 'cancel') {
			activePointerCount = Math.max(0, activePointerCount - 1);
		} else if (action !== 'move') {
			return;
		}

		// The gesture lives only while EXACTLY two pointers are active; any
		// exit from that state commits once. One-finger movement is a no-op.
		if (gesture && activePointerCount !== 2) endTwoPointerGesture();
		if (activePointerCount === 0 || action === 'up' || action === 'cancel') return;

		const points = readPointerPoints(args);
		for (let i = 0; i < points.length && i < lastPointerPoints.length; i += 1) {
			lastPointerPoints[i] = points[i];
		}
		const first = lastPointerPoints[0];
		const second = lastPointerPoints[1];
		if (activePointerCount === 2 && first && second) {
			updateTwoPointerGesture(first, second);
		}
	}

	function onTap(event: any): void {
		if (!transform || typeof event.getX !== 'function' || typeof event.getY !== 'function') return;
		const point = toCanvasPoint(event.getX(), event.getY());
		if (!point) return;
		const cell = transform.cellAt(point.x, point.y);
		if (cell && sessionState.selectedPieceId !== null) {
			suppressFitUntilMs = Date.now() + PLACEMENT_FIT_SUPPRESS_MS;
			onAttemptPlacement(sessionState.selectedPieceId, cell);
		}
	}

	function onDoubleTap(): void {
		if (!transform) return;
		if (!canFitOnDoubleTap(sessionState.selectedPieceId, Date.now(), suppressFitUntilMs)) return;
		onViewportCommit(null);
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
	on:loaded={syncSurface}
	on:layoutChanged={syncSurface}
	on:touch={onTouch}
	on:tap={onTap}
	on:doubleTap={onDoubleTap}
/>
