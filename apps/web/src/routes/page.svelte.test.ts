import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import GalleryPage from './+page.svelte';
import type { PuzzleSummary } from '$lib/types/puzzle';
import { fetchPuzzles, ApiError } from '$lib/services/api';

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

type FetchPuzzlesResult = Awaited<ReturnType<typeof fetchPuzzles>>;

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
		vi.mocked(fetchPuzzles).mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shows puzzle cards when puzzles are returned', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue({
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

	it('shows empty state when total is 0 and no query is active', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('empty-state')).toBeVisible();
	});

	it('shows no-results state when total is 0 and query is active', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
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

	it('attaches the observer after the sentinel renders', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue({
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
		vi.mocked(fetchPuzzles).mockRejectedValue(new ApiError(500, 'internal_error', 'Server error'));

		render(GalleryPage);

		await expect.element(page.getByTestId('error-state')).toBeVisible();
	});

	it('renders the search input', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('search-input')).toBeVisible();
	});

	it('does not append stale next-page results after the query changes', async () => {
		let resolveStalePage: ((value: FetchPuzzlesResult) => void) | undefined;
		const stalePagePromise = new Promise<FetchPuzzlesResult>((resolve) => {
			resolveStalePage = resolve;
		});

		vi.mocked(fetchPuzzles).mockImplementation(async (params) => {
			const { q, offset = 0 } = params ?? {};
			if (!q && offset === 0) {
				return {
					puzzles: [makePuzzle('old-1', { name: 'Old Initial Result' })],
					total: 2,
					offset: 0,
					limit: 20
				};
			}

			if (!q && offset === 1) {
				return stalePagePromise;
			}

			if (q === 'fresh' && offset === 0) {
				return {
					puzzles: [makePuzzle('fresh-1', { name: 'Fresh Query Result' })],
					total: 1,
					offset: 0,
					limit: 20
				};
			}

			return { puzzles: [], total: 0, offset, limit: 20 };
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
				expect.objectContaining({ q: undefined, category: undefined, offset: 1 })
			);
		});

		await page.getByTestId('search-input').fill('fresh');

		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(
				expect.objectContaining({ q: 'fresh', category: undefined, offset: 0 })
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
});
