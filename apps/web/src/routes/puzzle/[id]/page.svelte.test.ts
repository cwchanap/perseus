import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzlePage from './+page.svelte';
import type { GameProgress, PlacedPiece, Puzzle, PuzzlePiece } from '$lib/types/puzzle';
import type { Rotation } from '$lib/types/gameplay';
import { getResponsivePuzzleBoardMetrics } from '$lib/services/puzzleLayout';

const mockPageStore = vi.hoisted(() => {
	type PageValue = {
		url: { pathname: string };
		params: { id: string };
		route: { id: string | null };
		status: number;
		error: unknown;
	};

	const subscribers = new Set<(value: PageValue) => void>();
	let value: PageValue = {
		url: { pathname: '/puzzle/test-puzzle' },
		params: { id: 'test-puzzle' },
		route: { id: '/puzzle/[id]' },
		status: 200,
		error: null
	};

	return {
		subscribe(callback: (value: PageValue) => void) {
			callback(value);
			subscribers.add(callback);
			return () => {
				subscribers.delete(callback);
			};
		},
		set(next: PageValue) {
			value = next;
			subscribers.forEach((callback) => callback(value));
		}
	};
});

const progressState = vi.hoisted(() => ({
	value: null as GameProgress | null
}));

vi.mock('$app/stores', () => ({
	page: mockPageStore
}));

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

vi.mock('$app/paths', () => ({
	resolve: (path: string) => path
}));

vi.mock('$lib/utils/shuffle', () => ({
	shuffleArray: vi.fn((values: number[]) => [...values])
}));

vi.mock('$lib/services/gameplay/rotation', async () => {
	const actual = await vi.importActual<typeof import('$lib/services/gameplay/rotation')>(
		'$lib/services/gameplay/rotation'
	);

	return {
		...actual,
		generateRandomRotations: vi.fn((pieceIds: number[]) =>
			Object.fromEntries(pieceIds.map((pieceId) => [pieceId, 0]))
		)
	};
});

vi.mock('$lib/services/api', () => {
	const imageSrc = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

	class MockApiError extends Error {
		status: number;
		error: string;

		constructor(status: number, error: string, message: string) {
			super(message);
			this.name = 'ApiError';
			this.status = status;
			this.error = error;
		}
	}

	return {
		fetchPuzzle: vi.fn(),
		getPieceImageUrl: vi.fn(() => imageSrc),
		getReferenceImageUrl: vi.fn(() => imageSrc),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/progress', () => ({
	getProgress: vi.fn((puzzleId: string) => {
		if (progressState.value?.puzzleId !== puzzleId) {
			return null;
		}

		return {
			...progressState.value,
			placedPieces: progressState.value.placedPieces.map((placement) => ({ ...placement })),
			pieceRotations: { ...progressState.value.pieceRotations }
		};
	}),
	saveProgress: vi.fn(
		(
			puzzleId: string,
			placedPieces: PlacedPiece[],
			rotationEnabled = false,
			pieceRotations: Record<number, Rotation> = {}
		) => {
			progressState.value = {
				puzzleId,
				placedPieces: placedPieces.map((placement) => ({ ...placement })),
				rotationEnabled,
				pieceRotations: { ...pieceRotations },
				lastUpdated: '2024-01-01T00:00:00.000Z'
			};
		}
	),
	clearProgress: vi.fn((puzzleId: string) => {
		if (progressState.value?.puzzleId === puzzleId) {
			progressState.value = null;
		}
	})
}));

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn(() => null),
	saveCompletionTime: vi.fn(() => false)
}));

