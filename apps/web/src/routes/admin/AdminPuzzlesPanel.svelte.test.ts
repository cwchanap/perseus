import { beforeEach, describe, expect, it, vi } from 'vitest';
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
	{ id: 'p1', name: 'Forest Scene', pieceCount: 225, status: 'ready' },
	{
		id: 'p2',
		name: 'City Lights',
		pieceCount: 225,
		status: 'processing',
		progress: { generatedPieces: 10, totalPieces: 225, updatedAt: 0 }
	},
	{ id: 'p3', name: 'Broken Puzzle', pieceCount: 225, status: 'failed' }
];

describe('AdminPuzzlesPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
	});

	it('shows admin puzzles including processing and failed states', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
		await expect.element(page.getByText('PROCESSING')).toBeVisible();
		await expect.element(page.getByText('FAILED')).toBeVisible();
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
		vi.useRealTimers();
	});

	it('polls for puzzle status updates when puzzles are processing', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const readyPuzzles: PuzzleSummary[] = [
			{ id: 'p2', name: 'City Lights', pieceCount: 225, status: 'ready' }
		];
		vi.mocked(fetchAdminPuzzles)
			.mockResolvedValueOnce(mockPuzzles)
			.mockResolvedValueOnce(readyPuzzles);

		render(AdminPuzzlesPanel);

		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.element(page.getByText('PROCESSING')).toBeVisible();

		await vi.advanceTimersByTimeAsync(3000);

		await vi.waitFor(() => {
			expect(fetchAdminPuzzles).toHaveBeenCalledTimes(2);
		});
		vi.useRealTimers();
	});
});
