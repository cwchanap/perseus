import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleBoardPanel from '../PuzzleBoardPanel.svelte';
import type { ResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';
import type { Puzzle } from '$lib/types/puzzle';

const image = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const puzzle: Puzzle = {
	id: 'panel-test',
	name: 'Panel Test',
	pieceCount: 2,
	gridCols: 2,
	gridRows: 1,
	imageWidth: 200,
	imageHeight: 100,
	createdAt: 1704067200000,
	hasReference: true,
	pieces: [
		{
			id: 0,
			puzzleId: 'panel-test',
			correctX: 0,
			correctY: 0,
			imagePath: 'pieces/0.png',
			edges: { top: 'flat', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 1,
			puzzleId: 'panel-test',
			correctX: 1,
			correctY: 0,
			imagePath: 'pieces/1.png',
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'tab' }
		}
	]
};

const largeMetrics: ResponsivePuzzleBoardMetrics = {
	tier: 'extra-large',
	boardWidth: 2400,
	boardHeight: 1200,
	cellSize: 1200,
	pieceSlotSize: 1200
};

const resizedMetrics: ResponsivePuzzleBoardMetrics = {
	tier: 'large',
	boardWidth: 2200,
	boardHeight: 1100,
	cellSize: 1100,
	pieceSlotSize: 1100
};

function props(overrides: Record<string, unknown> = {}) {
	return {
		puzzle,
		boardMetrics: largeMetrics,
		placedPieces: [],
		selectedPieceId: null,
		activeHintTarget: null,
		resolveImage: () => image,
		referenceImageUrl: image,
		referenceActive: false,
		canUndo: true,
		canRedo: true,
		canOpenSetup: true,
		canPause: true,
		rotationEnabled: false,
		rotationToggleDisabled: false,
		interactionBlocked: false,
		viewResetVersion: 0,
		onPiecePlaced: vi.fn(),
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		onHint: vi.fn(),
		onReferenceDown: vi.fn(),
		onReferenceUp: vi.fn(),
		onRotationToggle: vi.fn(),
		onPause: vi.fn(),
		onOpenSetup: vi.fn(),
		...overrides
	};
}

function transformOf(element: Element): string {
	return element.getAttribute('style') ?? '';
}

function translateOf(transform: string): { x: number; y: number } {
	const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform);
	if (!match) throw new Error(`Missing translate() in ${transform}`);
	return { x: Number(match[1]), y: Number(match[2]) };
}

function scaleOf(transform: string): number {
	const match = /scale\(([-\d.]+)\)/.exec(transform);
	if (!match) throw new Error(`Missing scale() in ${transform}`);
	return Number(match[1]);
}

async function beginRealPan(pointerId: number): Promise<Element> {
	await page.getByLabelText('Zoom in').click();
	const board = await page.getByTestId('puzzle-board').element();
	const frame = await page.getByTestId('zoomable-board-frame').element();

	board.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId,
			pointerType: 'mouse',
			button: 0,
			clientX: 100,
			clientY: 100
		})
	);
	window.dispatchEvent(
		new PointerEvent('pointermove', {
			pointerId,
			pointerType: 'mouse',
			clientX: 180,
			clientY: 150
		})
	);

	await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);
	await expect
		.poll(() => {
			const { x, y } = translateOf(transformOf(frame));
			return Math.abs(x) + Math.abs(y);
		})
		.toBeGreaterThan(0);

	return frame;
}

