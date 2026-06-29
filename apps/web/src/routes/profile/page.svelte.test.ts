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
import { uploadPlayerAvatar, updatePlayerProfile } from '$lib/services/api';

// Mock IntersectionObserver so the infinite-scroll $effects can be exercised.
// The page now has two independent sentinels (puzzles + stats), each with its
// own observer. We track all observer instances and their observed targets so
// tests can trigger a specific sentinel by its data-testid.
let observerInstances: MockIntersectionObserver[] = [];
class MockIntersectionObserver {
	callback: IntersectionObserverCallback;
	targets: Element[] = [];
	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		observerInstances.push(this);
	}
	observe = vi.fn((target: Element) => {
		this.targets.push(target);
	});
	disconnect = vi.fn();
	unobserve = vi.fn();
	takeRecords = vi.fn();
}

// Trigger the IntersectionObserver callback for the sentinel with the given
// data-testid, simulating it scrolling into (or out of) view.
function triggerIntersectionByTestid(testid: string, isIntersecting = true) {
	for (const obs of observerInstances) {
		for (const target of obs.targets) {
			if (target.getAttribute('data-testid') === testid) {
				obs.callback(
					[{ isIntersecting: isIntersecting } as IntersectionObserverEntry],
					{} as IntersectionObserver
				);
				return;
			}
		}
	}
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
		observerInstances = [];
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

		// Simulate the puzzles sentinel scrolling into view.
		triggerIntersectionByTestid('profile-scroll-sentinel');

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

		triggerIntersectionByTestid('profile-scroll-sentinel');
		await expect.element(page.getByTestId('profile-load-more-error')).toBeVisible();

		// Click retry → second page loads.
		await page.getByRole('button', { name: 'Retry' }).click();
		await expect.element(page.getByText('Beta Puzzle')).toBeVisible();
	});

	it('shows an error when saving the display name fails', async () => {
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
		vi.mocked(updatePlayerProfile).mockRejectedValueOnce(new Error('Network error'));

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();

		await page.getByText('Edit profile').click();
		await page.getByTestId('display-name-input').fill('New Name');
		await page.getByText('Save').click();

		await expect.element(page.getByTestId('save-name-error')).toBeVisible();
	});

	it('shows an error when avatar upload fails', async () => {
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
		vi.mocked(uploadPlayerAvatar).mockRejectedValueOnce(new Error('Upload failed'));

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();

		const fileInput = (await page.getByTestId('avatar-input').element()) as HTMLInputElement;
		const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
			type: 'image/png'
		});
		Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
		fileInput.dispatchEvent(new Event('change', { bubbles: true }));

		await expect.element(page.getByTestId('avatar-upload-error')).toBeVisible();
	});

	it('renders the avatar image when profile has a picture URL', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: 'https://example.com/avatar.jpg',
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [] });

		render(ProfilePage);
		await expect.element(page.getByText('Player One')).toBeVisible();
		// The img element with the picture URL should be rendered (not the initials fallback)
		const img = page.getByRole('img');
		await expect.element(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
	});

	it('renders empty-state messages when no puzzles or stats exist', async () => {
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
		vi.mocked(getPlayerStats).mockResolvedValue({ stats: [] });

		render(ProfilePage);
		await expect.element(page.getByText("You haven't uploaded any puzzles yet.")).toBeVisible();
		await expect.element(page.getByText('No solves recorded yet.')).toBeVisible();
	});

	it('shows the loading-more spinner while fetching the next page', async () => {
		// Delay the second page response so the spinner is visible during fetch
		let resolveSecond: (v: {
			puzzles: PlayerPuzzleSummary[];
			nextCursor?: string;
		}) => void = () => {};
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
			.mockResolvedValueOnce({
				puzzles: [
					{ id: 'pz-a', name: 'Alpha Puzzle', pieceCount: 4, status: 'ready', createdAt: 1 }
				],
				nextCursor: '1|pz-a'
			})
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveSecond = resolve;
				})
			);
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByText('Alpha Puzzle')).toBeVisible();

		// Trigger the puzzles sentinel intersection to load the next page
		triggerIntersectionByTestid('profile-scroll-sentinel');

		// The spinner should be visible while the second page is pending
		await vi.waitFor(() => {
			const el = document.querySelector('[data-testid="profile-load-more-spinner"]');
			expect(el).not.toBeNull();
		});

		// Resolve the second page
		resolveSecond({
			puzzles: [{ id: 'pz-b', name: 'Beta Puzzle', pieceCount: 4, status: 'ready', createdAt: 0 }],
			nextCursor: undefined
		});

		await expect.element(page.getByText('Beta Puzzle')).toBeVisible();
	});

	it('appends a second page of stats when the stats sentinel intersects', async () => {
		const statsPage1: PlayerStatRow[] = [
			{
				puzzleId: 'pz-a',
				puzzleName: 'Alpha',
				bestTimeSeconds: 30,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			}
		];
		const statsPage2: PlayerStatRow[] = [
			{
				puzzleId: 'pz-b',
				puzzleName: 'Beta',
				bestTimeSeconds: 60,
				totalCompletions: 2,
				firstCompletedAt: 2,
				lastCompletedAt: 3
			}
		];
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 2, totalCompletions: 3 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats)
			.mockResolvedValueOnce({ stats: statsPage1, nextCursor: '30|pz-a' })
			.mockResolvedValueOnce({ stats: statsPage2, nextCursor: undefined });

		render(ProfilePage);
		await expect.element(page.getByText('Alpha')).toBeVisible();

		// Trigger the stats sentinel.
		triggerIntersectionByTestid('profile-stats-scroll-sentinel');

		await expect.element(page.getByText('Beta')).toBeVisible();
		expect(vi.mocked(getPlayerStats)).toHaveBeenCalledTimes(2);
	});

	it('shows a retry button when the stats next-page fetch fails', async () => {
		const statsPage1: PlayerStatRow[] = [
			{
				puzzleId: 'pz-a',
				puzzleName: 'Alpha',
				bestTimeSeconds: 30,
				totalCompletions: 1,
				firstCompletedAt: 1,
				lastCompletedAt: 1
			}
		];
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Player One',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 1, totalCompletions: 1 }
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats)
			.mockResolvedValueOnce({ stats: statsPage1, nextCursor: '30|pz-a' })
			.mockRejectedValueOnce(new Error('Network error'));

		render(ProfilePage);
		await expect.element(page.getByText('Alpha')).toBeVisible();

		triggerIntersectionByTestid('profile-stats-scroll-sentinel');
		await expect.element(page.getByTestId('profile-stats-load-more-error')).toBeVisible();
	});

	it('shows reset-to-Google-name button only when a display name override is active', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Custom Name',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 },
			googleName: 'Google Name',
			hasDisplayNameOverride: true
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByText('Custom Name')).toBeVisible();

		// Enter edit mode — reset button should appear.
		await page.getByText('Edit profile').click();
		await expect.element(page.getByTestId('reset-name-button')).toBeVisible();

		// Click reset — sends displayName: null and reloads.
		await page.getByTestId('reset-name-button').click();
		expect(vi.mocked(updatePlayerProfile)).toHaveBeenCalledWith({ displayName: null });
	});

	it('does not show reset-to-Google-name button when no override is active', async () => {
		vi.mocked(getPlayerProfile).mockResolvedValue({
			id: 'p1',
			email: 'e',
			name: 'Google Name',
			picture: null,
			createdAt: 1,
			lastLoginAt: 2,
			summary: { puzzlesUploaded: 0, puzzlesSolved: 0, totalCompletions: 0 },
			googleName: 'Google Name',
			hasDisplayNameOverride: false
		});
		vi.mocked(getPlayerPuzzles).mockResolvedValue({ puzzles: [], nextCursor: undefined });
		vi.mocked(getPlayerStats).mockResolvedValue({ stats });

		render(ProfilePage);
		await expect.element(page.getByText('Google Name')).toBeVisible();

		await page.getByText('Edit profile').click();
		expect(document.querySelector('[data-testid="reset-name-button"]')).toBeNull();
	});
});
