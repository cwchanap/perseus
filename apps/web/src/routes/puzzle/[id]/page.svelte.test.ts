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

// Hoisted override for the sealedCompletion field in the mocked
// loadSession snapshot. When non-null, the mock returns a resumed session
// with a sealedCompletion, exercising the resume_completion_effects path.
const sealedCompletionOverride = vi.hoisted(() => ({
	value: null as null | Record<string, unknown>
}));

// Configurable puzzleSource mock so individual tests can simulate a
// local-only quick-puzzle source (`source: 'local'`) without leaking the
// device-local `q-...` id to the API-backed `fetchPuzzle` path.
const puzzleSourceState = vi.hoisted(() => ({
	// null = fall back to the default api-source factory (calls fetchPuzzle).
	override: null as null | (() => Promise<LoadedPuzzleSource>)
}));

// Hoisted spies shared with the createSessionStorageAdapter mock so tests can
// assert checkpoint behavior directly. vi.clearAllMocks() only clears call
// history, so these references remain valid across tests.
const sessionStorageSpies = vi.hoisted(() => ({
	saveSession: vi.fn(),
	clearSession: vi.fn()
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

vi.mock('$lib/services/puzzleSource', () => ({
	loadPuzzleSource: vi.fn((id: string) => {
		const override = puzzleSourceState.override;
		if (override) {
			return override();
		}
		// Default: delegate to the real api-source path by calling the mocked
		// fetchPuzzle. The bindings below are initialized by the time this
		// factory is actually invoked during render.
		return fetchPuzzle(id).then((fetched) => ({
			puzzle: fetched,
			resolvePieceImage: (piece: { id: number }) => getPieceImageUrl(fetched.id, piece.id),
			resolveReferenceImage: () =>
				fetched.hasReference === true ? getReferenceImageUrl(fetched.id) : null,
			source: 'api' as const,
			cleanup: () => {
				/* no-op for API */
			}
		}));
	})
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

vi.mock('$lib/services/gameplay/session/persistence', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('$lib/services/gameplay/session/persistence')>();
	return {
		...actual,
		createBrowserRunIdFactory: () => ({ create: () => 'test-run-id' }),
		createSessionStorageAdapter: () => ({
			loadSession: (puzzleId: string) => {
				if (progressState.value?.puzzleId === puzzleId) {
					return {
						status: 'loaded' as const,
						snapshot: {
							schemaVersion: 1 as const,
							puzzleId,
							source: 'api' as const,
							lifecycle: 'active' as const,
							mode: 'timed' as const,
							runId: 'test-run-id',
							origin: 'resumed' as const,
							elapsedActiveSeconds: null,
							timingQuality: 'known' as const,
							timerStarted: false,
							placedPieces: progressState.value.placedPieces.map((p) => ({ ...p })),
							trayOrder: [0, 1],
							rotationEnabled: progressState.value.rotationEnabled,
							pieceRotations: { ...progressState.value.pieceRotations },
							counters: {
								incorrectAttempts: 0,
								hintsUsed: 0,
								referenceActivations: 0
							},
							facts: {
								rotationUsed: false,
								hintUsed: false,
								ghostReferenceUsed: false
							},
							hasUserActivity: false,
							resultClass: 'standard_timed' as const,
							sealedCompletion: sealedCompletionOverride.value,
							lastUpdated: Date.now()
						}
					};
				}
				return { status: 'missing' as const };
			},
			saveSession: sessionStorageSpies.saveSession,
			clearSession: sessionStorageSpies.clearSession,
			isResumable: () => false
		}),
		serializeSession: vi.fn(() => null)
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
		recordCompletion: vi.fn(() => Promise.resolve()),
		recordCompletionLegacy: vi.fn(() => Promise.resolve()),
		getPlayerSession: vi.fn(() => Promise.resolve({ authenticated: false })),
		logoutPlayer: vi.fn(() => Promise.resolve()),
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
	saveCompletionTime: vi.fn(() => Promise.resolve(false)),
	recordLocalCompletion: vi.fn(() =>
		Promise.resolve({
			status: 'recorded' as const,
			isNewStandardBest: false,
			stats: {
				schemaVersion: 1,
				puzzleId: 'test-puzzle',
				standardBestTime: null,
				standardBestCompletedAt: null,
				totalCompletions: 1,
				lastCompletedAt: Date.now(),
				lastRecordedRunId: 'test-run-id',
				recordedRunIds: ['test-run-id']
			}
		})
	)
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

import {
	fetchPuzzle,
	ApiError,
	recordCompletion,
	getPieceImageUrl,
	getReferenceImageUrl
} from '$lib/services/api';
import type { LoadedPuzzleSource } from '$lib/services/puzzleSource';
import { recordLocalCompletion, getBestTime } from '$lib/services/stats';
import { serializeSession } from '$lib/services/gameplay/session/persistence';
import { shuffleArray } from '$lib/utils/shuffle';
import { goto } from '$app/navigation';

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

async function getPieceRotation(pieceId: number): Promise<number> {
	const piece = await page.getByLabelText(`Puzzle piece ${pieceId}`).element();
	const visual = piece.querySelector('[data-testid="puzzle-piece-visual"]');
	const style = visual?.getAttribute('style') ?? '';
	const match = style.match(/rotate\(([\d.]+)deg\)/);
	return match ? parseInt(match[1], 10) : 0;
}

describe('Puzzle route gameplay integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		progressState.value = null;
		sealedCompletionOverride.value = null;
		puzzleSourceState.override = null;
		mockPageStore.set({
			url: { pathname: '/puzzle/test-puzzle' },
			params: { id: 'test-puzzle' },
			route: { id: '/puzzle/[id]' },
			status: 200,
			error: null
		});
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

	it('shuffles the tray order on a fresh puzzle load (not sorted ascending)', async () => {
		// The route must supply a shuffled initialTrayOrder for fresh sessions.
		// Without it, freshState sorts piece IDs ascending, producing a
		// deterministic tray on every first play. The pre-PR route shuffled
		// every newly loaded puzzle; this test preserves that contract.
		vi.mocked(shuffleArray).mockImplementationOnce(
			<T>(values: T[]) => [...values].reverse() as T[]
		);
		await renderPuzzlePage();

		// With the reversed shuffle, piece 1 should appear before piece 0.
		const slot0 = await page.getByTestId('piece-slot-0').element();
		const slot1 = await page.getByTestId('piece-slot-1').element();
		const slots = document.querySelectorAll('[data-testid^="piece-slot-"]');
		expect(slots[0]).toBe(slot1);
		expect(slots[1]).toBe(slot0);
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

		await expect
			.element(page.getByLabelText('Puzzle piece 0'))
			.toHaveAttribute('data-selected', 'true');

		window.dispatchEvent(new Event('blur'));

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

		await selectPiece(0);
		await placeSelectedPieceAt(0, 0);
		await expect.element(page.getByText('0/2')).toBeVisible();

		await page.getByRole('button', { name: 'Rotate piece 0' }).click();
		await page.getByRole('button', { name: 'Rotate piece 0' }).click();
		await page.getByRole('button', { name: 'Rotate piece 0' }).click();
		await expect
			.element(page.getByTestId('puzzle-piece-visual').first())
			.toHaveAttribute('style', 'transform: rotate(0deg);');

		// Piece 0 remains selected from the selectPiece(0) above: a rejected
		// placement does not clear selection, and rotating does not either.
		// Re-selecting would now toggle it off (Enter on a selected piece
		// deselects), so place the still-selected piece directly.
		await placeSelectedPieceAt(0, 0);
		await expect.element(page.getByText('1/2')).toBeVisible();
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

		await page.getByLabelText('Redo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();
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
		await expect.element(page.getByText('1/2')).toBeVisible();
		expect(await getPieceRotation(1)).toBe(90);

		await page.getByRole('button', { name: 'Rotate piece 1' }).click();
		await expect.element(page.getByText('1/2')).toBeVisible();
		expect(await getPieceRotation(1)).toBe(180);

		// First undo reverses the rotation (180 -> 90), piece remains placed
		await page.getByLabelText('Undo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();
		expect(await getPieceRotation(1)).toBe(90);

		// Second undo removes the placement, rotation preserved from pre-placement state
		await page.getByLabelText('Undo').click();
		await expect.element(page.getByText('0/2')).toBeVisible();
		expect(await getPieceRotation(1)).toBe(90);

		// Redo re-applies the placement
		await page.getByLabelText('Redo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();
		expect(await getPieceRotation(1)).toBe(90);

		// Second redo re-applies the rotation
		await page.getByLabelText('Redo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();
		expect(await getPieceRotation(1)).toBe(180);
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

		// Redo re-applies the rotation toggle-off
		await page.getByLabelText('Redo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');
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

		// Undo again should revert the toggle-on
		await page.getByLabelText('Undo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'false');

		// Redo should re-enable rotation
		await page.getByLabelText('Redo').click();
		await expect
			.element(page.getByLabelText('Rotation mode'))
			.toHaveAttribute('aria-pressed', 'true');
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
		expect(recordLocalCompletion).toHaveBeenCalledTimes(1);
		expect(recordCompletion).toHaveBeenCalledTimes(1);

		// Close the celebration modal via Escape on the modal element
		const modal = await page.getByTestId('celebration-modal').element();
		modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();

		// Undo the last piece — should transition from complete to incomplete
		await page.getByLabelText('Undo').click();
		await expect.element(page.getByText('1/2')).toBeVisible();
		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();

		// Redo — should re-show celebration but NOT call recordLocalCompletion again
		await page.getByLabelText('Redo').click();
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		expect(recordLocalCompletion).toHaveBeenCalledTimes(1);
		// Remote sync should also remain at a single call across undo/redo.
		expect(recordCompletion).toHaveBeenCalledTimes(1);
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
		await expect.poll(() => page.getByLabelText('Puzzle piece 0').query()).toBeNull();
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
	});

	it('records completion again after Play Again even if the prior POST resolves late', async () => {
		// Regression: a stale recordCompletion().then() from the first solve
		// would re-acknowledge the old seal after Play Again started a new run,
		// causing the second solve to skip both the local best-time save and
		// the server completion POST. The sealed-completion run ID guards the
		// callback so only the active run's seal can be acknowledged.
		const firstPost = createDeferred<void>();
		vi.mocked(recordCompletion).mockImplementationOnce(() => firstPost.promise);
		await renderPuzzlePage();

		// First solve triggers the (deferred) server POST.
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		expect(recordLocalCompletion).toHaveBeenCalledTimes(1);
		expect(recordCompletion).toHaveBeenCalledTimes(1);

		// Play Again before the first POST resolves — starts a new run with a
		// fresh seal, so the in-flight callback's stale run ID cannot
		// acknowledge the new seal.
		await page.getByRole('button', { name: 'PLAY AGAIN' }).click();
		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();

		// The stale first POST now resolves. Its acknowledge_completion_effect
		// dispatch carries the old run ID, which no longer matches the active
		// seal's run ID, so it is rejected as a run_id_mismatch no-op.
		firstPost.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Second solve must still record locally and POST to the server.
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		expect(recordLocalCompletion).toHaveBeenCalledTimes(2);
		expect(recordCompletion).toHaveBeenCalledTimes(2);
	});

	it('does not reopen the celebration modal when a stale local-stats write resolves after Play Again', async () => {
		// Regression: handleLocalStatsEffect awaited recordLocalCompletion then
		// unconditionally mutated showCelebration/isNewBest/bestTime. If the
		// user hit Play Again while the (Web-Lock-queued) write was pending,
		// the stale completion reopened the modal and applied the old run's
		// best-time presentation to the new run. The UI mutations must be
		// fenced to the originating run, like the server-POST case above.
		const staleLocalWrite = createDeferred<Awaited<ReturnType<typeof recordLocalCompletion>>>();
		vi.mocked(recordLocalCompletion).mockImplementationOnce(() => staleLocalWrite.promise);
		await renderPuzzlePage();

		// First solve triggers the (deferred) local stats write.
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		expect(recordLocalCompletion).toHaveBeenCalledTimes(1);

		// Play Again before the local write resolves — abandons the run and
		// starts a fresh one with a new seal/run id.
		await page.getByRole('button', { name: 'PLAY AGAIN' }).click();
		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();

		// The stale local write now resolves with a new-best verdict for the
		// OLD run. Its acknowledge dispatch is run-id guarded, but the UI
		// mutations (showCelebration/isNewBest) must also be fenced so the
		// modal does not reopen on the new run.
		staleLocalWrite.resolve({
			status: 'recorded',
			isNewStandardBest: true,
			stats: {
				schemaVersion: 1,
				puzzleId: 'test-puzzle',
				standardBestTime: 42,
				standardBestCompletedAt: Date.now(),
				totalCompletions: 1,
				lastCompletedAt: Date.now(),
				lastRecordedRunId: 'test-run-id',
				recordedRunIds: ['test-run-id']
			}
		});
		// Flush the pending handleLocalStatsEffect continuation.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// The stale run's modal/badge must NOT reappear on the new run.
		await expect.poll(() => page.getByTestId('celebration-modal').query()).toBeNull();
		await expect.poll(() => page.getByText('NEW RECORD').query()).toBeNull();
	});

	it('does not POST completion to the API for local-source quick puzzles', async () => {
		// Regression: quick puzzles use device-local `q-...` ids that
		// loadPuzzleSource deliberately keeps off the API. An unconditional
		// recordCompletion(puzzle.id, ...) would leak the `q-...` id to
		// /api/puzzles/:id/complete on every quick solve and get rejected.
		// The completion call must be gated to api-source puzzles.
		const quickPuzzle = createMockPuzzle();
		quickPuzzle.id = 'q-local-only';
		puzzleSourceState.override = () =>
			Promise.resolve({
				puzzle: quickPuzzle,
				resolvePieceImage: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
				resolveReferenceImage: () => null,
				source: 'local',
				cleanup: () => {}
			} satisfies LoadedPuzzleSource);
		mockPageStore.set({
			url: { pathname: '/puzzle/q-local-only' },
			params: { id: 'q-local-only' },
			route: { id: '/puzzle/[id]' },
			status: 200,
			error: null
		});

		render(PuzzlePage);
		await expect.element(page.getByTestId('puzzle-board')).toBeVisible();

		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();

		// Local best time is still recorded for quick puzzles.
		expect(recordLocalCompletion).toHaveBeenCalledTimes(1);
		expect(recordLocalCompletion).toHaveBeenCalledWith(
			'q-local-only',
			expect.objectContaining({ runId: expect.any(String) })
		);
		// But the server completion endpoint is never hit — no id leak.
		expect(recordCompletion).not.toHaveBeenCalled();
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

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));

		// Board state remains complete — undo/redo shortcuts were blocked.
		await expect.element(page.getByText('2/2')).toBeVisible();
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

	it('shows 404 error panel when puzzle is not found', async () => {
		vi.mocked(fetchPuzzle).mockRejectedValue(new ApiError(404, 'not_found', 'Puzzle not found'));
		render(PuzzlePage);
		await expect.element(page.getByText('Mission no longer available')).toBeVisible();
		await expect.element(page.getByText(/This mission may have been deleted/)).toBeVisible();
		await expect.element(page.getByText('RETURN TO ARCADE')).toBeVisible();
	});

	it('shows generic error panel for non-404 load failures', async () => {
		vi.mocked(fetchPuzzle).mockRejectedValue(new Error('Network error'));
		render(PuzzlePage);
		await expect.element(page.getByText('Failed to load mission')).toBeVisible();
		await expect.element(page.getByText(/An error occurred while loading/)).toBeVisible();
	});

	it('shows NEW RECORD badge when completion is a new personal best', async () => {
		vi.mocked(recordLocalCompletion).mockResolvedValueOnce({
			status: 'recorded',
			isNewStandardBest: true,
			stats: {
				schemaVersion: 1,
				puzzleId: 'test-puzzle',
				standardBestTime: 42,
				standardBestCompletedAt: Date.now(),
				totalCompletions: 1,
				lastCompletedAt: Date.now(),
				lastRecordedRunId: 'test-run-id',
				recordedRunIds: ['test-run-id']
			}
		});
		vi.mocked(getBestTime).mockReturnValueOnce(null);
		await renderPuzzlePage();
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);
		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		await expect.element(page.getByText('NEW RECORD')).toBeVisible();
		await expect.element(page.getByText('PERSONAL BEST')).toBeVisible();
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

	it.each([
		{ status: 400, code: 'bad_request', message: 'Invalid request' },
		{ status: 401, code: 'unauthorized', message: 'Unauthorized' },
		{ status: 404, code: 'not_found', message: 'Puzzle not found' },
		{ status: 409, code: 'run_id_conflict', message: 'Conflict' },
		{ status: 429, code: 'quota_exceeded', message: 'Too many requests' },
		{ status: 500, code: 'internal_error', message: 'Server error' }
	])(
		'handles server submission failure with a $status ApiError ($code)',
		async ({ status, code, message }) => {
			vi.mocked(recordCompletion).mockRejectedValueOnce(new ApiError(status, code, message));
			await renderPuzzlePage();
			await placePiece(0, 0, 0);
			await placePiece(1, 1, 0);

			await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
			// The local stats still recorded; the server failure is acknowledged gracefully.
			expect(recordLocalCompletion).toHaveBeenCalledTimes(1);
		}
	);

	it('handles server submission failure with a non-ApiError (network_error)', async () => {
		vi.mocked(recordCompletion).mockRejectedValueOnce(new Error('Network failure'));
		await renderPuzzlePage();
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);

		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
	});

	it('retries server submission from the celebration modal after a retryable 500 failure', async () => {
		// Regression: a transient 5xx during recordCompletion permanently lost
		// the server record because retry_completion_effects was never dispatched
		// from the route. The modal now surfaces a RETRY SYNC affordance for
		// retryable failures; clicking it re-emits the server_submission effect.
		vi.mocked(recordCompletion).mockRejectedValueOnce(
			new ApiError(500, 'internal_error', 'Server error')
		);
		await renderPuzzlePage();
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);

		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		// The first attempt failed with a retryable 500.
		expect(recordCompletion).toHaveBeenCalledTimes(1);
		await expect.element(page.getByTestId('server-retry-banner')).toBeVisible();

		// The retry attempt succeeds.
		vi.mocked(recordCompletion).mockResolvedValueOnce(undefined);
		await page.getByTestId('retry-server-submission').click();

		// Flush the async handleServerSubmissionEffect retry + acknowledge.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(recordCompletion).toHaveBeenCalledTimes(2);
		// Succeeded → seal's serverSubmission is no longer retryable → banner hidden.
		await expect.poll(() => page.getByTestId('server-retry-banner').query()).toBeNull();
	});

	it('does not show a retry affordance for a terminal (non-retryable) 404 failure', async () => {
		vi.mocked(recordCompletion).mockRejectedValueOnce(
			new ApiError(404, 'not_found', 'Puzzle not found')
		);
		await renderPuzzlePage();
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);

		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		await expect.poll(() => page.getByTestId('server-retry-banner').query()).toBeNull();
	});

	it('does not claim NEW RECORD when local stats storage fails', async () => {
		vi.mocked(recordLocalCompletion).mockResolvedValueOnce({
			status: 'failed',
			isNewStandardBest: true,
			inMemoryStats: {
				schemaVersion: 1,
				puzzleId: 'test-puzzle',
				standardBestTime: 42,
				standardBestCompletedAt: Date.now(),
				totalCompletions: 1,
				lastCompletedAt: Date.now(),
				lastRecordedRunId: 'test-run-id',
				recordedRunIds: ['test-run-id']
			}
		});
		vi.mocked(getBestTime).mockReturnValueOnce(null);
		await renderPuzzlePage();
		await placePiece(0, 0, 0);
		await placePiece(1, 1, 0);

		await expect.element(page.getByTestId('celebration-modal')).toBeVisible();
		// The in-memory new-best presentation is still available (PERSONAL BEST
		// label + time), but the persisted-best wording (NEW RECORD) is
		// suppressed because the local write did not succeed.
		await expect.element(page.getByText('PERSONAL BEST')).toBeVisible();
		await expect.element(page.getByTestId('new-best-unsaved')).toBeVisible();
		await expect.poll(() => page.getByText('NEW RECORD').query()).toBeNull();
	});

	it('checkpoints the session to storage when serializeSession returns a snapshot', async () => {
		// Make serializeSession return a non-null snapshot so saveSession is called.
		vi.mocked(serializeSession).mockReturnValue({
			schemaVersion: 1,
			puzzleId: 'test-puzzle',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'test-run-id',
			origin: 'new',
			elapsedActiveSeconds: 0,
			timingQuality: 'known',
			timerStarted: false,
			placedPieces: [{ pieceId: 0, x: 0, y: 0 }],
			trayOrder: [0, 1],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: true,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: Date.now()
		});
		await renderPuzzlePage();
		await placePiece(0, 0, 0);

		// checkpointSession is called after each placement; verify the shared
		// saveSession spy was invoked (the checkpoint path persisted a snapshot).
		expect(sessionStorageSpies.saveSession).toHaveBeenCalled();
	});

	it('fires the periodic checkpoint interval', async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(serializeSession).mockReturnValue({
				schemaVersion: 1,
				puzzleId: 'test-puzzle',
				source: 'api',
				lifecycle: 'active',
				mode: 'timed',
				runId: 'test-run-id',
				origin: 'new',
				elapsedActiveSeconds: 0,
				timingQuality: 'known',
				timerStarted: false,
				placedPieces: [],
				trayOrder: [0, 1],
				rotationEnabled: false,
				pieceRotations: {},
				counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
				facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
				hasUserActivity: false,
				resultClass: 'standard_timed',
				sealedCompletion: null,
				lastUpdated: Date.now()
			});
			vi.mocked(fetchPuzzle).mockResolvedValue(createMockPuzzle());
			render(PuzzlePage);

			// Wait for the puzzle board to render (uses real microtasks).
			await vi.advanceTimersByTimeAsync(0);

			const callsBeforeInterval = vi.mocked(serializeSession).mock.calls.length;

			// Advance past the CHECKPOINT_INTERVAL_MS (5_000ms) to fire the interval.
			await vi.advanceTimersByTimeAsync(5_100);

			expect(vi.mocked(serializeSession).mock.calls.length).toBeGreaterThan(callsBeforeInterval);
		} finally {
			vi.useRealTimers();
		}
	});
});

// --- Patch coverage: defensive guards and event handler branches --------------

describe('Puzzle page defensive guard coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		progressState.value = null;
		sealedCompletionOverride.value = null;
		puzzleSourceState.override = null;
		mockPageStore.set({
			url: { pathname: '/puzzle/test-puzzle' },
			params: { id: 'test-puzzle' },
			route: { id: '/puzzle/[id]' },
			status: 200,
			error: null
		});
	});

	it('ignores undo/redo keyboard shortcuts while the puzzle is still loading', async () => {
		const loadDeferred = createDeferred<Puzzle>();
		vi.mocked(fetchPuzzle).mockReturnValue(loadDeferred.promise);
		render(PuzzlePage);

		await expect.element(page.getByText('LOADING MISSION...')).toBeVisible();

		// These shortcuts should be no-ops since sessionStore is null.
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));

		// Page is still loading — no crash, no board rendered.
		await expect.element(page.getByText('LOADING MISSION...')).toBeVisible();

		loadDeferred.resolve(createMockPuzzle());
		await expect.element(page.getByTestId('puzzle-board')).toBeVisible();
	});

	it('handles placement_rejected session events for non-upright rotated pieces', async () => {
		await renderPuzzlePage();

		// Enable rotation mode and rotate piece 0 to 90 degrees (non-upright).
		await page.getByLabelText('Rotation mode').click();
		await page.getByRole('button', { name: 'Rotate piece 0' }).click();

		// Attempt to place the non-upright piece at its correct position.
		// The PuzzleBoard sees correct coordinates and calls onPiecePlaced,
		// which dispatches attempt_placement to the session. The session
		// rejects it (non_upright) and emits a placement_rejected event.
		await selectPiece(0);
		await placeSelectedPieceAt(0, 0);

		// The placement_rejected event handler sets rejectedPiece, which
		// triggers the rejected animation on the piece slot.
		await expect.element(page.getByTestId('piece-slot-0')).toHaveClass(/rejected/);
		// Board should still show 0/2 (placement was rejected).
		await expect.element(page.getByText('0/2')).toBeVisible();
	});

	it('clears a pending rejected-piece timeout when a second rejection arrives', async () => {
		await renderPuzzlePage();

		// First incorrect placement triggers the rejected animation.
		await selectPiece(0);
		await placeSelectedPieceAt(1, 0);
		await expect.element(page.getByTestId('piece-slot-0')).toHaveClass(/rejected/);

		// Second incorrect placement on the same piece should clear the
		// existing timeout and set a new one (exercises the
		// clearTimeout branch in the rejected-piece handler). The piece is
		// still selected from the first attempt (a rejected placement does
		// not clear selection), so place it directly — re-selecting would
		// toggle selection off.
		await placeSelectedPieceAt(1, 0);
		await expect.element(page.getByTestId('piece-slot-0')).toHaveClass(/rejected/);
	});

	it('does not crash when the checkpoint interval fires during loading', async () => {
		// During the loading state, the PuzzleBoard is not rendered, so
		// handlePiecePlaced cannot be called via UI. However, the
		// checkpointSession periodic interval can fire during loading,
		// exercising the null-session guard.
		vi.useFakeTimers();
		try {
			vi.mocked(fetchPuzzle).mockReturnValue(new Promise(() => {})); // never resolves
			render(PuzzlePage);
			await vi.advanceTimersByTimeAsync(0);

			// Advance past CHECKPOINT_INTERVAL_MS (5_000ms) while loading.
			// checkpointSession should no-op via the null-session guard.
			await vi.advanceTimersByTimeAsync(5_100);

			await expect.element(page.getByText('LOADING MISSION...')).toBeVisible();
		} finally {
			vi.useRealTimers();
		}
	});

	it('dispatches cancel_selection when a selected tray piece receives Enter', async () => {
		await renderPuzzlePage();
		await selectPiece(0);

		await expect
			.element(page.getByLabelText('Puzzle piece 0'))
			.toHaveAttribute('data-selected', 'true');

		// Pressing Enter on the already-selected piece deselects it on the
		// first press. Suppression of the Svelte 5 delegation double-fire is
		// scoped to the originating select event's identity, so it never
		// latches across independent keypresses (no two-press-to-deselect).
		const piece = await page.getByLabelText('Puzzle piece 0').element();
		piece.focus();
		piece.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		// A single Enter dispatches cancel_selection, clearing selection.
		await expect
			.element(page.getByLabelText('Puzzle piece 0'))
			.toHaveAttribute('data-selected', 'false');
	});

	it('persists the session on pagehide', async () => {
		vi.mocked(serializeSession).mockReturnValue({
			schemaVersion: 1,
			puzzleId: 'test-puzzle',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'test-run-id',
			origin: 'new',
			elapsedActiveSeconds: 0,
			timingQuality: 'known',
			timerStarted: false,
			placedPieces: [],
			trayOrder: [0, 1],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: false,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: Date.now()
		});
		await renderPuzzlePage();

		const callsBefore = sessionStorageSpies.saveSession.mock.calls.length;
		window.dispatchEvent(new Event('pagehide'));

		// handlePageHide → persistSessionFinal → checkpointSession → saveSession.
		expect(sessionStorageSpies.saveSession.mock.calls.length).toBeGreaterThan(callsBefore);
	});

	it('clears the rejected-piece highlight after the timeout fires', async () => {
		vi.useFakeTimers();
		try {
			await renderPuzzlePage();

			// Trigger an incorrect placement to set rejectedPiece and start the
			// timeout that clears it (lines 432-433).
			await selectPiece(0);
			await placeSelectedPieceAt(1, 0);
			await expect.element(page.getByTestId('piece-slot-0')).toHaveClass(/rejected/);

			// Advance past REJECTED_DURATION_MS (500ms) to fire the timeout
			// callback that resets rejectedPiece and rejectedPieceTimeout.
			await vi.advanceTimersByTimeAsync(600);

			await expect.element(page.getByTestId('piece-slot-0')).not.toHaveClass(/rejected/);
		} finally {
			vi.useRealTimers();
		}
	});

	it('dispatches setDocumentHidden on visibilitychange', async () => {
		await renderPuzzlePage();

		// The visibilitychange listener calls setDocumentHidden on the
		// sessionStore. We verify it doesn't throw and the page remains stable.
		document.dispatchEvent(new Event('visibilitychange'));

		await expect.element(page.getByTestId('puzzle-board')).toBeVisible();
	});

	it('persists the session immediately when the document becomes hidden', async () => {
		vi.mocked(serializeSession).mockReturnValue({
			schemaVersion: 1,
			puzzleId: 'test-puzzle',
			source: 'api',
			lifecycle: 'active',
			mode: 'timed',
			runId: 'test-run-id',
			origin: 'new',
			elapsedActiveSeconds: 0,
			timingQuality: 'known',
			timerStarted: false,
			placedPieces: [],
			trayOrder: [0, 1],
			rotationEnabled: false,
			pieceRotations: {},
			counters: { incorrectAttempts: 0, hintsUsed: 0, referenceActivations: 0 },
			facts: { rotationUsed: false, hintUsed: false, ghostReferenceUsed: false },
			hasUserActivity: false,
			resultClass: 'standard_timed',
			sealedCompletion: null,
			lastUpdated: Date.now()
		});
		await renderPuzzlePage();

		const callsBefore = sessionStorageSpies.saveSession.mock.calls.length;
		// `document.hidden` is an inherited accessor on Document.prototype,
		// so getOwnPropertyDescriptor returns undefined and the override
		// creates an own property that shadows it. Remove that own property
		// in finally so the prototype accessor is restored for subsequent
		// tests.
		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		try {
			document.dispatchEvent(new Event('visibilitychange'));
		} finally {
			delete (document as { hidden?: unknown }).hidden;
		}

		// handleVisibilityChange must checkpointSession after suspending the
		// timer, so a mobile browser that kills the hidden page without
		// delivering pagehide does not lose the last visible interval.
		expect(sessionStorageSpies.saveSession.mock.calls.length).toBeGreaterThan(callsBefore);
	});

	it('dispatches resume_completion_effects when restoring a session with a sealed completion', async () => {
		// Configure the mock loadSession to return a snapshot with a
		// sealedCompletion so the page dispatches resume_completion_effects
		// on load (line 603).
		sealedCompletionOverride.value = {
			runId: 'test-run-id',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 42,
			completedAt: Date.now(),
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'pending' }
		};
		setSavedProgress({
			placedPieces: [
				{ pieceId: 0, x: 0, y: 0 },
				{ pieceId: 1, x: 1, y: 0 }
			]
		});

		await renderPuzzlePage();

		// The restored session is completed; resume_completion_effects is
		// dispatched. The page should show the completed state ("ALL PIECES
		// PLACED") without crashing.
		await expect.element(page.getByText('ALL PIECES PLACED')).toBeVisible();
	});

	it('does not auto-retry unauthorized server submission failures on hydration', async () => {
		// A persisted session with an unauthorized server-submission failure
		// must NOT be re-submitted on hydration. The auto-retry skips
		// unauthorized failures (includeUnauthorized defaults to false); only
		// an explicit user retry or an auth transition triggers a retry.
		sealedCompletionOverride.value = {
			runId: 'test-run-id',
			resultClass: 'standard_timed',
			timingQuality: 'known',
			elapsedActiveSeconds: 42,
			completedAt: Date.now(),
			localStats: { status: 'succeeded' },
			serverSubmission: { status: 'failed', code: 'unauthorized', retryable: true }
		};
		setSavedProgress({
			placedPieces: [
				{ pieceId: 0, x: 0, y: 0 },
				{ pieceId: 1, x: 1, y: 0 }
			]
		});

		await renderPuzzlePage();

		// The restored session is completed; the unauthorized failure is NOT
		// re-submitted (recordCompletion is not called).
		expect(recordCompletion).not.toHaveBeenCalled();
		await expect.element(page.getByText('ALL PIECES PLACED')).toBeVisible();
	});
});
