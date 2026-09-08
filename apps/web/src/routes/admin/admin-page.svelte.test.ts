import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdminPage from './+page.svelte';
import type { PuzzleFamilySummary } from '@perseus/types';
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
	const family: PuzzleFamilySummary = {
		id: 'family-1',
		name: 'Mission One',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1,
		category: 'Nature',
		variants: {
			easy: { id: 'family-1-easy', difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: 'family-1-normal', difficulty: 'normal', pieceCount: 49, status: 'ready' },
			hard: { id: 'family-1-hard', difficulty: 'hard', pieceCount: 100, status: 'ready' }
		}
	};
	const allowlist = [{ email: 'player@example.com', createdAt: 1, addedBy: 'admin' }];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([family]);
		vi.mocked(fetchPlayerAllowlist).mockResolvedValue(allowlist);
	});

	it('mounts both panels, reports both counts, and hides inactive tabpanels', async () => {
		render(AdminPage);

		const puzzlesTab = page.getByRole('tab', { name: 'Missions' });
		const playersTab = page.getByRole('tab', { name: 'Player access' });
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
			expect(fetchPlayerAllowlist).toHaveBeenCalledTimes(1);
		});
		await expect.element(page.getByTestId('admin-missions-count')).toHaveTextContent('1');
		await expect.element(page.getByTestId('admin-players-count')).toHaveTextContent('1');

		const puzzlesPanel = document.getElementById('admin-panel-puzzles');
		const playersPanel = document.getElementById('admin-panel-players');
		expect(puzzlesPanel).not.toBeNull();
		expect(playersPanel).not.toBeNull();
		expect(puzzlesPanel).not.toHaveAttribute('hidden');
		expect(playersPanel).toHaveAttribute('hidden');
		await expect.element(page.getByText('Mission One')).toBeVisible();

		await playersTab.click();

		await expect.element(playersTab).toHaveAttribute('aria-selected', 'true');
		expect(puzzlesPanel).toHaveAttribute('hidden');
		expect(playersPanel).not.toHaveAttribute('hidden');
		await expect.element(page.getByText('player@example.com')).toBeVisible();
	});

	it('supports standard keyboard navigation between tabs', async () => {
		render(AdminPage);

		const puzzlesTab = page.getByRole('tab', { name: 'Missions' });
		const playersTab = page.getByRole('tab', { name: 'Player access' });
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
