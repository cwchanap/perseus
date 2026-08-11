import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import GalleryPage from './+page.svelte';
import type { PuzzleSummary } from '$lib/types/puzzle';
import { fetchPuzzles, ApiError } from '$lib/services/api';
import { listQuick } from '$lib/services/quickPuzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
import { discoverGalleryProgress } from '$lib/services/gameplay/galleryProgress';

vi.mock('$lib/services/api', () => {
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
		fetchPuzzles: vi.fn().mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 }),
		getThumbnailUrl: vi.fn((id: string) => `/api/puzzles/${id}/thumbnail`),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn().mockReturnValue(null)
}));

vi.mock('$lib/services/quickPuzzle', () => ({
	listQuick: vi.fn().mockReturnValue([])
}));

vi.mock('$lib/services/gameplay/galleryProgress', () => ({
	discoverGalleryProgress: vi.fn().mockReturnValue({
		byPuzzleId: new Map(),
		newest: null
	})
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
}));

const makePuzzle = (id: string, overrides: Partial<PuzzleSummary> = {}): PuzzleSummary => ({
	id,
	name: `Puzzle ${id}`,
	pieceCount: 225,
	status: 'ready',
	...overrides
});

const storedQuickPuzzleFixture: StoredQuickPuzzle = {
	id: 'q-local',
	name: 'Local Mission',
	aspectRatio: '1:1',
	pieceCount: 4,
	gridRows: 2,
	gridCols: 2,
	imageWidth: 100,
	imageHeight: 100,
	imageDataUrl: 'data:image/jpeg;base64,',
	pieces: [
		{
			id: 0,
			correctX: 0,
			correctY: 0,
			edges: { top: 'flat', right: 'tab', bottom: 'blank', left: 'flat' }
		},
		{
			id: 1,
			correctX: 1,
			correctY: 0,
			edges: { top: 'flat', right: 'flat', bottom: 'tab', left: 'blank' }
		},
		{
			id: 2,
			correctX: 0,
			correctY: 1,
			edges: { top: 'tab', right: 'blank', bottom: 'flat', left: 'flat' }
		},
		{
			id: 3,
			correctX: 1,
			correctY: 1,
			edges: { top: 'blank', right: 'flat', bottom: 'flat', left: 'tab' }
		}
	],
	createdAt: 1_000,
	schemaVersion: 1
};

type FetchPuzzlesResult = Awaited<ReturnType<typeof fetchPuzzles>>;
const mockedFetchPuzzles = vi.mocked(fetchPuzzles);
const mockedListQuick = vi.mocked(listQuick);
const mockedDiscoverGalleryProgress = vi.mocked(discoverGalleryProgress);

const observe = vi.fn();
const disconnect = vi.fn();
let intersectionCallback: IntersectionObserverCallback | null = null;
class MockIntersectionObserver {
	constructor(callback: IntersectionObserverCallback) {
		intersectionCallback = callback;
	}
	observe = observe;
	disconnect = disconnect;
	unobserve = vi.fn();
	takeRecords = vi.fn();
}

