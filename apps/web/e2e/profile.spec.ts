import { test, expect, type Page } from '@playwright/test';

// Mock player session/profile/puzzles/stats payloads for the profile page.
// NOTE: the session endpoint lives under /api/auth/session (the OAuth router),
// NOT /api/player/session — the playerAuth store calls getPlayerSession() which
// fetches /api/auth/session (see src/lib/services/api.ts). Mocking the wrong
// path here leaves the real request un-intercepted, so the store settles as
// anonymous and the page silently redirects to /login — passing the
// "redirects anonymous" test for the wrong reason and breaking authed tests.
// The e2e harness runs against the real Bun API, but player auth requires a
// Google OAuth round-trip we can't perform in CI. Intercepting the API calls
// at the Playwright layer lets us exercise the full profile UI (identity card,
// summary tiles, My Puzzles grid, Best Times list) without seeding a session.

const mockSession = {
	authenticated: true,
	user: {
		id: 'p1',
		email: 'player@example.com',
		name: 'Test Player',
		picture: null,
		createdAt: 1,
		lastLoginAt: 2
	}
};

const mockProfile = {
	id: 'p1',
	email: 'player@example.com',
	name: 'Test Player',
	picture: null,
	createdAt: 1,
	lastLoginAt: 2,
	summary: { puzzlesUploaded: 2, puzzlesSolved: 1, totalCompletions: 3 }
};

const mockPuzzles = {
	puzzles: [
		{ id: 'pz-1', name: 'Forest Puzzle', pieceCount: 4, status: 'ready', createdAt: 2 },
		{ id: 'pz-2', name: 'Ocean Puzzle', pieceCount: 9, status: 'ready', createdAt: 1 }
	],
	nextCursor: undefined
};

const mockStats = {
	stats: [
		{
			puzzleId: 'pz-1',
			puzzleName: 'Forest Puzzle',
			bestTimeSeconds: 42,
			totalCompletions: 3,
			firstCompletedAt: 1,
			lastCompletedAt: 2
		}
	]
};

async function mockPlayerApi(page: Page) {
	await page.route('**/api/auth/session', (route) => route.fulfill({ json: mockSession }));
	await page.route('**/api/player/profile', (route) => route.fulfill({ json: mockProfile }));
	await page.route('**/api/player/puzzles**', (route) => route.fulfill({ json: mockPuzzles }));
	await page.route('**/api/player/stats**', (route) => route.fulfill({ json: mockStats }));
}

test('profile page redirects anonymous users to login', async ({ page }) => {
	// No session mock → the playerAuth store settles as anonymous → the layout
	// guard redirects to /login.
	await page.route('**/api/auth/session', (route) =>
		route.fulfill({ json: { authenticated: false, user: null } })
	);
	await page.goto('/profile');
	await expect(page).toHaveURL(/\/login/);
});

test('authenticated profile shows identity, stats, puzzles, and best times', async ({ page }) => {
	await mockPlayerApi(page);
	await page.goto('/profile');

	// Identity card.
	await expect(page.getByText('Test Player')).toBeVisible();
	await expect(page.getByText('player@example.com')).toBeVisible();

	// Summary tiles.
	await expect(page.getByText('2').first()).toBeVisible();

	// My Puzzles grid shows puzzle names.
	await expect(page.getByText('Forest Puzzle')).toBeVisible();
	await expect(page.getByText('Ocean Puzzle')).toBeVisible();

	// Best Times shows the puzzle name (not id) and completions count.
	await expect(page.getByText('3×')).toBeVisible();
	// The puzzle id must not appear as the link text.
	await expect(page.getByText('pz-1')).toHaveCount(0);
});

test('profile edit flow updates display name', async ({ page }) => {
	await mockPlayerApi(page);
	// Intercept PATCH to return success and then the updated profile on GET.
	let updatedName = 'Test Player';
	await page.route('**/api/player/profile', async (route) => {
		if (route.request().method() === 'PATCH') {
			const body = route.request().postDataJSON() as { displayName?: string };
			updatedName = body.displayName ?? updatedName;
			await route.fulfill({ json: { ok: true } });
			return;
		}
		await route.fulfill({
			json: { ...mockProfile, name: updatedName }
		});
	});

	await page.goto('/profile');
	await expect(page.getByText('Test Player')).toBeVisible();

	await page.getByRole('button', { name: 'Edit profile' }).click();
	await page.getByTestId('display-name-input').fill('New Display Name');
	await page.getByRole('button', { name: 'Save' }).click();

	// After save + reload, the new name renders.
	await expect(page.getByText('New Display Name')).toBeVisible();
});

test('reload after avatar upload picks up a newly owned puzzle from the puzzles endpoint', async ({
	page
}) => {
	// This test verifies that loadAll (triggered by avatar upload) re-fetches
	// /api/player/puzzles and reflects a newly owned puzzle in the "My
	// Puzzles" list. The ownership/upload flow itself is mocked at the API
	// boundary — the puzzles endpoint returns the new puzzle on the second
	// call (after the avatar upload triggers loadAll).
	const initialPuzzles = {
		puzzles: [{ id: 'pz-1', name: 'First Puzzle', pieceCount: 4, status: 'ready', createdAt: 2 }],
		nextCursor: undefined
	};
	const afterUploadPuzzles = {
		puzzles: [
			{ id: 'pz-1', name: 'First Puzzle', pieceCount: 4, status: 'ready', createdAt: 2 },
			{ id: 'pz-new', name: 'Just Uploaded', pieceCount: 16, status: 'processing', createdAt: 3 }
		],
		nextCursor: undefined
	};

	let puzzlesCallCount = 0;
	await page.route('**/api/auth/session', (route) => route.fulfill({ json: mockSession }));
	await page.route('**/api/player/profile', (route) => route.fulfill({ json: mockProfile }));
	await page.route('**/api/player/puzzles**', async (route) => {
		puzzlesCallCount++;
		// First load returns initial; subsequent loads (after avatar upload
		// triggers loadAll) include the newly owned puzzle.
		await route.fulfill({
			json: puzzlesCallCount === 1 ? initialPuzzles : afterUploadPuzzles
		});
	});
	await page.route('**/api/player/stats**', (route) => route.fulfill({ json: mockStats }));
	// Mock avatar upload success.
	await page.route('**/api/player/avatar', (route) =>
		route.fulfill({ json: { avatarUrl: '/api/player/p1/avatar' } })
	);

	await page.goto('/profile');
	await expect(page.getByText('First Puzzle')).toBeVisible();
	// The new puzzle is not yet visible.
	await expect(page.getByText('Just Uploaded')).toHaveCount(0);

	// Trigger a reload by uploading an avatar (which calls loadAll).
	const fileInput = page.getByTestId('avatar-input');
	await fileInput.setInputFiles({
		name: 'avatar.png',
		mimeType: 'image/png',
		buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04])
	});

	// After the reload, the newly owned puzzle (status: processing) appears.
	await expect(page.getByText('Just Uploaded')).toBeVisible();
});
