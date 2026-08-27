import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdminPage from './+page.svelte';
import { fetchAdminPuzzles, fetchPlayerAllowlist } from '$lib/services/api';

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
		fetchPlayerAllowlist: vi.fn().mockResolvedValue([]),
		addPlayerAllowlistEntry: vi.fn(),
		removePlayerAllowlistEntry: vi.fn(),
		getReferenceImageUrl: vi.fn((puzzleId: string) => `/api/puzzles/${puzzleId}/reference`),
		getFamilyThumbnailUrl: vi.fn(() => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
		getThumbnailUrl: vi.fn(() => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({
		clearSession: vi.fn()
	})
}));

vi.mock('$app/paths', () => ({
	resolve: (path: string) => path
}));

describe('Admin Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue([]);
	});

	it('defaults to puzzles and lazily loads Player Access', async () => {
		render(AdminPage);

		await expect.element(page.getByRole('heading', { name: /control panel/i })).toBeVisible();
		const puzzlesTab = page.getByRole('tab', { name: 'PUZZLES' });
		const playersTab = page.getByRole('tab', { name: 'PLAYER ACCESS' });
		await expect.element(puzzlesTab).toHaveAttribute('aria-selected', 'true');
		await expect.element(playersTab).toHaveAttribute('aria-selected', 'false');
		await expect
			.element(page.getByRole('link', { name: /^upload$/i }))
			.toHaveAttribute('href', '/upload');
		await expect
			.element(page.getByRole('link', { name: /view arcade/i }))
			.toHaveAttribute('href', '/');
		await vi.waitFor(() => {
			expect(fetchAdminPuzzles).toHaveBeenCalledTimes(1);
		});
		expect(fetchPlayerAllowlist).not.toHaveBeenCalled();

		await playersTab.click();

		await expect.element(playersTab).toHaveAttribute('aria-selected', 'true');
		await vi.waitFor(() => {
			expect(fetchPlayerAllowlist).toHaveBeenCalledTimes(1);
		});
		await expect.poll(() => page.getByText('MISSION DATABASE', { exact: true }).query()).toBeNull();
		await expect.poll(() => page.getByLabelText('Filter by category').query()).toBeNull();
	});

	it('supports standard keyboard navigation between tabs', async () => {
		render(AdminPage);

		const puzzlesTab = page.getByRole('tab', { name: 'PUZZLES' });
		const playersTab = page.getByRole('tab', { name: 'PLAYER ACCESS' });
		const puzzlesButton = await puzzlesTab.element();
		const playersButton = await playersTab.element();

		puzzlesButton.focus();
		puzzlesButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(document.activeElement).toBe(playersButton);
		await expect.element(playersTab).toHaveAttribute('aria-selected', 'true');

		playersButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(document.activeElement).toBe(puzzlesButton);
		await expect.element(puzzlesTab).toHaveAttribute('aria-selected', 'true');

		puzzlesButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		expect(document.activeElement).toBe(playersButton);
		await expect.element(playersTab).toHaveAttribute('aria-selected', 'true');

		playersButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		expect(document.activeElement).toBe(puzzlesButton);
		await expect.element(puzzlesTab).toHaveAttribute('aria-selected', 'true');

		puzzlesButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		expect(document.activeElement).toBe(playersButton);
		await expect.element(playersTab).toHaveAttribute('aria-selected', 'true');
	});
});
