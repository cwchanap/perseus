import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdminPage from './+page.svelte';
import type { PuzzleSummary } from '$lib/types/puzzle';
import { fetchAdminPuzzles, logout, ApiError } from '$lib/services/api';
import { goto } from '$app/navigation';

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
		logout: vi.fn(),
		createPuzzle: vi.fn(),
		deletePuzzle: vi.fn(),
		fetchAdminPuzzles: vi.fn().mockResolvedValue([]),
		getThumbnailUrl: vi.fn((id: string) => `/api/puzzles/${id}/thumbnail`),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/progress', () => ({
	clearProgress: vi.fn()
}));

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
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

describe('Admin Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the admin control panel heading', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		await expect.element(page.getByRole('heading', { name: /CONTROL PANEL/i })).toBeVisible();
	});

	it('shows CREATE MISSION form panel', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		// The panel header uses a <span> with this exact text
		await expect.element(page.getByText('CREATE MISSION', { exact: true }).first()).toBeVisible();
	});

	it('shows empty state when no puzzles exist', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		await expect.element(page.getByText(/No missions found/i)).toBeVisible();
	});

	// Tests rendering mockPuzzles (which includes a 'processing' puzzle that triggers
	// setInterval polling) use fake timers so the interval never fires during the test.
	describe('puzzle list rendering', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('renders list of puzzles after loading', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
			render(AdminPage);

			await expect.element(page.getByText('Forest Scene')).toBeVisible();
			await expect.element(page.getByText('City Lights')).toBeVisible();
			await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
		});

		it.each(['PROCESSING', 'FAILED', 'READY'])(
			'shows %s badge for the matching puzzle status',
			async (badge) => {
				vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
				render(AdminPage);

				await expect.element(page.getByText(badge)).toBeVisible();
			}
		);

		it('shows puzzle count in mission database panel', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
			render(AdminPage);

			// "3 TOTAL" should appear once puzzles are loaded
			await expect.element(page.getByText('3 TOTAL')).toBeVisible();
		});
	});

	it('shows error state when fetching puzzles fails', async () => {
		vi.mocked(fetchAdminPuzzles).mockRejectedValue(new Error('Network error'));
		render(AdminPage);

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByText(/Failed to load puzzles/i)).toBeVisible();
	});

	it('shows ApiError message when puzzle fetch fails with ApiError', async () => {
		vi.mocked(fetchAdminPuzzles).mockRejectedValue(
			new ApiError(503, 'service_unavailable', 'Service temporarily unavailable')
		);
		render(AdminPage);

		await expect.element(page.getByText('Service temporarily unavailable')).toBeVisible();
	});

	it('disables the submit button when name and image are empty', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);

		const submitBtn = page.getByRole('button', { name: /CREATE MISSION/i });
		await expect.element(submitBtn).toBeDisabled();
	});

	it('navigates to /admin/login after successful logout', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(logout).mockResolvedValue(undefined);
		render(AdminPage);

		await page.getByRole('button', { name: /LOGOUT/i }).click();

		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/admin/login');
		});
	});

	it('shows logout error when logout fails', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(logout).mockRejectedValue(new Error('Logout failed'));
		render(AdminPage);

		await page.getByRole('button', { name: /LOGOUT/i }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByText('Failed to logout')).toBeVisible();
	});
});
