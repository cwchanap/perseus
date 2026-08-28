import { page } from 'vitest/browser';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';
import { fetchPuzzles } from '$lib/services/api';
import type { PuzzleFamilyListResponse, PuzzleFamilySummary } from '$lib/types/puzzle';

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
		fetchPuzzles: vi.fn().mockResolvedValue({ families: [], total: 0, offset: 0, limit: 20 }),
		fetchPuzzle: vi.fn(),
		ApiError: MockApiError,
		getFamilyThumbnailUrl: vi.fn((id: string) => `/api/puzzle-families/${id}/thumbnail`),
		getPieceImageUrl: vi.fn()
	};
});

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn().mockReturnValue(null)
}));

function makeFamily(id: string, name: string, category?: string): PuzzleFamilySummary {
	return {
		id,
		name,
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1,
		...(category ? { category: category as PuzzleFamilySummary['category'] } : {}),
		variants: {
			easy: { id: `${id}-e`, difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: `${id}-n`, difficulty: 'normal', pieceCount: 49, status: 'ready' },
			hard: { id: `${id}-h`, difficulty: 'hard', pieceCount: 100, status: 'ready' }
		}
	};
}

const mockFamilies: PuzzleFamilySummary[] = [
	makeFamily('p1', 'Forest Scene', 'Nature'),
	makeFamily('p2', 'City Skyline', 'Architecture')
];

describe('/+page.svelte', () => {
	beforeEach(() => {
		vi.mocked(fetchPuzzles).mockResolvedValue({
			families: [],
			total: 0,
			offset: 0,
			limit: 20
		});
	});

	it('should render h1', async () => {
		render(Page);

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
	});

	it('should show loading state while fetching', async () => {
		let resolvePromise!: (value: PuzzleFamilyListResponse) => void;
		vi.mocked(fetchPuzzles).mockReturnValue(
			new Promise<PuzzleFamilyListResponse>((res) => {
				resolvePromise = res;
			})
		);

		render(Page);

		await expect.element(page.getByTestId('loading-state')).toBeVisible();

		resolvePromise({ families: [], total: 0, offset: 0, limit: 20 });
		await expect.element(page.getByTestId('loading-state')).not.toBeInTheDocument();
	});

	it('should show empty state when no puzzles exist', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue({ families: [], total: 0, offset: 0, limit: 20 });
		render(Page);

		await expect.element(page.getByTestId('empty-state')).toBeVisible();
	});

	it('should show puzzle grid when puzzles are loaded', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue({
			families: mockFamilies,
			total: mockFamilies.length,
			offset: 0,
			limit: 20
		});
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
		vi.mocked(fetchPuzzles).mockResolvedValue({
			families: mockFamilies,
			total: mockFamilies.length,
			offset: 0,
			limit: 20
		});
		render(Page);

		await expect.element(page.getByTestId('category-filter')).toBeVisible();
	});

	it('should show no puzzles in category message when filter has no matches', async () => {
		vi.mocked(fetchPuzzles)
			.mockResolvedValueOnce({
				families: mockFamilies,
				total: mockFamilies.length,
				offset: 0,
				limit: 20
			})
			.mockResolvedValueOnce({
				families: [],
				total: 0,
				offset: 0,
				limit: 20
			});
		render(Page);

		await expect.element(page.getByTestId('category-filter')).toBeVisible();
		const abstractButton = page.getByRole('radio', { name: 'Abstract' });
		await abstractButton.click();

		await expect.element(page.getByTestId('no-results-state')).toBeVisible();
	});
});