vi.mock('$lib/stores/timer', () => ({
	formatTime: (totalSeconds: number) => `00:${String(totalSeconds).padStart(2, '0')}`,
	createTimerStore: vi.fn(() => {
		let state = { elapsed: 0, running: false };
		const subscribers = new Set<(value: typeof state) => void>();

		const publish = () => {
			subscribers.forEach((callback) => callback(state));
		};

		return {
			subscribe(callback: (value: typeof state) => void) {
				callback(state);
				subscribers.add(callback);
				return () => {
					subscribers.delete(callback);
				};
			},
			start() {
				state = { ...state, running: true };
				publish();
			},
			pause() {
				state = { ...state, running: false };
				publish();
			},
			resume() {
				state = { ...state, running: true };
				publish();
			},
			reset() {
				state = { elapsed: 0, running: false };
				publish();
			},
			destroy() {
				subscribers.clear();
			}
		};
	})
}));

import { fetchPuzzle } from '$lib/services/api';
import { saveProgress, clearProgress } from '$lib/services/progress';
import { saveCompletionTime } from '$lib/services/stats';
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { clearSelectedPiece, selectedPieceId, setSelectedPiece } from '$lib/stores/pieceSelection';

function createPiece(
	id: number,
	correctX: number,
	correctY: number,
	overrides: Partial<PuzzlePiece> = {}
): PuzzlePiece {
	return {
		id,
		puzzleId: 'test-puzzle',
		correctX,
		correctY,
		edges: {
			top: correctY === 0 ? 'flat' : 'tab',
			right: correctX === 1 ? 'flat' : 'blank',
			bottom: correctY === 0 ? 'flat' : 'blank',
			left: correctX === 0 ? 'flat' : 'tab'
		},
		imagePath: `pieces/${id}.png`,
		...overrides
	};
}

function createMockPuzzle(): Puzzle {
	return {
		id: 'test-puzzle',
		name: 'Test Mission',
		pieceCount: 2,
		gridCols: 2,
		gridRows: 1,
		imageWidth: 200,
		imageHeight: 100,
		createdAt: 1704067200000,
		pieces: [createPiece(0, 0, 0), createPiece(1, 1, 0)],
		hasReference: true
	};
}

