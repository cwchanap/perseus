import { page } from 'vitest/browser';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';
import { fetchPuzzles } from '$lib/services/api';
import type { PuzzleSummary } from '$lib/types/puzzle';

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
		fetchPuzzles: vi.fn().mockResolvedValue([]),
		ApiError: MockApiError,
		getThumbnailUrl: vi.fn((id: string) => `/api/puzzles/${id}/thumbnail`),
		getPieceImageUrl: vi.fn()
	};
});

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn().mockReturnValue(null)
}));

const mockPuzzles: PuzzleSummary[] = [
	{ id: 'p1', name: 'Forest Scene', pieceCount: 100, status: 'ready', category: 'Nature' },
	{ id: 'p2', name: 'City Skyline', pieceCount: 200, status: 'ready', category: 'Architecture' }
];

describe('/+page.svelte', () => {
	beforeEach(() => {
		vi.mocked(fetchPuzzles).mockResolvedValue([]);
	});

	it('should render h1', async () => {
		render(Page);

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
	});

	it('should show loading state while fetching', async () => {
		let resolvePromise!: (value: PuzzleSummary[]) => void;
		vi.mocked(fetchPuzzles).mockReturnValue(
			new Promise<PuzzleSummary[]>((res) => {
				resolvePromise = res;
			})
		);

		render(Page);

		await expect.element(page.getByTestId('loading-state')).toBeVisible();

		resolvePromise([]);
		await expect.element(page.getByTestId('loading-state')).not.toBeInTheDocument();
	});

	it('should show empty state when no puzzles exist', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue([]);
		render(Page);

		await expect.element(page.getByTestId('empty-state')).toBeVisible();
	});

	it('should show puzzle grid when puzzles are loaded', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue(mockPuzzles);
		render(Page);

		await expect.element(page.getByTestId('puzzle-grid')).toBeVisible();
		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await expect.element(page.getByText('City Skyline')).toBeVisible();
	});

	it('should show error state when fetchPuzzles fails with ApiError', async () => {
		const { ApiError } = await import('$lib/services/api');
		vi.mocked(fetchPuzzles).mockRejectedValue(new ApiError(500, 'internal_error', 'Server error'));
		render(Page);

		await expect.element(page.getByTestId('error-state')).toBeVisible();
		await expect.element(page.getByText('Server error')).toBeVisible();
	});

	it('should show generic error when fetchPuzzles throws non-ApiError', async () => {
		vi.mocked(fetchPuzzles).mockRejectedValue(new Error('Network failure'));
		render(Page);

		await expect.element(page.getByTestId('error-state')).toBeVisible();
		await expect.element(page.getByText('Failed to load puzzles. Please try again.')).toBeVisible();
	});

	it('should show category filter when puzzles are loaded', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue(mockPuzzles);
		render(Page);

		await expect.element(page.getByTestId('category-filter')).toBeVisible();
	});

	it('should show no puzzles in category message when filter has no matches', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue(mockPuzzles);
		render(Page);

		// Click on a category with no puzzles
		await expect.element(page.getByTestId('category-filter')).toBeVisible();
		const abstractButton = page.getByRole('radio', { name: 'Abstract' });
		await abstractButton.click();

		await expect.element(page.getByText('No puzzles in this category')).toBeVisible();
	});
});
