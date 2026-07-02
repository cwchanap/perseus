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
	getThumbnailUrl: vi.fn(),
	resolveAssetUrl: vi.fn((url: string | null | undefined) => url ?? null)
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
}));

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

import { getPlayerProfile, getPlayerPuzzles, getPlayerStats } from '$lib/services/api';
import { uploadPlayerAvatar, resolveAssetUrl } from '$lib/services/api';

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
		// clearAllMocks clears call/instance state but not implementations
		// set via mockImplementation; restore the identity default so a
		// per-test override (e.g. the cross-origin avatar test) doesn't leak.
		vi.mocked(resolveAssetUrl).mockImplementation((url) => url ?? null);
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
		await expect.element(page.getByTestId('profile-summary-uploaded')).toBeVisible();
		await expect.element(page.getByTestId('profile-summary-solved')).toHaveTextContent('3');
		await expect.element(page.getByTestId('profile-summary-completions')).toHaveTextContent('7');
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
		await page.getByRole('button', { name: 'Cancel' }).click();

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

		// Avatar input is gated behind the Edit toggle.
		await page.getByText('Edit profile').click();
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

	it('busts the avatar img src with a version param after a re-upload', async () => {
		// The profile already shows an avatar served from the fixed avatar path.
		// A re-upload overwrites the same R2 key and the API returns the same
		// path, so without a cache-buster the <img src> is unchanged and the
		// browser keeps showing the old cached image.
		const avatarPath = '/api/player/p1/avatar';
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: avatarPath,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });
		vi.mocked(uploadPlayerAvatar).mockResolvedValue({ avatarUrl: avatarPath });

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();
		// Initially the img src is the bare path (no cache-buster).
		await expect.element(page.getByRole('img')).toHaveAttribute('src', avatarPath);

		await page.getByText('Edit profile').click();
		const fileInput = (await page.getByTestId('avatar-input').element()) as HTMLInputElement;
		const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
			type: 'image/png'
		});
		Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
		fileInput.dispatchEvent(new Event('change', { bubbles: true }));

		// After the upload, the src must change to the path plus a ?v=<ts>
		// cache-buster so the browser re-fetches the new bytes.
		await expect
			.element(page.getByRole('img'))
			.toHaveAttribute('src', expect.stringMatching(/^\/api\/player\/p1\/avatar\?v=\d+$/));
	});

	it('preserves the API origin on the avatar src after a re-upload', async () => {
		// When the API is on a separate origin (e.g. local dev with
		// PUBLIC_API_BASE set), resolveAssetUrl prefixes the origin-relative
		// avatar path with API_BASE. The cache-busting code path must run the
		// upload result through resolveAssetUrl so the <img src> keeps pointing
		// at the API origin instead of reverting to the bare path (which would
		// hit the web origin and 404).
		const apiOrigin = 'http://localhost:4690';
		const avatarPath = '/api/player/p1/avatar';
		vi.mocked(resolveAssetUrl).mockImplementation((url) =>
			url && url.startsWith('/') ? `${apiOrigin}${url}` : (url ?? null)
		);
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: `${apiOrigin}${avatarPath}`,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });
		vi.mocked(uploadPlayerAvatar).mockResolvedValue({ avatarUrl: avatarPath });

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();
		await expect.element(page.getByRole('img')).toHaveAttribute('src', `${apiOrigin}${avatarPath}`);

		await page.getByText('Edit profile').click();
		const fileInput = (await page.getByTestId('avatar-input').element()) as HTMLInputElement;
		const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
			type: 'image/png'
		});
		Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
		fileInput.dispatchEvent(new Event('change', { bubbles: true }));

		// The src must keep the API origin prefix AND gain the cache-buster.
		await expect
			.element(page.getByRole('img'))
			.toHaveAttribute(
				'src',
				expect.stringMatching(
					new RegExp(`^${apiOrigin.replace('/', '\\/')}${avatarPath}\\?v=\\d+$`)
				)
			);
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
		expect(getPlayerPuzzles).toHaveBeenCalledWith(
			expect.objectContaining({ cursor: 'puz-cursor' })
		);
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
		expect(getPlayerStats).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'stat-cursor' }));
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
		vi.mocked(updatePlayerProfile).mockResolvedValue(undefined);

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

		// Avatar input is gated behind the Edit toggle.
		await page.getByText('Edit profile').click();
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

	it('renders join date and last login in the identity card', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Dated Player',
			picture: null,
			createdAt: 1_700_000_000_000,
			lastLoginAt: 1_700_000_100_000,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });

		render(ProfilePage);
		await expect.element(page.getByText('Dated Player')).toBeVisible();
		await expect.element(page.getByTestId('profile-join-date')).toBeVisible();
		await expect.element(page.getByTestId('profile-last-login')).toBeVisible();
	});

	it('resets display name to Google default when Reset is clicked', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Custom Name',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });

		const { updatePlayerProfile } = await import('$lib/services/api');
		vi.mocked(updatePlayerProfile).mockResolvedValue(undefined);

		render(ProfilePage);
		await expect.element(page.getByText('Custom Name')).toBeVisible();

		await page.getByText('Edit profile').click();
		await page.getByTestId('reset-name').click();

		expect(updatePlayerProfile).toHaveBeenCalledWith({ displayName: null });
	});

	it('renders non-ready puzzles with a status overlay instead of a link', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 1, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({
			puzzles: [
				{
					id: 'pz-proc',
					name: 'Processing Puzzle',
					pieceCount: 4,
					status: 'processing',
					createdAt: 2
				}
			],
			nextCursor: undefined
		});
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [], nextCursor: undefined });

		render(ProfilePage);
		await expect.element(page.getByRole('heading', { name: 'Processing Puzzle' })).toBeVisible();
		// The card must NOT be a link (no href) for a processing puzzle.
		const card = page.getByTestId('puzzle-card');
		await expect.element(card).not.toHaveAttribute('href');
		// A status overlay is shown instead of the PLAY overlay.
		await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
		await expect.element(page.getByTestId('card-overlay')).not.toBeInTheDocument();
	});
});
