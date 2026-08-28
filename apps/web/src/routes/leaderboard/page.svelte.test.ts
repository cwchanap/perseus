import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LeaderboardPage from './+page.svelte';

vi.mock('$lib/services/api', () => ({
	fetchOverallLeaderboard: vi.fn()
}));

import { fetchOverallLeaderboard } from '$lib/services/api';

describe('Leaderboard page', () => {
	beforeEach(() => {
		vi.mocked(fetchOverallLeaderboard).mockResolvedValue({
			entries: [
				{
					rank: 1,
					player: { id: 'p1', name: 'Ace', avatarUrl: null },
					score: 500,
					easyClears: 2,
					normalClears: 1,
					hardClears: 0
				}
			]
		});
	});

	it('renders overall scoreboard rows with E/N/H counts', async () => {
		render(LeaderboardPage);

		await expect
			.element(page.getByTestId('leaderboard-title'))
			.toHaveTextContent('Overall Leaderboard');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toHaveTextContent('Ace');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toHaveTextContent('500');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toHaveTextContent('2');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toHaveTextContent('1');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toHaveTextContent('0');
	});
});
