import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdminPage from './+page.svelte';
import type { PlayerAllowlistEntry, PuzzleSummary } from '$lib/types/puzzle';
import {
	ApiError,
	addPlayerAllowlistEntry,
	deletePuzzle,
	fetchAdminPuzzles,
	fetchPlayerAllowlist,
	logout,
	removePlayerAllowlistEntry
} from '$lib/services/api';
import { goto } from '$app/navigation';

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
		logout: vi.fn(),
		deletePuzzle: vi.fn(),
		fetchAdminPuzzles: vi.fn().mockResolvedValue([]),
		fetchPlayerAllowlist: vi.fn().mockResolvedValue([]),
		addPlayerAllowlistEntry: vi.fn(),
		removePlayerAllowlistEntry: vi.fn(),
		getThumbnailUrl: vi.fn(() => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
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
	resolve: (path: string) => path
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

const mockAllowlist: PlayerAllowlistEntry[] = [
	{
		email: 'linked@example.com',
		createdAt: 1,
		addedBy: 'admin',
		player: {
			id: 'player-1',
			email: 'linked@example.com',
			name: 'Linked Player',
			createdAt: 1,
			lastLoginAt: 2
		}
	},
	{
		email: 'pending@example.com',
		createdAt: 2,
		addedBy: 'admin'
	}
];

describe('Admin Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue([]);
	});

	it('renders the admin control panel without the server upload form', async () => {
		render(AdminPage);

		await expect.element(page.getByRole('heading', { name: /control panel/i })).toBeVisible();
		await expect.element(page.getByText('MISSION DATABASE')).toBeVisible();
		await expect.element(page.getByText('PLAYER ACCESS')).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: /^upload$/i }))
			.toHaveAttribute('href', '/upload');
		await expect.poll(() => page.getByText('CREATE MISSION', { exact: true }).query()).toBeNull();
		await expect.poll(() => page.getByLabelText('CLICK TO UPLOAD').query()).toBeNull();
	});

	it('shows admin puzzles including processing and failed states', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);

		render(AdminPage);

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

		render(AdminPage);

		await expect.element(page.getByText('Puzzle database unavailable')).toBeVisible();
		await expect.element(page.getByText('0 TOTAL')).toBeVisible();
	});

	it('deletes a ready puzzle after confirmation', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValueOnce(mockPuzzles).mockResolvedValueOnce([]);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		vi.mocked(deletePuzzle).mockResolvedValue(null);

		render(AdminPage);

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

		render(AdminPage);

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

		render(AdminPage);

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

		render(AdminPage);

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

		render(AdminPage);

		await expect.element(page.getByText('Forest Scene')).toBeVisible();
		await page.getByRole('button', { name: 'DELETE' }).first().click();
		await expect.element(page.getByText('First warning')).toBeVisible();

		await page.getByRole('button', { name: 'DELETE' }).nth(1).click();
		await expect.element(page.getByText('Second warning')).toBeVisible();

		await vi.advanceTimersByTimeAsync(5000);
		await expect.poll(() => page.getByText('Second warning').query()).toBeNull();
		vi.useRealTimers();
	});

	it('lists player allowlist entries with linked player metadata', async () => {
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue(mockAllowlist);

		render(AdminPage);

		await expect.element(page.getByText('linked@example.com')).toBeVisible();
		await expect.element(page.getByText('Linked Player')).toBeVisible();
		await expect.element(page.getByText('pending@example.com')).toBeVisible();
		await expect.element(page.getByText('No account created')).toBeVisible();
	});

	it('shows an API error when loading player access fails', async () => {
		vi.mocked(fetchPlayerAllowlist).mockRejectedValue(
			new ApiError(500, 'internal_error', 'Player access unavailable')
		);

		render(AdminPage);

		await expect.element(page.getByText('Player access unavailable')).toBeVisible();
		await expect.element(page.getByText('No players allowlisted.')).toBeVisible();
	});

	it('adds a player allowlist email through the form', async () => {
		vi.mocked(addPlayerAllowlistEntry).mockResolvedValue({
			email: 'new@example.com',
			createdAt: 3,
			addedBy: 'admin'
		});

		render(AdminPage);

		await page.getByLabelText('Player email').fill('new@example.com');
		await page.getByRole('button', { name: /add player/i }).click();

		await vi.waitFor(() => {
			expect(addPlayerAllowlistEntry).toHaveBeenCalledWith('new@example.com');
		});
	});

	it('shows an API error when adding a player fails', async () => {
		vi.mocked(addPlayerAllowlistEntry).mockRejectedValue(
			new ApiError(409, 'already_allowed', 'Player already allowed')
		);

		render(AdminPage);

		await page.getByLabelText('Player email').fill('new@example.com');
		await page.getByRole('button', { name: /add player/i }).click();

		await expect.element(page.getByText('Player already allowed')).toBeVisible();
	});

	it('removes a player allowlist email', async () => {
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue(mockAllowlist);
		vi.mocked(removePlayerAllowlistEntry).mockResolvedValue(undefined);

		render(AdminPage);

		await expect.element(page.getByText('linked@example.com')).toBeVisible();
		await page.getByRole('button', { name: 'REMOVE' }).first().click();

		await vi.waitFor(() => {
			expect(removePlayerAllowlistEntry).toHaveBeenCalledWith('linked@example.com');
		});
	});

	it('shows an API error when removing a player fails', async () => {
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue(mockAllowlist);
		vi.mocked(removePlayerAllowlistEntry).mockRejectedValue(
			new ApiError(500, 'internal_error', 'Could not remove player')
		);

		render(AdminPage);

		await expect.element(page.getByText('linked@example.com')).toBeVisible();
		await page.getByRole('button', { name: 'REMOVE' }).first().click();

		await expect.element(page.getByText('Could not remove player')).toBeVisible();
	});

	it('logs out and navigates to the admin login page', async () => {
		vi.mocked(logout).mockResolvedValue(undefined);

		render(AdminPage);

		await page.getByRole('button', { name: /logout/i }).click();

		await vi.waitFor(() => {
			expect(logout).toHaveBeenCalledOnce();
			expect(goto).toHaveBeenCalledWith('/admin/login');
		});
	});

	it('shows an error when logout fails', async () => {
		vi.mocked(logout).mockRejectedValue(new Error('network failure'));

		render(AdminPage);

		await page.getByRole('button', { name: /logout/i }).click();

		await expect.element(page.getByText('Failed to logout')).toBeVisible();
		expect(goto).not.toHaveBeenCalled();
	});

	it('polls for puzzle status updates when puzzles are processing', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const readyPuzzles: PuzzleSummary[] = [
			{ id: 'p2', name: 'City Lights', pieceCount: 225, status: 'ready' }
		];
		vi.mocked(fetchAdminPuzzles)
			.mockResolvedValueOnce(mockPuzzles)
			.mockResolvedValueOnce(readyPuzzles);

		render(AdminPage);

		await expect.element(page.getByText('City Lights')).toBeVisible();
		await expect.element(page.getByText('PROCESSING')).toBeVisible();

		await vi.advanceTimersByTimeAsync(3000);

		await vi.waitFor(() => {
			expect(fetchAdminPuzzles).toHaveBeenCalledTimes(2);
		});
		vi.useRealTimers();
	});

	it('ignores stale allowlist responses after a newer request is made', async () => {
		let resolveFirst: (value: PlayerAllowlistEntry[]) => void;
		const firstPromise = new Promise<PlayerAllowlistEntry[]>((resolve) => {
			resolveFirst = resolve;
		});
		const secondResponse: PlayerAllowlistEntry[] = [
			{ email: 'fresh@example.com', createdAt: 3, addedBy: 'admin' }
		];

		vi.mocked(fetchPlayerAllowlist)
			.mockImplementationOnce(() => firstPromise)
			.mockResolvedValueOnce(secondResponse);

		render(AdminPage);

		// Wait for the first loadAllowlist to start
		await vi.waitFor(() => {
			expect(fetchPlayerAllowlist).toHaveBeenCalledTimes(1);
		});

		// Trigger a second loadAllowlist via form submission before first resolves
		vi.mocked(addPlayerAllowlistEntry).mockResolvedValue({
			email: 'triggered@example.com',
			createdAt: 4,
			addedBy: 'admin'
		});
		await page.getByLabelText('Player email').fill('triggered@example.com');
		await page.getByRole('button', { name: /add player/i }).click();

		await vi.waitFor(() => {
			expect(fetchPlayerAllowlist).toHaveBeenCalledTimes(2);
		});

		// Now resolve the first (stale) response
		resolveFirst!([{ email: 'stale@example.com', createdAt: 1, addedBy: 'admin' }]);

		// The UI should show the second response, not the stale one
		await expect.element(page.getByText('fresh@example.com')).toBeVisible();
		await expect.poll(() => page.getByText('stale@example.com').query()).toBeNull();
	});
});
