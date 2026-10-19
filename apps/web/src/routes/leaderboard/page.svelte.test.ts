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
			.toMatchTextContent('Overall Leaderboard');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toMatchTextContent('Ace');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toMatchTextContent('500');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toMatchTextContent('2');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toMatchTextContent('1');
		await expect.element(page.getByTestId('overall-leaderboard-table')).toMatchTextContent('0');
	});
});
