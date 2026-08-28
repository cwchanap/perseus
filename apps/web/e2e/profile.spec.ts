import { test, expect, type Page } from '@playwright/test';

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

const mockOwnedFamilies = {
	families: [
		{
			id: 'fam-1',
			name: 'Forest Puzzle',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 2
		},
		{
			id: 'fam-2',
			name: 'Ocean Puzzle',
			aspectRatio: '1:1',
			status: 'ready',
			createdAt: 1
		}
	],
	nextCursor: undefined
};

const mockProgression = {
	score: 0,
	rank: null,
	easyClears: 0,
	normalClears: 0,
	hardClears: 0,
	achievementsUnlocked: 0,
	achievementsTotal: 9,
	masteryEarned: 0
};

const mockStats = {
	stats: [
		{
			familyId: 'fam-1',
			familyName: 'Forest Puzzle',
			difficulty: 'easy',
			standardBestTimeSeconds: 42,
			rotationBestTimeSeconds: null,
			totalCompletions: 3,
			firstCompletedAt: 1,
			lastCompletedAt: 2
		}
	]
};

function familyDetail(id: string, name: string) {
	return {
		id,
		name,
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1,
		variants: {
			easy: { id: `${id}-e`, difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: `${id}-n`, difficulty: 'normal', pieceCount: 49, status: 'ready' },
			hard: { id: `${id}-h`, difficulty: 'hard', pieceCount: 100, status: 'ready' }
		}
	};
}

async function mockPlayerApi(page: Page) {
	await page.route('**/api/auth/session', (route) => route.fulfill({ json: mockSession }));
	await page.route('**/api/player/profile', (route) => route.fulfill({ json: mockProfile }));
	await page.route('**/api/player/progression', (route) =>
		route.fulfill({ json: mockProgression })
	);
	await page.route('**/api/player/puzzle-families**', (route) =>
		route.fulfill({ json: mockOwnedFamilies })
	);
	await page.route('**/api/puzzle-families/*', async (route) => {
		const id =
			route
				.request()
				.url()
				.match(/puzzle-families\/([^/?]+)/)?.[1] ?? 'fam-1';
		const name =
			mockOwnedFamilies.families.find((family) => family.id === id)?.name ?? `Family ${id}`;
		await route.fulfill({ json: familyDetail(id, name) });
	});
	await page.route('**/api/player/stats**', (route) => route.fulfill({ json: mockStats }));
}

test('profile page redirects anonymous users to login', async ({ page }) => {
	await page.route('**/api/auth/session', (route) =>
		route.fulfill({ json: { authenticated: false, user: null } })
	);
	await page.goto('/profile');
	await expect(page).toHaveURL(/\/login/);
});

test('authenticated profile shows identity, stats, puzzles, and best times', async ({ page }) => {
	await mockPlayerApi(page);
	await page.goto('/profile');

	await expect(page.getByTestId('profile-name')).toHaveText('Test Player');
	await expect(page.getByText('player@example.com')).toBeVisible();

	await expect(page.getByText('2').first()).toBeVisible();

	await expect(
		page.locator('[data-testid="puzzle-card"]').filter({ hasText: 'Forest Puzzle' })
	).toBeVisible();
	await expect(
		page.locator('[data-testid="puzzle-card"]').filter({ hasText: 'Ocean Puzzle' })
	).toBeVisible();

	await expect(page.getByText('3×')).toBeVisible();
	await expect(page.getByText('pz-1')).toHaveCount(0);
});

test('profile edit flow updates display name', async ({ page }) => {
	await mockPlayerApi(page);
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
	await expect(page.getByTestId('profile-name')).toHaveText('Test Player');

	await page.getByRole('button', { name: 'Edit profile' }).click();
	await page.getByTestId('display-name-input').fill('New Display Name');
	await page.getByRole('button', { name: 'Save' }).click();

	await expect(page.getByText('New Display Name')).toBeVisible();
});

test('avatar upload refetches the profile only — puzzles list is not re-requested', async ({
	page
}) => {
	const avatarUrl = '/api/player/p1/avatar';
	const initialFamilies = {
		families: [
			{
				id: 'fam-1',
				name: 'First Puzzle',
				aspectRatio: '1:1',
				status: 'ready',
				createdAt: 2
			}
		],
		nextCursor: undefined
	};

	let profileCallCount = 0;
	let familiesCallCount = 0;
	await page.route('**/api/auth/session', (route) => route.fulfill({ json: mockSession }));
	await page.route('**/api/player/profile', async (route) => {
		profileCallCount++;
		await route.fulfill({
			json: { ...mockProfile, picture: profileCallCount === 1 ? null : avatarUrl }
		});
	});
	await page.route('**/api/player/progression', (route) =>
		route.fulfill({ json: mockProgression })
	);
	await page.route('**/api/player/puzzle-families**', async (route) => {
		familiesCallCount++;
		await route.fulfill({ json: initialFamilies });
	});
	await page.route('**/api/puzzle-families/*', (route) =>
		route.fulfill({ json: familyDetail('fam-1', 'First Puzzle') })
	);
	await page.route('**/api/player/stats**', (route) => route.fulfill({ json: mockStats }));
	await page.route('**/api/player/avatar', (route) => route.fulfill({ json: { avatarUrl } }));

	await page.goto('/profile');
	await expect(page.getByText('First Puzzle')).toBeVisible();
	await expect(page.locator('img[alt="Test Player"]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Edit profile' }).click();
	const fileInput = page.getByTestId('avatar-input');
	await fileInput.setInputFiles({
		name: 'avatar.png',
		mimeType: 'image/png',
		buffer: Buffer.from([0x89, 0x50, 0x4e, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04])
	});

	await expect(page.locator('img[alt="Test Player"]')).toHaveAttribute(
		'src',
		/http:\/\/localhost:3999\/api\/player\/p1\/avatar\?v=\d+$/
	);
	expect(familiesCallCount).toBe(1);
	await expect(page.getByText('First Puzzle')).toBeVisible();
});