describe('PuzzleBoardPanel', () => {
	it('forwards toolbar actions and shows Reference when available', async () => {
		const input = props();
		render(PuzzleBoardPanel, input);

		await page.getByLabelText('Undo').click();
		await page.getByLabelText('Redo').click();
		await page.getByLabelText('Hint').click();
		await page.getByLabelText('Rotation mode').click();
		await page.getByLabelText('Pause mission').click();
		await page.getByLabelText('Open mission setup').click();

		expect(input.onUndo).toHaveBeenCalledOnce();
		expect(input.onRedo).toHaveBeenCalledOnce();
		expect(input.onHint).toHaveBeenCalledOnce();
		expect(input.onRotationToggle).toHaveBeenCalledOnce();
		expect(input.onPause).toHaveBeenCalledOnce();
		expect(input.onOpenSetup).toHaveBeenCalledOnce();
		await expect.element(page.getByLabelText('Reference')).toBeVisible();
	});

	it('hides Reference when puzzle.hasReference is not true', async () => {
		render(PuzzleBoardPanel, props({ puzzle: { ...puzzle, hasReference: false } }));
		expect(page.getByLabelText('Reference').query()).toBeNull();
	});

	it('starts panning only from the board target, not viewport padding', async () => {
		render(PuzzleBoardPanel, props());
		await page.getByLabelText('Zoom in').click();
		const viewport = await page.getByTestId('board-viewport').element();
		const board = await page.getByTestId('puzzle-board').element();

		viewport.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 11,
				pointerType: 'mouse',
				button: 0,
				clientX: 20,
				clientY: 20
			})
		);
		await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);

		board.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 12,
				pointerType: 'mouse',
				button: 0,
				clientX: 100,
				clientY: 100
			})
		);
		await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);

		window.dispatchEvent(
			new PointerEvent('pointerup', {
				pointerId: 12,
				pointerType: 'mouse',
				button: 0
			})
		);
		await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
	});

	it('resets real zoom and pan when viewResetVersion changes', async () => {
		const input = props();
		const view = render(PuzzleBoardPanel, input);
		const frame = await page.getByTestId('zoomable-board-frame').element();
		await expect.poll(() => transformOf(frame)).toContain('translate(0px, 0px)');
		const fitTransform = transformOf(frame);

		await beginRealPan(7);
		expect(transformOf(frame)).not.toBe(fitTransform);

		await view.rerender({ ...input, viewResetVersion: 1 });
		await expect.poll(() => transformOf(frame)).toBe(fitTransform);
		expect(translateOf(transformOf(frame))).toEqual({ x: 0, y: 0 });
	});

	it('cancels pan and ignores later pointer moves when interactionBlocked becomes true', async () => {
		const input = props();
		const view = render(PuzzleBoardPanel, input);
		const frame = await beginRealPan(8);

		await view.rerender({ ...input, interactionBlocked: true });
		await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
		const blockedTransform = transformOf(frame);

		window.dispatchEvent(
			new PointerEvent('pointermove', {
				pointerId: 8,
				pointerType: 'mouse',
				clientX: 260,
				clientY: 220
			})
		);
		await expect.poll(() => transformOf(frame)).toBe(blockedTransform);
	});

	it('reclamps on boardMetrics changes without resetting usable zoom', async () => {
		const input = props();
		const view = render(PuzzleBoardPanel, input);
		const frame = await page.getByTestId('zoomable-board-frame').element();

		await page.getByLabelText('Zoom in').click();
		await expect.poll(() => scaleOf(transformOf(frame))).toBeGreaterThan(0);
		const zoomBeforeResize = scaleOf(transformOf(frame));

		await view.rerender({ ...input, boardMetrics: resizedMetrics });
		await expect.poll(() => scaleOf(transformOf(frame))).toBe(zoomBeforeResize);
	});

	it('ends pan in capture phase even when the target stops bubbling pointerup', async () => {
		render(PuzzleBoardPanel, props());
		await beginRealPan(9);
		const viewport = await page.getByTestId('board-viewport').element();
		viewport.addEventListener('pointerup', (event) => event.stopPropagation(), { once: true });
		viewport.dispatchEvent(
			new PointerEvent('pointerup', {
				bubbles: true,
				pointerId: 9,
				pointerType: 'mouse',
				button: 0
			})
		);
		await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
	});

	it('cancels panning on window blur', async () => {
		render(PuzzleBoardPanel, props());
		await beginRealPan(10);
		window.dispatchEvent(new Event('blur'));
		await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
	});

	it('zooms out via the toolbar button', async () => {
		render(PuzzleBoardPanel, props());
		const frame = await page.getByTestId('zoomable-board-frame').element();

		await page.getByLabelText('Zoom in').click();
		const zoomedInScale = scaleOf(transformOf(frame));
		expect(zoomedInScale).toBeGreaterThan(0);

		await page.getByLabelText('Zoom out').click();
		await expect.poll(() => scaleOf(transformOf(frame))).toBeLessThan(zoomedInScale);
	});

	it('zooms via wheel on the board frame', async () => {
		render(PuzzleBoardPanel, props());
		const frame = await page.getByTestId('zoomable-board-frame').element();
		const initialScale = scaleOf(transformOf(frame));

		frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
		await expect.poll(() => scaleOf(transformOf(frame))).toBeGreaterThan(initialScale);
	});

	it('falls back to fit zoom of 1 for invalid board dimensions', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const invalidMetrics: ResponsivePuzzleBoardMetrics = {
			...largeMetrics,
			boardWidth: 0,
			boardHeight: 0
		};
		// Render with valid metrics first so the viewport element has dimensions,
		// then switch to invalid metrics to trigger the invalid-dimensions branch.
		const input = props();
		const view = render(PuzzleBoardPanel, input);
		const viewport = await page.getByTestId('board-viewport').element();
		const frame = await page.getByTestId('zoomable-board-frame').element();
		await expect.poll(() => scaleOf(transformOf(frame))).toBeLessThan(1);

		// Ensure the viewport has non-zero dimensions for the invalid-dims check.
		viewport.style.width = '800px';
		viewport.style.height = '600px';

		await view.rerender({ ...input, boardMetrics: invalidMetrics });
		// Invalid dimensions cause getFitZoom to return 1 (after logging once),
		// so minZoom becomes 1 and the zoom snaps to 1.
		await expect.poll(() => scaleOf(transformOf(frame))).toBe(1);

		errorSpy.mockRestore();
	});

	it('ignores pointer move events from a non-active pointer id', async () => {
		render(PuzzleBoardPanel, props());
		const frame = await beginRealPan(13);
		const transformBefore = transformOf(frame);

		window.dispatchEvent(
			new PointerEvent('pointermove', {
				pointerId: 999,
				pointerType: 'mouse',
				clientX: 500,
				clientY: 500
			})
		);
		await expect.poll(() => transformOf(frame)).toBe(transformBefore);
	});

	it('ignores pointer up events from a non-active pointer id', async () => {
		render(PuzzleBoardPanel, props());
		await beginRealPan(14);

		window.dispatchEvent(
			new PointerEvent('pointerup', {
				pointerId: 999,
				pointerType: 'mouse',
				button: 0
			})
		);
		await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);

		// Cleanup: cancel the still-active pan.
		window.dispatchEvent(
			new PointerEvent('pointerup', {
				pointerId: 14,
				pointerType: 'mouse',
				button: 0
			})
		);
		await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
	});
});
