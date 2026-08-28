import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import type { PuzzleLeaderboardResponse } from '@perseus/types';
import PuzzleLeaderboardDialog from '../PuzzleLeaderboardDialog.svelte';

vi.mock('$lib/services/api', () => ({
	fetchFamilyLeaderboard: vi.fn()
}));

import { fetchFamilyLeaderboard } from '$lib/services/api';

describe('PuzzleLeaderboardDialog', () => {
	beforeEach(() => {
		vi.mocked(fetchFamilyLeaderboard).mockReset();
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

	it('shows loading until the leaderboard fetch resolves', async () => {
		let resolveFetch!: (response: PuzzleLeaderboardResponse) => void;
		vi.mocked(fetchFamilyLeaderboard).mockReturnValue(
			new Promise<PuzzleLeaderboardResponse>((resolve) => {
				resolveFetch = resolve;
			})
		);

		render(PuzzleLeaderboardDialog, {
			familyId: 'fam-1',
			familyName: 'Test Family',
			onDismiss: vi.fn()
		});

		await expect.element(page.getByTestId('leaderboard-loading')).toBeVisible();

		resolveFetch({
			entries: [
				{
					rank: 1,
					player: { id: 'p1', name: 'Ace', avatarUrl: null },
					bestTimeSeconds: 65,
					achievedAt: 1_000
				}
			]
		});
		await expect.element(page.getByTestId('leaderboard-entries')).toHaveTextContent('Ace');
	});

	it('shows an error when the leaderboard fetch fails', async () => {
		const failure = new Error('network down');
		vi.mocked(fetchFamilyLeaderboard).mockRejectedValue(failure);
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			render(PuzzleLeaderboardDialog, {
				familyId: 'fam-1',
				familyName: 'Test Family',
				onDismiss: vi.fn()
			});

			await expect.element(page.getByTestId('leaderboard-error')).toBeVisible();
			expect(page.getByTestId('leaderboard-entries').query()).toBeNull();
			expect(consoleSpy).toHaveBeenCalledWith('Failed to load family leaderboard', failure);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it('shows the viewer row when the viewer is not in the leaderboard entries', async () => {
		vi.mocked(fetchFamilyLeaderboard).mockResolvedValue({
			entries: [
				{
					rank: 1,
					player: { id: 'p1', name: 'Ace', avatarUrl: null },
					bestTimeSeconds: 65,
					achievedAt: 1_000
				}
			],
			me: {
				rank: 7,
				player: { id: 'me', name: 'You', avatarUrl: null },
				bestTimeSeconds: 95,
				achievedAt: 2
			}
		});

		render(PuzzleLeaderboardDialog, {
			familyId: 'fam-1',
			familyName: 'Test Family',
			onDismiss: vi.fn()
		});

		await expect.element(page.getByTestId('leaderboard-me')).toBeVisible();
		await expect.element(page.getByTestId('leaderboard-me')).toHaveTextContent('#7');
		await expect.element(page.getByTestId('leaderboard-me')).toHaveTextContent('You (you)');
	});

	it('hides the viewer row when the viewer is already in the leaderboard entries', async () => {
		vi.mocked(fetchFamilyLeaderboard).mockResolvedValue({
			entries: [
				{
					rank: 1,
					player: { id: 'p1', name: 'Ace', avatarUrl: null },
					bestTimeSeconds: 65,
					achievedAt: 1_000
				}
			],
			me: {
				rank: 1,
				player: { id: 'p1', name: 'Ace', avatarUrl: null },
				bestTimeSeconds: 65,
				achievedAt: 1_000
			}
		});

		render(PuzzleLeaderboardDialog, {
			familyId: 'fam-1',
			familyName: 'Test Family',
			onDismiss: vi.fn()
		});

		await expect.element(page.getByTestId('leaderboard-entries')).toHaveTextContent('Ace');
		expect(page.getByTestId('leaderboard-me').query()).toBeNull();
	});

	it('refetches the leaderboard when difficulty changes', async () => {
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

		render(PuzzleLeaderboardDialog, {
			familyId: 'fam-1',
			familyName: 'Test Family',
			initialDifficulty: 'normal',
			initialMode: 'standard',
			onDismiss: vi.fn()
		});

		await expect.element(page.getByTestId('leaderboard-entries')).toHaveTextContent('Ace');
		await page.getByTestId('leaderboard-difficulty').selectOptions('hard');
		await expect.poll(() => vi.mocked(fetchFamilyLeaderboard).mock.calls.length).toBe(2);
		expect(vi.mocked(fetchFamilyLeaderboard).mock.calls[1]?.[0]).toBe('fam-1');
		expect(vi.mocked(fetchFamilyLeaderboard).mock.calls[1]?.[1]).toEqual({
			difficulty: 'hard',
			mode: 'standard'
		});
	});

	it('refetches the leaderboard when mode changes', async () => {
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

		render(PuzzleLeaderboardDialog, {
			familyId: 'fam-1',
			familyName: 'Test Family',
			initialDifficulty: 'normal',
			initialMode: 'standard',
			onDismiss: vi.fn()
		});

		await expect.element(page.getByTestId('leaderboard-entries')).toHaveTextContent('Ace');
		await page.getByTestId('leaderboard-mode').selectOptions('rotation');
		await expect.poll(() => vi.mocked(fetchFamilyLeaderboard).mock.calls.length).toBe(2);
		expect(vi.mocked(fetchFamilyLeaderboard).mock.calls[1]?.[0]).toBe('fam-1');
		expect(vi.mocked(fetchFamilyLeaderboard).mock.calls[1]?.[1]).toEqual({
			difficulty: 'normal',
			mode: 'rotation'
		});
	});

	it('dismisses when Escape is pressed on the modal', async () => {
		const onDismiss = vi.fn();
		render(PuzzleLeaderboardDialog, {
			familyId: 'fam-1',
			familyName: 'Test Family',
			onDismiss
		});

		await expect.element(page.getByTestId('family-leaderboard-modal')).toBeVisible();
		const modal = page.getByTestId('family-leaderboard-modal').element();
		modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onDismiss).toHaveBeenCalledOnce();
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
