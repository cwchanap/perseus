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
import { uploadPlayerAvatar } from '$lib/services/api';
import { playerAuth } from '$lib/stores/playerAuth';
import { goto } from '$app/navigation';

const puzzles: PlayerPuzzleSummary[] = [
	{
		id: 'pz-1',
		name: 'Test Puzzle',
		pieceCount: 100,
		status: 'ready',
		category: 'nature',
		createdAt: 1
	}
];

const stats: PlayerStatRow[] = [
	{
		puzzleId: 'pz-1',
		puzzleName: 'Test Puzzle',
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
		await expect.element(page.getByText('Player One')).toBeVisible();
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

	it('shows an error with retry when loading the profile fails', async () => {
		vi.mocked(getPlayerProfile).mockRejectedValueOnce(new Error('Network error'));
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByTestId('profile-error')).toBeVisible();

		// Retry succeeds on the second call.
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Back Online',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});

		await page.getByText('Try again').click();
		await expect.element(page.getByText('Back Online')).toBeVisible();
	});

	it('discards the display name draft when editing is cancelled', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();

		await page.getByText('Edit profile').click();
		const input = page.getByTestId('display-name-input');
		await input.fill('Draft Name');
		await page.getByTestId('cancel-edit').click();

		// Re-enter edit mode: the draft must be gone, reverting to the saved name.
		await page.getByText('Edit profile').click();
		await expect.element(page.getByTestId('display-name-input')).toHaveValue('Player One');
	});

	it('clears the avatar file input after an upload so the same file can retry', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });
		vi.mocked(uploadPlayerAvatar).mockResolvedValue({ avatarUrl: '/api/player/p1/avatar' });

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();

		const fileInput = (await page.getByTestId('avatar-input').element()) as HTMLInputElement;
		const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
			type: 'image/png'
		});
		Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
		fileInput.dispatchEvent(new Event('change', { bubbles: true }));

		// The finally block resets the input value so re-selecting the same file
		// fires another change event (needed to retry uploads).
		await expect.poll(() => fileInput.value).toBe('');
	});

	it('renders the profile even when puzzles fail to load (allSettled)', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Survivor',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockRejectedValue(new Error('puzzles down'));
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		// Profile still renders despite the puzzles failure (no error screen).
		await expect.element(page.getByText('Survivor')).toBeVisible();
		await expect.element(page.getByText("You haven't uploaded any puzzles yet.")).toBeVisible();
		// The best-times list (from the still-loaded stats) also renders.
		await expect.element(page.getByText('Best Times')).toBeVisible();
	});

	it('redirects anonymous users to login', async () => {
		// Override the default authenticated subscription for this one render.
		// Let `run` infer the real Subscriber<PlayerAuthState> signature so the
		// mock matches vi.mocked()'s expected type.
		vi.mocked(playerAuth.subscribe).mockImplementationOnce((run) => {
			run({ status: 'anonymous', user: null, error: null });
			return () => {};
		});
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'X',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });

		render(ProfilePage);
		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/login');
		});
	});

	it('redirects to login when the session becomes anonymous after loading (e.g. logout)', async () => {
		// Capture the subscriber callback so we can emit a second state change
		// (logout) after the initial authenticated load has already run. The old
		// `settled` guard ignored this second emission; the page must keep
		// redirecting on any non-authenticated, non-loading state.
		let emitLogout: () => void = () => {};
		vi.mocked(playerAuth.subscribe).mockImplementationOnce((run) => {
			emitLogout = () => run({ status: 'anonymous', user: null, error: null });
			run({
				status: 'authenticated',
				user: {
					id: 'p1',
					email: 'e',
					name: 'Logout Me',
					picture: null,
					createdAt: 1,
					lastLoginAt: 2
				},
				error: null
			});
			return () => {};
		});
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Logout Me',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });

		render(ProfilePage);
		// Initial authenticated load renders the profile.
		await expect.element(page.getByText('Logout Me')).toBeVisible();

		// Simulate logout: the store emits anonymous after the profile loaded.
		emitLogout();

		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/login');
		});
	});

	it('renders the first puzzle page and shows Load more when nextCursor is present', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 2, puzzlesSolved: 1, totalCompletions: 3 }
		});
		// Page 1 returns a cursor (more puzzles exist).
		vi.mocked(getPlayerPuzzles).mockResolvedValue({
			puzzles: [
				{ id: 'pz-1', name: 'Forest Puzzle', pieceCount: 4, status: 'ready', createdAt: 2 }
			],
			nextCursor: 'puz-cursor'
		});
		// Stats return no cursor → no stats Load more control.
		vi.mocked(getPlayerStats).mockResolvedValue({ stats, nextCursor: undefined });

		render(ProfilePage);
		// PuzzleCard renders the name in an <h3>; the Best Times list renders the
		// same name in a link, so scope to the heading to stay unambiguous.
		await expect.element(page.getByRole('heading', { name: 'Forest Puzzle' })).toBeVisible();
		await expect
			.element(page.getByRole('heading', { name: 'Ocean Puzzle' }))
			.not.toBeInTheDocument();
		await expect.element(page.getByTestId('load-more-puzzles')).toBeVisible();
		await expect.element(page.getByTestId('load-more-stats')).not.toBeInTheDocument();
	});

	it('appends the next puzzle page on Load more and hides the button when exhausted', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 2, puzzlesSolved: 1, totalCompletions: 3 }
		});
		vi.mocked(getPlayerPuzzles).mockImplementation(async (params) => {
			if (params?.cursor === 'puz-cursor') {
				return {
					puzzles: [
						{ id: 'pz-2', name: 'Ocean Puzzle', pieceCount: 9, status: 'ready', createdAt: 1 }
					],
					nextCursor: undefined
				};
			}
			return {
				puzzles: [
					{ id: 'pz-1', name: 'Forest Puzzle', pieceCount: 4, status: 'ready', createdAt: 2 }
				],
				nextCursor: 'puz-cursor'
			};
		});
		vi.mocked(getPlayerStats).mockResolvedValue({ stats, nextCursor: undefined });

		render(ProfilePage);
		await expect.element(page.getByRole('heading', { name: 'Forest Puzzle' })).toBeVisible();

		await page.getByTestId('load-more-puzzles').click();

		await expect.element(page.getByRole('heading', { name: 'Ocean Puzzle' })).toBeVisible();
		expect(getPlayerPuzzles).toHaveBeenCalledWith({ cursor: 'puz-cursor' });
		await expect.element(page.getByTestId('load-more-puzzles')).not.toBeInTheDocument();
	});

	it('paginates the Best Times list independently of My Puzzles', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 2, puzzlesSolved: 1, totalCompletions: 3 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		const stat1: PlayerStatRow = {
			puzzleId: 'pz-a',
			puzzleName: 'Alpha Stat',
			bestTimeSeconds: 10,
			totalCompletions: 1,
			firstCompletedAt: 1,
			lastCompletedAt: 2
		};
		const stat2: PlayerStatRow = {
			puzzleId: 'pz-b',
			puzzleName: 'Beta Stat',
			bestTimeSeconds: 20,
			totalCompletions: 1,
			firstCompletedAt: 1,
			lastCompletedAt: 2
		};
		vi.mocked(getPlayerStats).mockImplementation(async (params) => {
			if (params?.cursor === 'stat-cursor') {
				return { stats: [stat2], nextCursor: undefined };
			}
			return { stats: [stat1], nextCursor: 'stat-cursor' };
		});

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();
		await expect.element(page.getByText('Alpha Stat')).toBeVisible();
		await expect.element(page.getByText('Beta Stat')).not.toBeInTheDocument();
		await expect.element(page.getByTestId('load-more-stats')).toBeVisible();

		await page.getByTestId('load-more-stats').click();

		await expect.element(page.getByText('Beta Stat')).toBeVisible();
		expect(getPlayerStats).toHaveBeenCalledWith({ cursor: 'stat-cursor' });
		await expect.element(page.getByTestId('load-more-stats')).not.toBeInTheDocument();
	});

	it('renders the profile even when stats fail to load (allSettled)', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Stats Survivor',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockRejectedValue(new Error('stats down'));

		render(ProfilePage);
		await expect.element(page.getByText('Stats Survivor')).toBeVisible();
		await expect.element(page.getByText('No solves recorded yet.')).toBeVisible();
	});

	it('renders profile picture img when profile.picture is set', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Pic Player',
			picture: 'https://example.com/avatar.jpg',
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats, nextCursor: undefined });

		render(ProfilePage);
		await expect.element(page.getByText('Pic Player')).toBeVisible();
		const img = page.getByRole('img');
		await expect.element(img).toBeVisible();
		await expect.element(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
	});

	it('saves the display name when Save is clicked', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Original Name',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });

		const { updatePlayerProfile } = await import('$lib/services/api');
		vi.mocked(updatePlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'New Name',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});

		render(ProfilePage);
		await expect.element(page.getByText('Original Name')).toBeVisible();

		await page.getByText('Edit profile').click();
		const input = page.getByTestId('display-name-input');
		await input.fill('New Name');
		await page.getByText('Save').click();

		expect(updatePlayerProfile).toHaveBeenCalledWith({ displayName: 'New Name' });
	});

	it('shows puzzleId when a stat row has no puzzleName', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Stat Player',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		const statNoName: PlayerStatRow = {
			puzzleId: 'pz-anon',
			puzzleName: '',
			bestTimeSeconds: 30,
			totalCompletions: 2,
			firstCompletedAt: 1,
			lastCompletedAt: 2
		};
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [statNoName], nextCursor: undefined });

		render(ProfilePage);
		await expect.element(page.getByText('Stat Player')).toBeVisible();
		// When puzzleName is empty, the puzzleId is shown instead
		await expect.element(page.getByText('pz-anon')).toBeVisible();
	});

	it('logs error when load more puzzles fails', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 2, puzzlesSolved: 1, totalCompletions: 3 }
		});
		vi.mocked(getPlayerPuzzles).mockImplementation(async (params) => {
			if (params?.cursor === 'puz-cursor') {
				throw new Error('pagination down');
			}
			return {
				puzzles: [
					{ id: 'pz-1', name: 'Forest Puzzle', pieceCount: 4, status: 'ready', createdAt: 2 }
				],
				nextCursor: 'puz-cursor'
			};
		});
		vi.mocked(getPlayerStats).mockResolvedValue({ stats, nextCursor: undefined });

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(ProfilePage);
		await expect.element(page.getByRole('heading', { name: 'Forest Puzzle' })).toBeVisible();

		await page.getByTestId('load-more-puzzles').click();

		await vi.waitFor(() => {
			expect(consoleSpy).toHaveBeenCalledWith('Failed to load more puzzles:', expect.any(Error));
		});
		consoleSpy.mockRestore();
	});

	it('logs error when load more stats fails', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 2, puzzlesSolved: 1, totalCompletions: 3 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockImplementation(async (params) => {
			if (params?.cursor === 'stat-cursor') {
				throw new Error('stats pagination down');
			}
			return {
				stats: [
					{
						puzzleId: 'pz-a',
						puzzleName: 'Alpha Stat',
						bestTimeSeconds: 10,
						totalCompletions: 1,
						firstCompletedAt: 1,
						lastCompletedAt: 2
					}
				],
				nextCursor: 'stat-cursor'
			};
		});

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();
		await expect.element(page.getByTestId('load-more-stats')).toBeVisible();

		await page.getByTestId('load-more-stats').click();

		await vi.waitFor(() => {
			expect(consoleSpy).toHaveBeenCalledWith('Failed to load more stats:', expect.any(Error));
		});
		consoleSpy.mockRestore();
	});

	it('shows an error and logs when saving the display name fails', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Original Name',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });

		const { updatePlayerProfile } = await import('$lib/services/api');
		vi.mocked(updatePlayerProfile).mockRejectedValueOnce(new Error('save failed'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(ProfilePage);
		await expect.element(page.getByText('Original Name')).toBeVisible();

		await page.getByText('Edit profile').click();
		await page.getByTestId('display-name-input').fill('New Name');
		await page.getByText('Save').click();

		await vi.waitFor(() => {
			expect(consoleSpy).toHaveBeenCalledWith('Failed to save name:', expect.any(Error));
		});
		await expect.element(page.getByTestId('profile-save-error')).toBeVisible();
		consoleSpy.mockRestore();
	});

	it('shows an error and logs when avatar upload fails', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });
		vi.mocked(uploadPlayerAvatar).mockRejectedValueOnce(new Error('upload failed'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();

		const fileInput = (await page.getByTestId('avatar-input').element()) as HTMLInputElement;
		const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
			type: 'image/png'
		});
		Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
		fileInput.dispatchEvent(new Event('change', { bubbles: true }));

		await vi.waitFor(() => {
			expect(consoleSpy).toHaveBeenCalledWith('Failed to upload avatar:', expect.any(Error));
		});
		await expect.element(page.getByTestId('profile-save-error')).toBeVisible();
		consoleSpy.mockRestore();
	});
});
