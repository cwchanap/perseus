import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdminPuzzlesPanel from './AdminPuzzlesPanel.svelte';
import type { PuzzleSummary } from '$lib/types/puzzle';
import { ApiError, deletePuzzle, fetchAdminPuzzles } from '$lib/services/api';

vi.mock('$lib/services/api', () => {
	class MockApiError extends Error {
		constructor(
			public status: number,
			public error: string,
			message: string
		) {
			super(message);
			this.name = 'ApiError';
		}
	}
	return {
		deletePuzzle: vi.fn(),
		fetchAdminPuzzles: vi.fn().mockResolvedValue([]),
		getReferenceImageUrl: vi.fn((puzzleId: string) => `/api/puzzles/${puzzleId}/reference`),
		getThumbnailUrl: vi.fn(() => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({
		clearSession: vi.fn()
	})
}));

const mockPuzzles: PuzzleSummary[] = [
	{
		id: 'p1',
		name: 'Forest Scene',
		pieceCount: 225,
		status: 'ready',
		category: 'Nature'
	},
	{
		id: 'p2',
		name: 'City Lights',
		pieceCount: 225,
		status: 'processing',
		category: 'Architecture',
		progress: { generatedPieces: 10, totalPieces: 225, updatedAt: 0 }
	},
	{
		id: 'p3',
		name: 'Broken Puzzle',
		pieceCount: 225,
		status: 'failed',
		category: 'Nature'
	}
];

async function selectFilter(label: string, value: string) {
	const select = (await page.getByLabelText(label).element()) as HTMLSelectElement;
	select.value = value;
	select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AdminPuzzlesPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('shows admin puzzles including processing and failed states', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
		await expect.element(page.getByText('PROCESSING').nth(1)).toBeVisible();
		await expect.element(page.getByText('FAILED').nth(1)).toBeVisible();
	});

	it('opens and closes the reference preview for a ready puzzle', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await page.getByRole('button', { name: 'View full image for Forest Scene' }).click();

		await expect.element(page.getByRole('dialog', { name: 'Reference image' })).toBeVisible();
		await expect
			.element(page.getByRole('img', { name: 'Puzzle reference' }))
			.toHaveAttribute('src', '/api/puzzles/p1/reference');

		await page.getByRole('button', { name: 'Close reference' }).click();
		await expect
			.poll(() => page.getByRole('dialog', { name: 'Reference image' }).query())
			.toBeNull();
	});

	it('dismisses the reference preview with Escape', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await page.getByRole('button', { name: 'View full image for Forest Scene' }).click();
		await expect.element(page.getByRole('dialog', { name: 'Reference image' })).toBeVisible();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

		await expect
			.poll(() => page.getByRole('dialog', { name: 'Reference image' }).query())
			.toBeNull();
	});

	it('shows the unavailable state when the reference image fails', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await page.getByRole('button', { name: 'View full image for Forest Scene' }).click();
		const image = await page.getByRole('img', { name: 'Puzzle reference' }).element();
		image.dispatchEvent(new Event('error', { bubbles: true }));

		await expect.element(page.getByText('Reference image unavailable')).toBeVisible();
	});

	it('does not offer reference previews for processing or failed puzzles', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect
			.poll(() => page.getByRole('button', { name: 'View full image for City Lights' }).query())
			.toBeNull();
		await expect
			.poll(() => page.getByRole('button', { name: 'View full image for Broken Puzzle' }).query())
			.toBeNull();
	});

	it('filters puzzles through the SearchBar value callback', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByLabelText('Search puzzles').fill('City');

		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.poll(() => page.getByText('Forest Scene').query()).toBeNull();
		await expect.poll(() => page.getByText('Broken Puzzle').query()).toBeNull();
	});

	it('filters puzzles by category', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await selectFilter('Filter by category', 'Nature');

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
		await expect.poll(() => page.getByText('City Lights').query()).toBeNull();
	});

	it('filters puzzles by status', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await selectFilter('Filter by status', 'processing');

		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.poll(() => page.getByText('Forest Scene').query()).toBeNull();
		await expect.poll(() => page.getByText('Broken Puzzle').query()).toBeNull();
	});

	it('combines the search, category, and status controls', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByLabelText('Search puzzles').fill('Puzzle');
		await selectFilter('Filter by category', 'Nature');
		await selectFilter('Filter by status', 'failed');

		await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
		await expect.poll(() => page.getByText('Forest Scene').query()).toBeNull();
		await expect.poll(() => page.getByText('City Lights').query()).toBeNull();
	});

	it('resets all active criteria', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await expect.poll(() => page.getByRole('button', { name: 'RESET' }).query()).toBeNull();
		await page.getByLabelText('Search puzzles').fill('Puzzle');
		await selectFilter('Filter by category', 'Nature');
		await selectFilter('Filter by status', 'failed');
		await page.getByRole('button', { name: 'RESET' }).click();

		await expect.element(page.getByLabelText('Search puzzles')).toHaveValue('');
		await expect.element(page.getByLabelText('Filter by category')).toHaveValue('all');
		await expect.element(page.getByLabelText('Filter by status')).toHaveValue('all');
		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
		await expect.poll(() => page.getByRole('button', { name: 'RESET' }).query()).toBeNull();
	});

	it('shows filtered-empty copy when criteria match no puzzles', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByLabelText('Search puzzles').fill('Ocean');

		await expect
			.element(page.getByText('No missions match the current search and filters.'))
			.toBeVisible();
	});

	it('shows the filtered and total count while criteria are active', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('3 TOTAL')).toBeVisible();
		await page.getByLabelText('Search puzzles').fill('Forest');

		await expect.element(page.getByText('1 OF 3')).toBeVisible();
	});

	it('shows an API error when loading admin puzzles fails', async () => {
		vi.mocked(fetchAdminPuzzles).mockRejectedValue(
			new ApiError(503, 'service_unavailable', 'Puzzle database unavailable')
		);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Puzzle database unavailable')).toBeVisible();
		await expect.element(page.getByText('0 TOTAL')).toBeVisible();
	});

	it('deletes a ready puzzle after confirmation', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValueOnce(mockPuzzles).mockResolvedValueOnce([]);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		vi.mocked(deletePuzzle).mockResolvedValue(null);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByRole('button', { name: 'DELETE' }).first().click();

		await vi.waitFor(() => {
			expect(deletePuzzle).toHaveBeenCalledWith('p1', { force: false });
		});
	});

	it('sends force flag for processing puzzle deletion', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValueOnce(mockPuzzles).mockResolvedValueOnce([]);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		vi.mocked(deletePuzzle).mockResolvedValue(null);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('City Lights')).toBeVisible();
		await page.getByRole('button', { name: 'FORCE DEL' }).click();

		await vi.waitFor(() => {
			expect(deletePuzzle).toHaveBeenCalledWith('p2', { force: true });
		});
	});

	it('shows ApiError message in alert on delete failure', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		vi.mocked(deletePuzzle).mockRejectedValue(
			new ApiError(500, 'internal_error', 'Server error occurred')
		);
		const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByRole('button', { name: 'DELETE' }).first().click();

		await vi.waitFor(() => {
			expect(alertSpy).toHaveBeenCalledWith('Server error occurred');
		});
	});

	it('shows partial delete warnings as a status message', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValueOnce(mockPuzzles).mockResolvedValueOnce([]);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		vi.mocked(deletePuzzle).mockResolvedValue({
			success: false,
			partialSuccess: true,
			warning: 'Metadata removed, but one asset could not be deleted',
			failedAssets: ['pieces/1.png']
		});

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByRole('button', { name: 'DELETE' }).first().click();

		await expect
			.element(page.getByText('Metadata removed, but one asset could not be deleted'))
			.toBeVisible();
	});

	it('replaces an existing success message when a new one arrives', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.mocked(fetchAdminPuzzles)
			.mockResolvedValueOnce(mockPuzzles)
			.mockResolvedValueOnce(mockPuzzles)
			.mockResolvedValueOnce([]);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		vi.mocked(deletePuzzle)
			.mockResolvedValueOnce({
				success: false,
				partialSuccess: true,
				warning: 'First warning',
				failedAssets: ['pieces/1.png']
			})
			.mockResolvedValueOnce({
				success: false,
				partialSuccess: true,
				warning: 'Second warning',
				failedAssets: ['pieces/2.png']
			});

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByRole('button', { name: 'DELETE' }).first().click();
		await expect.element(page.getByText('First warning')).toBeVisible();

		await page.getByRole('button', { name: 'DELETE' }).nth(1).click();
		await expect.element(page.getByText('Second warning')).toBeVisible();

		await vi.advanceTimersByTimeAsync(5000);
		await expect.poll(() => page.getByText('Second warning').query()).toBeNull();
	});

	it('polls for a hidden processing puzzle after three seconds', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const readyPuzzles: PuzzleSummary[] = [
			{
				id: 'p2',
				name: 'City Lights',
				pieceCount: 225,
				status: 'ready',
				category: 'Architecture'
			}
		];
		vi.mocked(fetchAdminPuzzles)
			.mockResolvedValueOnce(mockPuzzles)
			.mockResolvedValueOnce(readyPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('City Lights')).toBeVisible();
		await selectFilter('Filter by category', 'Nature');
		await expect.poll(() => page.getByText('City Lights').query()).toBeNull();

		await vi.advanceTimersByTimeAsync(3000);

		await vi.waitFor(() => {
			expect(fetchAdminPuzzles).toHaveBeenCalledTimes(2);
		});
	});

	it('does not start polling when unmounted during the initial request', async () => {
		let resolveInitialRequest!: (puzzles: PuzzleSummary[]) => void;
		vi.mocked(fetchAdminPuzzles).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveInitialRequest = resolve;
			})
		);

		const { unmount } = render(AdminPuzzlesPanel);
		await vi.waitFor(() => {
			expect(fetchAdminPuzzles).toHaveBeenCalledTimes(1);
		});

		unmount();
		const setIntervalSpy = vi.spyOn(window, 'setInterval');
		try {
			resolveInitialRequest(mockPuzzles);
			await new Promise((resolve) => window.setTimeout(resolve, 0));

			expect(setIntervalSpy).not.toHaveBeenCalled();
		} finally {
			setIntervalSpy.mockRestore();
		}
	});

	it('paginates 21 rows using a fixed page size of 20', async () => {
		const manyPuzzles: PuzzleSummary[] = Array.from({ length: 21 }, (_, index) => ({
			id: `p${index + 1}`,
			name: `Mission ${String(index + 1).padStart(2, '0')}`,
			pieceCount: 100,
			status: 'ready'
		}));
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(manyPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Mission 01')).toBeVisible();
		await expect.element(page.getByText('Mission 20')).toBeVisible();
		await expect.poll(() => page.getByText('Mission 21').query()).toBeNull();
		await expect.element(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: 'Next page' })).toBeEnabled();

		await page.getByRole('button', { name: 'Next page' }).click();

		await expect.element(page.getByText('Mission 21')).toBeVisible();
		await expect.poll(() => page.getByText('Mission 01').query()).toBeNull();
		await expect.element(page.getByRole('button', { name: 'Previous page' })).toBeEnabled();
		await expect.element(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
	});
});
