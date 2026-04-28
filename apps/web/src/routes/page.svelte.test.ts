import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('Gallery Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchPuzzles).mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
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

	it('shows error state on initial fetch failure', async () => {
		vi.mocked(fetchPuzzles).mockRejectedValue(new ApiError(500, 'internal_error', 'Server error'));

		render(GalleryPage);

		await expect.element(page.getByTestId('error-state')).toBeVisible();
	});

	it('renders the search input', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('search-input')).toBeVisible();
	});
});
