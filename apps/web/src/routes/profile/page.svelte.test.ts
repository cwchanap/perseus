import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ProfilePage from './+page.svelte';
import type { PlayerPuzzleSummary, PlayerStatRow } from '$lib/types/puzzle';

vi.mock('$lib/services/api', () => ({
	getPlayerProfile: vi.fn(),
	getPlayerPuzzles: vi.fn(),
	getPlayerStats: vi.fn(),
	updatePlayerProfile: vi.fn(),
	uploadPlayerAvatar: vi.fn(),
	getAvatarUrl: vi.fn((id: string) => `/api/player/${id}/avatar`),
	getThumbnailUrl: vi.fn()
}));

vi.mock('$lib/stores/playerAuth', () => ({
	playerAuth: {
		refresh: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn((cb: (v: unknown) => void) => {
			cb({
				status: 'authenticated',
				user: {
					id: 'p1',
					email: 'e',
					name: 'Google',
					picture: null,
					createdAt: 1,
					lastLoginAt: 2
				},
				error: null
			});
			return () => {};
		})
	}
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
}));

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

import { getPlayerProfile, getPlayerPuzzles, getPlayerStats } from '$lib/services/api';

const puzzles: PlayerPuzzleSummary[] = [
	{
		id: 'pz-1',
		ownerId: 'p1',
		name: 'Test Puzzle',
		pieceCount: 100,
		status: 'ready',
		category: 'nature',
		createdAt: 1
	}
];

const stats: PlayerStatRow[] = [
	{
		playerId: 'p1',
		puzzleId: 'pz-1',
		bestTimeSeconds: 42,
		totalCompletions: 1,
		firstCompletedAt: 1,
		lastCompletedAt: 2
	}
];

describe('profile page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders identity card with effective name', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 1, puzzlesSolved: 2, totalCompletions: 3 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible({ timeout: 10000 });
	});

	it('shows summary counts', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 5, puzzlesSolved: 3, totalCompletions: 7 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByText('5')).toBeVisible();
		await expect.element(page.getByText('7')).toBeVisible();
	});
});