describe('Gallery Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		intersectionCallback = null;
		vi.stubGlobal('IntersectionObserver', MockIntersectionObserver as never);
		mockedFetchPuzzles.mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
		mockedListQuick.mockReturnValue([]);
		mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shows puzzle cards when puzzles are returned', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			puzzles: [makePuzzle('p1'), makePuzzle('p2')],
			total: 2,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);

		const grid = page.getByTestId('puzzle-grid');
		await expect.element(grid).toBeVisible();
		const cards = page.getByTestId('puzzle-card');
		await expect.element(cards.nth(0)).toBeVisible();
		await expect.element(cards.nth(1)).toBeVisible();
	});

	it('reads Quick puzzles once and reuses them when server results change', async () => {
		const serverPuzzles = [
			makePuzzle('p1', { pieceCount: 4, aspectRatio: '1:1', status: 'ready' })
		];
		const filteredPuzzles = [
			makePuzzle('p2', { pieceCount: 4, aspectRatio: '1:1', status: 'ready' })
		];
		const quickPuzzles = [storedQuickPuzzleFixture];

		mockedFetchPuzzles
			.mockResolvedValueOnce({ puzzles: serverPuzzles, total: 1, offset: 0, limit: 20 })
			.mockResolvedValueOnce({ puzzles: filteredPuzzles, total: 1, offset: 0, limit: 20 });
		mockedListQuick.mockReturnValue(quickPuzzles);

		render(GalleryPage);

		await vi.waitFor(() => {
			expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
				serverPuzzles,
				quickPuzzles
			});
		});
		expect(mockedListQuick).toHaveBeenCalledTimes(1);

		await page.getByTestId('search-input').fill('filtered');
		await vi.waitFor(() => {
			expect(mockedFetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'filtered', offset: 0 })
			);
		});
		await expect.element(page.getByText('Puzzle p2')).toBeVisible();

		await vi.waitFor(() => {
			expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
				serverPuzzles: filteredPuzzles,
				quickPuzzles
			});
		});
		expect(mockedListQuick).toHaveBeenCalledTimes(1);
	});

	it('shows panel and card progress when the newest server progress overlaps a card', async () => {
		const serverPuzzles = [
			makePuzzle('p1', {
				name: 'Server Mission',
				pieceCount: 4,
				aspectRatio: '1:1',
				status: 'ready'
			})
		];
		const progress = {
			puzzleId: 'p1',
			name: 'Resume Me',
			source: 'api' as const,
			placedCount: 2,
			pieceCount: 4,
			lastUpdated: 2_000
		};

		mockedFetchPuzzles.mockResolvedValue({
			puzzles: serverPuzzles,
			total: 1,
			offset: 0,
			limit: 20
		});
		mockedDiscoverGalleryProgress.mockReturnValue({
			byPuzzleId: new Map([['p1', progress]]),
			newest: progress
		});

		render(GalleryPage);

		await expect.element(page.getByTestId('continue-on-device')).toBeVisible();
		await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('Resume Me');
		await expect.element(page.getByText('CONTINUE · 2/4 PLACED')).toBeVisible();
	});

	it('skips DOM update for unchanged panel progress text on refetch', async () => {
		const progress = {
			puzzleId: 'p1',
			name: 'Resume Me',
			source: 'api' as const,
			placedCount: 2,
			pieceCount: 4,
			lastUpdated: 2_000
		};

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, offset = 0 } = params ?? {};
			if (!q && offset === 0) {
				return {
					puzzles: [makePuzzle('p1', { name: 'Initial', pieceCount: 4, aspectRatio: '1:1' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}
			if (q === 'search' && offset === 0) {
				return {
					puzzles: [makePuzzle('p2', { name: 'Searched', pieceCount: 4, aspectRatio: '1:1' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}
			return { puzzles: [], total: 0, offset: 0, limit: 20 };
		});
		mockedDiscoverGalleryProgress.mockReturnValue({
			byPuzzleId: new Map([['p1', progress]]),
			newest: progress
		});

		render(GalleryPage);

		const panel = page.getByTestId('continue-on-device');
		await expect.element(panel).toBeVisible();
		await expect.element(panel.getByText('2/4 PLACED')).toBeVisible();

		// Trigger a search so puzzles changes, which re-runs the $effect.
		// The mock returns the same progress, so the interpolation value
		// stays "2/4" — exercising Svelte's "no-change" text guard.
		await page.getByTestId('search-input').fill('search');
		await vi.waitFor(() => {
			expect(page.getByText('Searched')).toBeInTheDocument();
		});

		await expect.element(panel.getByText('2/4 PLACED')).toBeVisible();
	});

	it('renders empty fallback for null progress counts in panel', async () => {
		// Svelte 5 compiles {localProgress.newest.placedCount} with a ?? '' guard.
		// Exercise the null branch by returning null counts from the mock.
		const progress = {
			puzzleId: 'p1',
			name: 'Resume Me',
			source: 'api' as const,
			placedCount: null as unknown as number,
			pieceCount: null as unknown as number,
			lastUpdated: 2_000
		};

		mockedFetchPuzzles.mockResolvedValue({
			puzzles: [makePuzzle('p1', { name: 'P1', pieceCount: 4, aspectRatio: '1:1' })],
			total: 1,
			offset: 0,
			limit: 20
		});
		mockedDiscoverGalleryProgress.mockReturnValue({
			byPuzzleId: new Map([['p1', progress]]),
			newest: progress
		});

		render(GalleryPage);

		const panel = page.getByTestId('continue-on-device');
		await expect.element(panel).toBeVisible();
		// null ?? '' renders empty for both counts → "/ PLACED"
		await expect.element(panel.getByText('/ PLACED')).toBeVisible();
	});

	it('links to a Quick-only newest progress without adding a Quick card', async () => {
		const quickPuzzles = [storedQuickPuzzleFixture];
		const progress = {
			puzzleId: 'q-local',
			name: 'Local Mission',
			source: 'local' as const,
			placedCount: 1,
			pieceCount: 4,
			lastUpdated: 2_000
		};

		mockedFetchPuzzles.mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
		mockedListQuick.mockReturnValue(quickPuzzles);
		mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: progress });

		render(GalleryPage);

		const panel = page.getByTestId('continue-on-device');
		await expect.element(panel).toBeVisible();
		await expect
			.element(panel.getByRole('link', { name: 'CONTINUE' }))
			.toHaveAttribute('href', '/puzzle/q-local');
		expect(document.querySelectorAll('[data-testid="puzzle-card"]')).toHaveLength(0);
	});

	it('shows empty state when total is 0 and no query is active', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('empty-state')).toBeVisible();
	});

	it('uses a document navigation for the admin portal link', async () => {
		render(GalleryPage);

		const adminLink = page.getByRole('link', { name: /admin portal/i });
		await expect.element(adminLink).toHaveAttribute('href', '/admin');
		await expect.element(adminLink).toHaveAttribute('data-sveltekit-reload');
	});

	it('shows no-results state when total is 0 and query is active', async () => {
		mockedFetchPuzzles.mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
		render(GalleryPage);

		const input = page.getByTestId('search-input');
		await input.fill('nonexistent');

		// After debounce fires (300ms) + fetch resolves
		await expect.element(page.getByTestId('no-results-state')).toBeVisible();
	});

	it('calls fetchPuzzles with q after debounce', async () => {
		render(GalleryPage);

		const input = page.getByTestId('search-input');
		await input.fill('forest');

		// Wait for debounce (300ms) and fetch
		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(expect.objectContaining({ q: 'forest' }));
		});
	});

	it('keeps the search input visible while a refetch is in flight after initial load', async () => {
		let resolveRefetch: ((value: FetchPuzzlesResult) => void) | undefined;

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, offset = 0 } = params ?? {};

			if (!q && offset === 0) {
				return {
					puzzles: [makePuzzle('p1', { name: 'Initial Result' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'forest' && offset === 0) {
				return new Promise<FetchPuzzlesResult>((resolve) => {
					resolveRefetch = resolve;
				});
			}

			return { puzzles: [], total: 0, offset, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Initial Result')).toBeVisible();

		const input = page.getByTestId('search-input');
		await expect.element(input).toBeVisible();
		await input.fill('forest');

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'forest', category: undefined, offset: 0 })
			);
		});
		await expect.element(page.getByTestId('loading-state')).toBeVisible();
		await expect.element(page.getByTestId('search-input')).toBeVisible();

		resolveRefetch?.({
			puzzles: [makePuzzle('p2', { name: 'Filtered Result' })],
			total: 1,
			offset: 0,
			limit: 20
		});
	});

	it('attaches the observer after the sentinel renders', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			puzzles: [makePuzzle('p1')],
			total: 1,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);

		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
		expect(observe).toHaveBeenCalledWith(expect.any(HTMLElement));
	});

	it('shows error state on initial fetch failure', async () => {
		mockedFetchPuzzles.mockRejectedValue(new ApiError(500, 'internal_error', 'Server error'));

		render(GalleryPage);

		await expect.element(page.getByTestId('error-state')).toBeVisible();
	});

	it('renders the search input', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('search-input')).toBeVisible();
	});

	it('clears the search immediately when filters are reset', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, category, offset = 0 } = params ?? {};

			if (!q && !category && offset === 0) {
				return {
					puzzles: [makePuzzle('nature-1', { name: 'Forest Scene', category: 'Nature' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'forest' && !category && offset === 0) {
				return {
					puzzles: [makePuzzle('nature-1', { name: 'Forest Scene', category: 'Nature' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'forest' && category === 'Nature' && offset === 0) {
				return {
					puzzles: [],
					total: 0,
					offset: 0,
					limit: 20
				};
			}

			return { puzzles: [], total: 0, offset, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();

		const callsBeforeSearch = mockedFetchPuzzles.mock.calls.length;
		await page.getByTestId('search-input').fill('forest');

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsBeforeSearch);
		});
		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'forest', category: undefined, offset: 0 })
			);
		});

		const callsBeforeCategoryChange = mockedFetchPuzzles.mock.calls.length;
		await page.getByRole('radio', { name: 'Nature' }).click();

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsBeforeCategoryChange);
		});
		await expect.element(page.getByTestId('no-results-state')).toBeVisible();

		const callsBeforeClear = mockedFetchPuzzles.mock.calls.length;
		await page.getByTestId('clear-filters-btn').click();

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsBeforeClear);
		});

		expect(mockedFetchPuzzles.mock.calls[callsBeforeClear]?.[0]).toMatchObject({
			q: undefined,
			category: undefined,
			offset: 0
		});
	});

	it('does not append stale next-page results after the query changes', async () => {
		let resolveStalePage: ((value: FetchPuzzlesResult) => void) | undefined;
		const stalePagePromise = new Promise<FetchPuzzlesResult>((resolve) => {
			resolveStalePage = resolve;
		});

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, cursor } = params ?? {};
			if (!q && !cursor) {
				return {
					puzzles: [makePuzzle('old-1', { name: 'Old Initial Result' })],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}

			if (!q && cursor === 'cursor-page2') {
				return stalePagePromise;
			}

			if (q === 'fresh' && !cursor) {
				return {
					puzzles: [makePuzzle('fresh-1', { name: 'Fresh Query Result' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			return { puzzles: [], total: 0, offset: 0, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Old Initial Result')).toBeVisible();
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: undefined, category: undefined, cursor: 'cursor-page2' })
			);
		});

		await page.getByTestId('search-input').fill('fresh');

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'fresh', category: undefined })
			);
		});
		await expect.element(page.getByText('Fresh Query Result')).toBeVisible();

		resolveStalePage?.({
			puzzles: [makePuzzle('old-2', { name: 'Stale Page Result' })],
			total: 2,
			offset: 1,
			limit: 20
		});
		await stalePagePromise;
		await Promise.resolve();

		expect(document.querySelectorAll('[data-testid="puzzle-card"]')).toHaveLength(1);
		expect(document.body.textContent).not.toContain('Stale Page Result');
	});

	it('aborts an in-flight next-page request when the query changes', async () => {
		let nextPageSignal: AbortSignal | undefined;

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, cursor } = params ?? {};
			if (!q && !cursor) {
				return {
					puzzles: [makePuzzle('old-1', { name: 'Old Initial Result' })],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}

			if (!q && cursor === 'cursor-page2') {
				nextPageSignal = params?.signal;
				return new Promise<FetchPuzzlesResult>((_, reject) => {
					params?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true }
					);
				});
			}

			if (q === 'fresh' && !cursor) {
				return {
					puzzles: [makePuzzle('fresh-1', { name: 'Fresh Query Result' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			return { puzzles: [], total: 0, offset: 0, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Old Initial Result')).toBeVisible();
		expect(intersectionCallback).not.toBeNull();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: undefined, category: undefined, cursor: 'cursor-page2' })
			);
		});
		expect(nextPageSignal).toBeInstanceOf(AbortSignal);
		expect(nextPageSignal?.aborted).toBe(false);

		await page.getByTestId('search-input').fill('fresh');

		await vi.waitFor(() => {
			expect(nextPageSignal?.aborted).toBe(true);
		});
		await expect.element(page.getByText('Fresh Query Result')).toBeVisible();
	});

	it('clears total during refetch so stale availability badge is hidden', async () => {
		let searchResolve: ((value: FetchPuzzlesResult) => void) | undefined;
		const searchPromise = new Promise<FetchPuzzlesResult>((resolve) => {
			searchResolve = resolve;
		});

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { q, offset = 0 } = params ?? {};

			if (!q && offset === 0) {
				return {
					puzzles: [makePuzzle('p1', { name: 'Initial' })],
					total: 100,
					offset: 0,
					limit: 20
				};
			}

			if (q === 'search' && offset === 0) {
				return searchPromise;
			}

			return { puzzles: [], total: 0, offset, limit: 20 };
		});

		render(GalleryPage);

		await expect.element(page.getByText('Initial')).toBeVisible();
		const badgeInitial = page.getByTestId('availability-badge');
		await expect.element(badgeInitial).toBeVisible();

		const input = page.getByTestId('search-input');
		await input.fill('search');

		await vi.waitFor(() => {
			expect(mockedFetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'search', offset: 0 })
			);
		});

		// Badge should be hidden while refetch is pending (total is reset to 0)
		await vi.waitFor(() => {
			expect(document.querySelector('[data-testid="availability-badge"]')).toBeNull();
		});

		searchResolve?.({
			puzzles: [makePuzzle('p2', { name: 'Searched' })],
			total: 1,
			offset: 0,
			limit: 20
		});

		await expect.element(page.getByText('Searched')).toBeVisible();
		const badgeAfter = page.getByTestId('availability-badge');
		await expect.element(badgeAfter).toBeVisible();
	});

	it('shows load-more error element when next-page fetch fails', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					puzzles: [makePuzzle('p1')],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			throw new ApiError(500, 'internal_error', 'Server error');
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await expect.element(page.getByTestId('load-more-error')).toBeVisible();
	});

	it('clears load-more error and appends puzzles when retry button is clicked', async () => {
		let loadMoreCallCount = 0;
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					puzzles: [makePuzzle('p1')],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			loadMoreCallCount++;
			if (loadMoreCallCount === 1) throw new ApiError(500, 'internal_error', 'Server error');
			return { puzzles: [makePuzzle('p2')], total: 2, offset: 0, limit: 20 };
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await expect.element(page.getByTestId('load-more-error')).toBeVisible();

		await page.getByTestId('load-more-error').getByRole('button').click();

		await vi.waitFor(() => {
			expect(document.querySelector('[data-testid="load-more-error"]')).toBeNull();
		});
		const cards = page.getByTestId('puzzle-card');
		await expect.element(cards.nth(1)).toBeVisible();
	});

	it('does not auto-retry load-more on intersection when in error state', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					puzzles: [makePuzzle('p1')],
					total: 2,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			throw new ApiError(500, 'internal_error', 'Server error');
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await expect.element(page.getByTestId('load-more-error')).toBeVisible();

		const callsBeforeReIntersect = mockedFetchPuzzles.mock.calls.length;

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await Promise.resolve();
		expect(mockedFetchPuzzles.mock.calls.length).toBe(callsBeforeReIntersect);
	});

	it('does not trigger loadNextPage from observer when already loading more', async () => {
		let resolveLoadMore: ((value: FetchPuzzlesResult) => void) | undefined;
		const loadMorePromise = new Promise<FetchPuzzlesResult>((resolve) => {
			resolveLoadMore = resolve;
		});

		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					puzzles: [makePuzzle('p1')],
					total: 5,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			return loadMorePromise;
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		// First intersection triggers loadNextPage
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ cursor: 'cursor-page2' })
			);
		});

		const callsWhileLoading = mockedFetchPuzzles.mock.calls.length;

		// Second intersection while loadingMore is true should NOT call loadNextPage
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await Promise.resolve();

		expect(mockedFetchPuzzles.mock.calls.length).toBe(callsWhileLoading);

		// Clean up the pending promise
		resolveLoadMore?.({ puzzles: [makePuzzle('p2')], total: 5, offset: 0, limit: 20 });
		await loadMorePromise;
	});

	it('does not trigger loadNextPage from observer when all items are loaded', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			puzzles: [makePuzzle('p1')],
			total: 1,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		// Sentinel is visible but hasMore is false (nextCursor is undefined)
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		// Only the initial fetch should have been called, no next-page call
		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledTimes(1);
		});
		expect(fetchPuzzles).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
	});

	it('does not fetch duplicates when total grows beyond loaded count but nextCursor is absent', async () => {
		mockedFetchPuzzles.mockImplementation(async (params) => {
			const { cursor } = params ?? {};
			if (!cursor) {
				return {
					puzzles: [makePuzzle('p1')],
					total: 3,
					offset: 0,
					limit: 20,
					nextCursor: 'cursor-page2'
				};
			}
			if (cursor === 'cursor-page2') {
				// Simulates a new puzzle inserted: total=4 but this was the last page (no nextCursor)
				return {
					puzzles: [makePuzzle('p2')],
					total: 4,
					offset: 1,
					limit: 20
				};
			}
			return { puzzles: [], total: 0, offset: 0, limit: 20 };
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('scroll-sentinel')).toBeInTheDocument();
		expect(intersectionCallback).not.toBeNull();

		// Trigger load-next-page
		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ cursor: 'cursor-page2' })
			);
		});

		// Wait for the result to be processed
		await vi.waitFor(() => {
			expect(document.querySelectorAll('[data-testid="puzzle-card"]')).toHaveLength(2);
		});

		// Now hasMore should be false (nextCursor is undefined) even though puzzles.length(2) < total(4)
		const callsBeforeReIntersect = mockedFetchPuzzles.mock.calls.length;

		intersectionCallback?.(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await Promise.resolve();

		// No additional fetch should have been triggered
		expect(mockedFetchPuzzles.mock.calls.length).toBe(callsBeforeReIntersect);
	});

	it('treats whitespace-only search as no filter after a real search term', async () => {
		mockedFetchPuzzles.mockResolvedValue({
			puzzles: [makePuzzle('p1')],
			total: 1,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);
		await expect.element(page.getByTestId('search-input')).toBeVisible();

		const input = page.getByTestId('search-input');
		await input.fill('forest');

		// Wait for the debounced real-search call
		await vi.waitFor(() => {
			expect(mockedFetchPuzzles).toHaveBeenCalledWith(expect.objectContaining({ q: 'forest' }));
		});

		const callsAfterRealSearch = mockedFetchPuzzles.mock.calls.length;
		await input.fill('   ');

		// Wait for the debounced whitespace call (debouncedQuery changes from 'forest' to '')
		await vi.waitFor(() => {
			expect(mockedFetchPuzzles.mock.calls.length).toBeGreaterThan(callsAfterRealSearch);
		});

		// Whitespace was trimmed: call must use q: undefined, never q: '   '
		const newCalls = mockedFetchPuzzles.mock.calls.slice(callsAfterRealSearch);
		const hasWhitespaceQuery = newCalls.some(([params]) => params?.q === '   ');
		expect(hasWhitespaceQuery).toBe(false);
	});
});
