import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzlePage from './+page.svelte';
import type { GameProgress, PlacedPiece, Puzzle, PuzzlePiece } from '$lib/types/puzzle';
import type { Rotation } from '$lib/services/gameplay/rotation';

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
import { saveProgress } from '$lib/services/progress';
import { clearSelectedPiece, setSelectedPiece } from '$lib/stores/pieceSelection';

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
		pieces: [createPiece(0, 0, 0), createPiece(1, 1, 0)]
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
		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

		window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
		await expect.element(page.getByTestId('reference-overlay')).toBeVisible();

		referenceButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));

		await expect.poll(() => page.getByTestId('reference-overlay').query()).toBeNull();
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
		await expect.element(page.getByLabelText('Rotation mode')).toBeDisabled();

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
});
