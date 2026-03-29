import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdminPage from './+page.svelte';
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
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		await expect.element(page.getByRole('heading', { name: /CONTROL PANEL/i })).toBeVisible();
	});

	it('shows CREATE MISSION form panel', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		// The panel header uses a <span> with this exact text
		await expect.element(page.getByText('CREATE MISSION', { exact: true }).first()).toBeVisible();
	});

	it('shows empty state when no puzzles exist', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		await expect.element(page.getByText(/No missions found/i)).toBeVisible();
	});

	it('renders list of puzzles after loading', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
		render(AdminPage);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
	});

	it('shows PROCESSING badge for puzzles with processing status', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
		render(AdminPage);

		await expect.element(page.getByText('PROCESSING')).toBeVisible();
	});

	it('shows FAILED badge for puzzles with failed status', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
		render(AdminPage);

		await expect.element(page.getByText('FAILED')).toBeVisible();
	});

	it('shows READY badge for puzzles with ready status', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
		render(AdminPage);

		await expect.element(page.getByText('READY')).toBeVisible();
	});

	it('shows error state when fetching puzzles fails', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockRejectedValue(new Error('Network error'));
		render(AdminPage);

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByText(/Failed to load puzzles/i)).toBeVisible();
	});

	it('shows ApiError message when puzzle fetch fails with ApiError', async () => {
		const { fetchAdminPuzzles, ApiError } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockRejectedValue(
			new ApiError(503, 'service_unavailable', 'Service temporarily unavailable')
		);
		render(AdminPage);

		await expect.element(page.getByText('Service temporarily unavailable')).toBeVisible();
	});

	it('disables the submit button when name and image are empty', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);

		const submitBtn = page.getByRole('button', { name: /CREATE MISSION/i });
		await expect.element(submitBtn).toBeDisabled();
	});

	it('navigates to /admin/login after successful logout', async () => {
		const { fetchAdminPuzzles, logout } = await import('$lib/services/api');
		const { goto } = await import('$app/navigation');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(logout).mockResolvedValue(undefined);
		render(AdminPage);

		await page.getByRole('button', { name: /LOGOUT/i }).click();

		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/admin/login');
		});
	});

	it('shows logout error when logout fails', async () => {
		const { fetchAdminPuzzles, logout } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(logout).mockRejectedValue(new Error('Logout failed'));
		render(AdminPage);

		await page.getByRole('button', { name: /LOGOUT/i }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByText('Failed to logout')).toBeVisible();
	});

	it('shows puzzle count in mission database panel', async () => {
		const { fetchAdminPuzzles } = await import('$lib/services/api');
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
		render(AdminPage);

		// "3 TOTAL" should appear once puzzles are loaded
		await expect.element(page.getByText('3 TOTAL')).toBeVisible();
	});
});