function setSavedProgress(progress: Partial<GameProgress>) {
	progressState.value = {
		puzzleId: 'test-puzzle',
		placedPieces: [],
		rotationEnabled: false,
		pieceRotations: {},
		lastUpdated: '2024-01-01T00:00:00.000Z',
		...progress
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

async function renderPuzzlePage() {
	vi.mocked(fetchPuzzle).mockResolvedValue(createMockPuzzle());
	render(PuzzlePage);
	await expect.element(page.getByTestId('puzzle-board')).toBeVisible();
}

async function selectPiece(pieceId: number) {
	const piece = await page.getByLabelText(`Puzzle piece ${pieceId}`).element();
	piece.focus();
	piece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await expect
		.element(page.getByLabelText(`Puzzle piece ${pieceId}`))
		.toHaveAttribute('data-selected', 'true');
}

async function placePiece(pieceId: number, x: number, y: number) {
	await selectPiece(pieceId);
	await placeSelectedPieceAt(x, y);
}

async function placeSelectedPieceAt(x: number, y: number) {
	const dropZone = await page
		.getByRole('button', { name: `Drop zone at position ${x}, ${y}` })
		.element();
	dropZone.focus();
	dropZone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('Puzzle route gameplay integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		progressState.value = null;
		mockPageStore.set({
			url: { pathname: '/puzzle/test-puzzle' },
			params: { id: 'test-puzzle' },
			route: { id: '/puzzle/[id]' },
			status: 200,
			error: null
		});
		clearSelectedPiece();
	});

	it('renders the gameplay toolbar and zoomable board frame on load', async () => {
		await renderPuzzlePage();

		await expect.element(page.getByTestId('puzzle-toolbar')).toBeVisible();
		await expect.element(page.getByTestId('zoomable-board-frame')).toBeVisible();
		await expect.element(page.getByLabelText('Undo')).toBeDisabled();
		await expect.element(page.getByLabelText('Redo')).toBeDisabled();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');
	});

	it('sizes the board responsively and makes tray slots match board cells', async () => {
		const originalInnerWidth = window.innerWidth;
		const originalInnerHeight = window.innerHeight;
		try {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
			Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
			const puzzle = createMockPuzzle();
			vi.mocked(fetchPuzzle).mockResolvedValue(puzzle);
			render(PuzzlePage);
			await expect.element(page.getByTestId('puzzle-board')).toBeVisible();

			const expected = getResponsivePuzzleBoardMetrics(puzzle, { width: 1280, height: 900 });
			const boardCanvas = document.querySelector<HTMLElement>('.board-canvas');
			expect(boardCanvas).not.toBeNull();

			const boardWidth = boardCanvas!.style.getPropertyValue('--board-width').trim();
			const cellSize = boardCanvas!.style.getPropertyValue('--board-cell-size').trim();
			expect(boardWidth).toBe(`${expected.boardWidth}px`);
			expect(cellSize).toBe(`${expected.cellSize}px`);
			expect(boardCanvas!.style.width).not.toBe(`${puzzle.imageWidth}px`);

			const pieceSlot = await page.getByTestId('piece-slot-0').element();
			expect(pieceSlot.style.getPropertyValue('--piece-slot-size').trim()).toBe(cellSize);
		} finally {
			Object.defineProperty(window, 'innerWidth', {
				configurable: true,
				value: originalInnerWidth
			});
			Object.defineProperty(window, 'innerHeight', {
				configurable: true,
				value: originalInnerHeight
			});
		}
	});

	it('restores saved rotation state and placed pieces from progress', async () => {
		setSavedProgress({
			placedPieces: [{ pieceId: 1, x: 1, y: 0 }],
			rotationEnabled: true,
			pieceRotations: { 0: 180, 1: 0 }
		});

		await renderPuzzlePage();

		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
		await expect.poll(() => page.getByLabelText('Puzzle piece 1').query()).toBeNull();
		await expect
			.element(page.getByTestId('puzzle-piece-visual'))
			.toHaveAttribute('style', 'transform: rotate(180deg);');
	});

	it('shows the reference overlay only while the toolbar button is held', async () => {
		await renderPuzzlePage();

		const referenceButton = await page.getByLabelText('Reference').element();
		referenceButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));

		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

		referenceButton.dispatchEvent(
			new PointerEvent('pointerleave', { bubbles: true, pointerId: 1 })
		);

		await expect.poll(() => page.getByTestId('reference-overlay').query()).toBeNull();
	});

	it('dismisses reference overlay via global window pointerup with matching pointer id', async () => {
		await renderPuzzlePage();

		const referenceButton = await page.getByLabelText('Reference').element();
		referenceButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));

		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

		window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

		window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));

		await expect.poll(() => page.getByTestId('reference-overlay').query()).toBeNull();
	});

	it('clears reference overlay on window blur', async () => {
		await renderPuzzlePage();

		const referenceButton = await page.getByLabelText('Reference').element();
		referenceButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));

		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

		window.dispatchEvent(new Event('blur'));

		await expect.poll(() => page.getByTestId('reference-overlay').query()).toBeNull();
	});

	it('clears keyboard-held reference overlay on window blur', async () => {
		await renderPuzzlePage();

		const referenceButton = await page.getByLabelText('Reference').element();
		referenceButton.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

		window.dispatchEvent(new Event('blur'));

		await expect.poll(() => page.getByTestId('reference-overlay').query()).toBeNull();
	});

	it('allows toggling rotation off when restored with rotation enabled but no placed pieces', async () => {
		setSavedProgress({
			placedPieces: [],
			rotationEnabled: true,
			pieceRotations: { 0: 90, 1: 180 }
		});

		await renderPuzzlePage();

		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
		await expect.element(page.getByLabelText('Rotation mode')).toBeEnabled();

		await page.getByLabelText('Rotation mode').click();

		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');
	});

	it('clears pan state on window blur', async () => {
		await renderPuzzlePage();

		// Zoom in so canPanBoard becomes true
		await page.getByLabelText('Zoom in').click();

		const puzzleBoard = await page.getByTestId('puzzle-board').element();
		puzzleBoard.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 3,
				clientX: 100,
				clientY: 100,
				button: 0
			})
		);

		await expect.element(page.getByTestId('board-viewport')).toHaveClass(/is-panning/);

		window.dispatchEvent(new Event('blur'));

		await expect.element(page.getByTestId('board-viewport')).not.toHaveClass(/is-panning/);
	});

	it('clears the selected tray piece on window blur', async () => {
		await renderPuzzlePage();
		await selectPiece(0);

		expect(get(selectedPieceId)).toBe(0);

		window.dispatchEvent(new Event('blur'));

		expect(get(selectedPieceId)).toBeNull();
		await expect
			.element(page.getByLabelText('Puzzle piece 0'))
			.toHaveAttribute('data-selected', 'false');
	});

	it('uses the selected tray piece when showing a hint target', async () => {
		await renderPuzzlePage();
		await selectPiece(1);

		await page.getByLabelText('Hint').click();

		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-y', '0');
		await expect.element(page.getByTestId('piece-slot-1')).toHaveClass(/hinted/);
	});

	it('toggles rotation mode, rotates tray pieces, and blocks placement until upright', async () => {
		await renderPuzzlePage();

		await page.getByLabelText('Rotation mode').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
		await expect.element(page.getByRole('button', { name: 'Rotate piece 0' })).toBeVisible();
		await expect.element(page.getByLabelText('Rotation mode')).toBeEnabled();

		await page.getByRole('button', { name: 'Rotate piece 0' }).click();
		await expect
			.element(page.getByTestId('puzzle-piece-visual').first())
			.toHaveAttribute('style', 'transform: rotate(90deg);');

		setSelectedPiece(0);
		await placeSelectedPieceAt(0, 0);
		await expect.element(page.getByText('0/2')).toBeVisible();
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], true, { 0: 90, 1: 0 });

		await page.getByRole('button', { name: 'Rotate piece 0' }).click();
		await page.getByRole('button', { name: 'Rotate piece 0' }).click();
		await page.getByRole('button', { name: 'Rotate piece 0' }).click();
		await expect
			.element(page.getByTestId('puzzle-piece-visual').first())
			.toHaveAttribute('style', 'transform: rotate(0deg);');

		setSelectedPiece(0);
		await placeSelectedPieceAt(0, 0);
		await expect.element(page.getByText('1/2')).toBeVisible();
		expect(saveProgress).toHaveBeenLastCalledWith(
			'test-puzzle',
			[{ pieceId: 0, x: 0, y: 0 }],
			true,
			{ 0: 0, 1: 0 }
		);
	});

	it('updates undo and redo controls after successful placements', async () => {
		await renderPuzzlePage();
		await placePiece(0, 0, 0);

		await expect.element(page.getByText('1/2')).toBeVisible();
		await expect.element(page.getByLabelText('Undo')).toBeEnabled();
		await expect.element(page.getByLabelText('Redo')).toBeDisabled();

		await page.getByLabelText('Undo').click();
		await expect.element(page.getByText('0/2')).toBeVisible();
		await expect.element(page.getByLabelText('Redo')).toBeEnabled();
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], false, {});

		await page.getByLabelText('Redo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();
		expect(saveProgress).toHaveBeenLastCalledWith(
			'test-puzzle',
			[{ pieceId: 0, x: 0, y: 0 }],
			false,
			{}
		);
	});

	it('re-enables rotation toggle after undoing back to empty board', async () => {
		await renderPuzzlePage();

		await expect.element(page.getByLabelText('Rotation mode')).toBeEnabled();

		await placePiece(0, 0, 0);
		await expect.element(page.getByText('1/2')).toBeVisible();
		await expect.element(page.getByLabelText('Rotation mode')).toBeDisabled();

		await page.getByLabelText('Undo').click();
		await expect.element(page.getByText('0/2')).toBeVisible();
		await expect.element(page.getByLabelText('Rotation mode')).toBeEnabled();
	});

	it('keeps rotation toggle enabled after incorrect placement with no pieces placed', async () => {
		await renderPuzzlePage();

		await expect.element(page.getByLabelText('Rotation mode')).toBeEnabled();

		await selectPiece(0);
		await placeSelectedPieceAt(1, 0);
		await expect.element(page.getByTestId('piece-slot-0')).toHaveClass('rejected');

		await expect.element(page.getByLabelText('Rotation mode')).toBeEnabled();
	});

	it('records rotation-only changes as undo steps and restores them correctly', async () => {
		await renderPuzzlePage();

		await page.getByLabelText('Rotation mode').click();
		await page.getByRole('button', { name: 'Rotate piece 1' }).click();
		await placePiece(0, 0, 0);

		expect(saveProgress).toHaveBeenLastCalledWith(
			'test-puzzle',
			[{ pieceId: 0, x: 0, y: 0 }],
			true,
			{ 0: 0, 1: 90 }
		);

		await page.getByRole('button', { name: 'Rotate piece 1' }).click();
		expect(saveProgress).toHaveBeenLastCalledWith(
			'test-puzzle',
			[{ pieceId: 0, x: 0, y: 0 }],
			true,
			{ 0: 0, 1: 180 }
		);

		// First undo reverses the rotation (180 -> 90), piece remains placed
		await page.getByLabelText('Undo').click();
		expect(saveProgress).toHaveBeenLastCalledWith(
			'test-puzzle',
			[{ pieceId: 0, x: 0, y: 0 }],
			true,
			{ 0: 0, 1: 90 }
		);

		// Second undo removes the placement, rotation preserved from pre-placement state
		await page.getByLabelText('Undo').click();
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], true, { 0: 0, 1: 90 });

		// Redo re-applies the placement
		await page.getByLabelText('Redo').click();
		expect(saveProgress).toHaveBeenLastCalledWith(
			'test-puzzle',
			[{ pieceId: 0, x: 0, y: 0 }],
			true,
			{ 0: 0, 1: 90 }
		);

		// Second redo re-applies the rotation
		await page.getByLabelText('Redo').click();
		expect(saveProgress).toHaveBeenLastCalledWith(
			'test-puzzle',
			[{ pieceId: 0, x: 0, y: 0 }],
			true,
			{ 0: 0, 1: 180 }
		);
	});

	it('restores rotation mode from history snapshots during undo and redo', async () => {
		await renderPuzzlePage();

		await page.getByLabelText('Rotation mode').click();
		await page.getByRole('button', { name: 'Rotate piece 1' }).click();
		await page.getByLabelText('Rotation mode').click();

		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');

		// Undo reverts the rotation toggle-off
		await page.getByLabelText('Undo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
		await expect.element(page.getByRole('button', { name: 'Rotate piece 1' })).toBeVisible();
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], true, { 0: 0, 1: 90 });

		// Redo re-applies the rotation toggle-off
		await page.getByLabelText('Redo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], false, { 0: 0, 1: 90 });
	});

	it('pushes rotation toggle onto undo stack without any piece placements', async () => {
		await renderPuzzlePage();

		await expect.element(page.getByLabelText('Undo')).toBeDisabled();

		// Toggle rotation on — should be undoable
		await page.getByLabelText('Rotation mode').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
		await expect.element(page.getByLabelText('Undo')).toBeEnabled();

		// Toggle rotation off — another undo step
		await page.getByLabelText('Rotation mode').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');

		// Undo should revert the toggle-off
		await page.getByLabelText('Undo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], true, { 0: 0, 1: 0 });

		// Undo again should revert the toggle-on
		await page.getByLabelText('Undo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], false, {});

		// Redo should re-enable rotation
		await page.getByLabelText('Redo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
		expect(saveProgress).toHaveBeenLastCalledWith('test-puzzle', [], true, { 0: 0, 1: 0 });
	});

	it('supports keyboard shortcuts for undo and redo without clearing hint state', async () => {
		await renderPuzzlePage();
		await placePiece(0, 0, 0);
		await selectPiece(1);
		await page.getByLabelText('Hint').click();

		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
		await expect.element(page.getByTestId('piece-slot-1')).toHaveClass(/hinted/);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

		await expect.element(page.getByText('0/2')).toBeVisible();
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
		await expect.element(page.getByTestId('piece-slot-1')).toHaveClass(/hinted/);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));

		await expect.element(page.getByText('1/2')).toBeVisible();
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
		await expect.element(page.getByTestId('piece-slot-1')).toHaveClass(/hinted/);
	});

	it('clears hint state when navigating to a different puzzle', async () => {
		const nextPuzzle: Puzzle = {
			...createMockPuzzle(),
			id: 'next-puzzle',
			name: 'Next Mission',
			pieces: [
				createPiece(0, 0, 0, { puzzleId: 'next-puzzle' }),
				createPiece(1, 1, 0, { puzzleId: 'next-puzzle' })
			]
		};

		vi.mocked(fetchPuzzle).mockImplementation(async (id: string) =>
			id === 'next-puzzle' ? nextPuzzle : createMockPuzzle()
		);

		render(PuzzlePage);
		await expect.element(page.getByTestId('puzzle-board')).toBeVisible();

		await selectPiece(1);
		await page.getByLabelText('Hint').click();
		await expect.element(page.getByTestId('hint-target')).toHaveAttribute('data-x', '1');
		await expect.element(page.getByTestId('piece-slot-1')).toHaveClass(/hinted/);

		mockPageStore.set({
			url: { pathname: '/puzzle/next-puzzle' },
			params: { id: 'next-puzzle' },
			route: { id: '/puzzle/[id]' },
			status: 200,
			error: null
		});

		await expect.element(page.getByText('NEXT MISSION')).toBeVisible();
		expect(page.getByTestId('hint-target').query()).toBeNull();
		const nextPieceSlot = await page.getByTestId('piece-slot-1').element();
		expect(nextPieceSlot.classList.contains('hinted')).toBe(false);
	});

	it('clears rejected-piece state when navigating to a different puzzle', async () => {
		const nextPuzzle: Puzzle = {
			...createMockPuzzle(),
			id: 'next-puzzle',
			name: 'Next Mission',
			pieces: [
				createPiece(0, 0, 0, { puzzleId: 'next-puzzle' }),
				createPiece(1, 1, 0, { puzzleId: 'next-puzzle' })
			]
		};

		vi.mocked(fetchPuzzle).mockImplementation(async (id: string) =>
			id === 'next-puzzle' ? nextPuzzle : createMockPuzzle()
		);

		render(PuzzlePage);
		await expect.element(page.getByTestId('puzzle-board')).toBeVisible();

		// Trigger an incorrect placement: piece 0 at wrong position (1, 0)
		await selectPiece(0);
		await placeSelectedPieceAt(1, 0);
		await expect.element(page.getByTestId('piece-slot-0')).toHaveClass('rejected');

		// Navigate to a different puzzle
		mockPageStore.set({
			url: { pathname: '/puzzle/next-puzzle' },
			params: { id: 'next-puzzle' },
			route: { id: '/puzzle/[id]' },
			status: 200,
			error: null
		});

		await expect.element(page.getByText('NEXT MISSION')).toBeVisible();
		const nextSlot = await page.getByTestId('piece-slot-0').element();
		expect(nextSlot.classList.contains('rejected')).toBe(false);
	});

	it('ignores stale puzzle load results after navigating to a new puzzle', async () => {
		const firstLoad = createDeferred<Puzzle>();
		const secondLoad = createDeferred<Puzzle>();
		const nextPuzzle: Puzzle = {
			...createMockPuzzle(),
			id: 'next-puzzle',
			name: 'Next Mission',
			pieces: [
				createPiece(0, 0, 0, { puzzleId: 'next-puzzle' }),
				createPiece(1, 1, 0, { puzzleId: 'next-puzzle' })
			]
		};

		vi.mocked(fetchPuzzle).mockImplementation((id: string) => {
			if (id === 'test-puzzle') {
				return firstLoad.promise;
			}

			if (id === 'next-puzzle') {
				return secondLoad.promise;
			}

			return Promise.reject(new Error(`Unexpected puzzle id: ${id}`));
		});

		render(PuzzlePage);
		await expect.poll(() => vi.mocked(fetchPuzzle).mock.calls.length).toBe(1);

		mockPageStore.set({
			url: { pathname: '/puzzle/next-puzzle' },
			params: { id: 'next-puzzle' },
			route: { id: '/puzzle/[id]' },
			status: 200,
			error: null
		});

		await expect.poll(() => vi.mocked(fetchPuzzle).mock.calls.length).toBe(2);

		firstLoad.resolve(createMockPuzzle());
		await expect.element(page.getByText('LOADING MISSION...')).toBeVisible();
		await expect.poll(() => page.getByText('TEST MISSION').query()).toBeNull();

		secondLoad.resolve(nextPuzzle);
		await expect.element(page.getByText('NEXT MISSION')).toBeVisible();
		await expect.poll(() => page.getByText('TEST MISSION').query()).toBeNull();
	});

	it('does not re-record completion on undo/redo of the final move', async () => {
		await renderPuzzlePage();

		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);

		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		expect(saveCompletionTime).toHaveBeenCalledTimes(1);

		// Close the celebration modal via Escape on the modal element
		const modal = await page.getByTestId('celebration-modal').element();
		modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();

		// Undo the last piece — should transition from complete to incomplete
		await page.getByLabelText('Undo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();
		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();

		// Redo — should re-show celebration but NOT call saveCompletionTime again
		await page.getByLabelText('Redo').click();
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		expect(saveCompletionTime).toHaveBeenCalledTimes(1);
	});

	it('clears tray selection when redo re-places the selected piece', async () => {
		await renderPuzzlePage();
		await placePiece(0, 0, 0);

		// Undo: piece 0 goes back to the tray
		await page.getByLabelText('Undo').click();
		await expect.element(page.getByText('0/2')).toBeVisible();

		// Select piece 0 from the tray via keyboard
		await selectPiece(0);
		await expect
			.element(page.getByLabelText('Puzzle piece 0'))
			.toHaveAttribute('data-selected', 'true');

		// Redo: piece 0 is placed back on the board
		await page.getByLabelText('Redo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();

		// Selection should be cleared since piece 0 is now on the board
		expect(get(selectedPieceId)).toBeNull();
	});

	it('starts the timer when rotating a piece before any placement', async () => {
		await renderPuzzlePage();

		await expect.element(page.getByTestId('game-timer')).toHaveClass('timer-block timer-off');

		await page.getByLabelText('Rotation mode').click();
		await page.getByRole('button', { name: 'Rotate piece 0' }).click();

		await expect.element(page.getByTestId('game-timer')).toHaveClass('timer-block timer-on');
	});

	it('resets all game state when clicking PLAY AGAIN in celebration modal', async () => {
		await renderPuzzlePage();

		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();

		await page.getByRole('button', { name: 'PLAY AGAIN' }).click();

		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();
		await expect.element(page.getByText('0/2')).toBeVisible();
		await expect.element(page.getByTestId('game-timer')).toHaveClass('timer-block timer-off');
		await expect.element(page.getByLabelText('Puzzle piece 0')).toBeVisible();
		await expect.element(page.getByLabelText('Puzzle piece 1')).toBeVisible();
		await expect.element(page.getByLabelText('Undo')).toBeDisabled();
		await expect.element(page.getByLabelText('Redo')).toBeDisabled();
		expect(clearProgress).toHaveBeenCalledWith('test-puzzle');
	});

	it('navigates to home when clicking BACK TO ARCADE in celebration modal', async () => {
		await renderPuzzlePage();

		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();

		await page.getByRole('button', { name: 'BACK TO ARCADE' }).click();

		expect(goto).toHaveBeenCalledWith('/');
	});

	it('traps Tab focus within the celebration modal', async () => {
		await renderPuzzlePage();

		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();

		const playAgainBtn = await page.getByRole('button', { name: 'PLAY AGAIN' }).element();
		const backToArcadeBtn = await page.getByRole('button', { name: 'BACK TO ARCADE' }).element();

		backToArcadeBtn.focus();
		expect(document.activeElement).toBe(backToArcadeBtn);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
		expect(document.activeElement).toBe(playAgainBtn);

		playAgainBtn.focus();
		expect(document.activeElement).toBe(playAgainBtn);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
		expect(document.activeElement).toBe(backToArcadeBtn);
	});

	it('blocks undo and redo keyboard shortcuts while celebration modal is open', async () => {
		await renderPuzzlePage();

		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();

		const callsBefore = vi.mocked(saveProgress).mock.calls.length;

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));

		expect(vi.mocked(saveProgress).mock.calls.length).toBe(callsBefore);
	});

	it('zooms in and out via toolbar buttons', async () => {
		await renderPuzzlePage();

		const getScale = async () => {
			const el = await page.getByTestId('zoomable-board-frame').element();
			const match = el.getAttribute('style')?.match(/scale\(([\d.]+)\)/);
			return match ? parseFloat(match[1]) : NaN;
		};

		const initialScale = await getScale();

		await page.getByLabelText('Zoom in').click();
		expect(await getScale()).toBeGreaterThan(initialScale);

		await page.getByLabelText('Zoom out').click();
		expect(await getScale()).toBe(initialScale);
	});

	it('zooms the board on wheel events', async () => {
		await renderPuzzlePage();

		const getScale = async () => {
			const el = await page.getByTestId('zoomable-board-frame').element();
			const match = el.getAttribute('style')?.match(/scale\(([\d.]+)\)/);
			return match ? parseFloat(match[1]) : NaN;
		};

		const initialScale = await getScale();

		const frameEl = await page.getByTestId('zoomable-board-frame').element();
		frameEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
		expect(await getScale()).toBeGreaterThan(initialScale);

		frameEl.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
		expect(await getScale()).toBe(initialScale);
	});

	it('updates viewport dimensions on window resize', async () => {
		const originalInnerWidth = window.innerWidth;
		const originalInnerHeight = window.innerHeight;
		try {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
			Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

			await renderPuzzlePage();

			const getBoardWidth = () => {
				const boardCanvas = document.querySelector<HTMLElement>('.board-canvas');
				return boardCanvas?.style.getPropertyValue('--board-width').trim() ?? '';
			};

			const initialWidth = getBoardWidth();

			Object.defineProperty(window, 'innerWidth', {
				configurable: true,
				value: 600
			});
			Object.defineProperty(window, 'innerHeight', {
				configurable: true,
				value: 400
			});
			window.dispatchEvent(new Event('resize'));

			await expect.poll(() => getBoardWidth()).not.toBe(initialWidth);
		} finally {
			Object.defineProperty(window, 'innerWidth', {
				configurable: true,
				value: originalInnerWidth
			});
			Object.defineProperty(window, 'innerHeight', {
				configurable: true,
				value: originalInnerHeight
			});
		}
	});
});
