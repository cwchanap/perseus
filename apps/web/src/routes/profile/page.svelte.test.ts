import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Mock IntersectionObserver so the infinite-scroll $effect can be exercised.
// The captured callback is invoked manually in tests to simulate the sentinel
// scrolling into view.
let intersectionCallback: IntersectionObserverCallback | null = null;
class MockIntersectionObserver {
	constructor(callback: IntersectionObserverCallback) {
		intersectionCallback = callback;
	}
	observe = vi.fn();
	disconnect = vi.fn();
	unobserve = vi.fn();
	takeRecords = vi.fn();
}

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
		puzzleName: 'Cat Puzzle',
		bestTimeSeconds: 42,
		totalCompletions: 3,
		firstCompletedAt: 1,
		lastCompletedAt: 2
	}
];

describe('profile page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		intersectionCallback = null;
		vi.stubGlobal('IntersectionObserver', MockIntersectionObserver as never);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
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

	it('Best Times shows puzzle name and completions, not puzzle id', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		// Puzzle name (not id) renders as the link text.
		await expect.element(page.getByText('Cat Puzzle')).toBeVisible();
		// Completions count renders with the × suffix.
		await expect.element(page.getByText('3×')).toBeVisible();
		// The raw puzzle id must NOT be shown as the link text.
		expect(page.getByText('pz-1').elements()).toHaveLength(0);
	});

	it('Best Times falls back to puzzle id when puzzleName is null (deleted puzzle)', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({
			stats: [{ ...stats[0], puzzleName: null }]
		});

		render(ProfilePage);
		await expect.element(page.getByText('pz-1')).toBeVisible();
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

	it('appends a second page of puzzles when the scroll sentinel intersects', async () => {
		const page1: PlayerPuzzleSummary[] = [
			{ id: 'pz-a', name: 'Alpha Puzzle', pieceCount: 4, status: 'ready', createdAt: 1 }
		];
		const page2: PlayerPuzzleSummary[] = [
			{ id: 'pz-b', name: 'Beta Puzzle', pieceCount: 4, status: 'ready', createdAt: 0 }
		];
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 2, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles)
			.mockResolvedValueOnce({ puzzles: page1, nextCursor: '1|pz-a' })
			.mockResolvedValueOnce({ puzzles: page2, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		// First page renders.
		await expect.element(page.getByText('Alpha Puzzle')).toBeVisible();
		// Sentinel is present.
		await expect.element(page.getByTestId('profile-scroll-sentinel')).toBeInTheDocument();

		// Simulate the sentinel scrolling into view.
		expect(intersectionCallback).not.toBeNull();
		intersectionCallback!(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);

		// Second page appends; both cards now visible.
		await expect.element(page.getByText('Beta Puzzle')).toBeVisible();
		expect(vi.mocked(getPlayerPuzzles)).toHaveBeenCalledTimes(2);
	});

	it('shows a retry button when the next-page fetch fails, then recovers', async () => {
		const page1: PlayerPuzzleSummary[] = [
			{ id: 'pz-a', name: 'Alpha Puzzle', pieceCount: 4, status: 'ready', createdAt: 1 }
		];
		const page2: PlayerPuzzleSummary[] = [
			{ id: 'pz-b', name: 'Beta Puzzle', pieceCount: 4, status: 'ready', createdAt: 0 }
		];
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 2, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles)
			.mockResolvedValueOnce({ puzzles: page1, nextCursor: '1|pz-a' })
			.mockRejectedValueOnce(new Error('Network error'))
			.mockResolvedValueOnce({ puzzles: page2, nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByText('Alpha Puzzle')).toBeVisible();

		intersectionCallback!(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver
		);
		await expect.element(page.getByTestId('profile-load-more-error')).toBeVisible();

		// Click retry → second page loads.
		await page.getByRole('button', { name: 'Retry' }).click();
		await expect.element(page.getByText('Beta Puzzle')).toBeVisible();
	});
});
