import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleLeaderboardDialog from '../PuzzleLeaderboardDialog.svelte';

vi.mock('$lib/services/api', () => ({
	fetchFamilyLeaderboard: vi.fn()
}));

import { fetchFamilyLeaderboard } from '$lib/services/api';

describe('PuzzleLeaderboardDialog', () => {
	beforeEach(() => {
		vi.mocked(fetchFamilyLeaderboard).mockResolvedValue({
			entries: [
				{
					rank: 1,
					player: { id: 'p1', name: 'Ace', avatarUrl: null },
					bestTimeSeconds: 65,
					achievedAt: 1_000
				}
			]
		});
	});

	it('loads the family board for the selected difficulty and mode', async () => {
		const onDismiss = vi.fn();
		render(PuzzleLeaderboardDialog, {
			familyId: 'fam-1',
			familyName: 'Test Family',
			initialDifficulty: 'hard',
			initialMode: 'rotation',
			onDismiss
		});

		await expect.element(page.getByRole('heading', { name: 'TEST FAMILY' })).toBeVisible();
		await expect.poll(() => vi.mocked(fetchFamilyLeaderboard).mock.calls.length).toBeGreaterThan(0);
		expect(vi.mocked(fetchFamilyLeaderboard).mock.calls[0]?.[0]).toBe('fam-1');
		expect(vi.mocked(fetchFamilyLeaderboard).mock.calls[0]?.[1]).toEqual({
			difficulty: 'hard',
			mode: 'rotation'
		});

		await expect.element(page.getByTestId('leaderboard-entries')).toHaveTextContent('Ace');
		await expect.element(page.getByTestId('leaderboard-entries')).toHaveTextContent('01:05');

		await page.getByRole('button', { name: 'CLOSE' }).click();
		expect(onDismiss).toHaveBeenCalledOnce();
	});
});
