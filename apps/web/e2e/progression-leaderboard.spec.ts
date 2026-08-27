// Progression + leaderboard E2E against the deterministic gameplay harness.
// Uses mocked auth, completion awards, family/overall leaderboards, and profile
// progression endpoints — no live D1 or wrangler dependency.
import { test, expect } from './support/test';
import { AUTHENTICATED_PLAYER } from './gameplay-fixtures/auth-persona';
import { getFixture } from './gameplay-fixtures/catalog';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const FIXTURE_ID = 'e2e-square-4' as const;
const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };

const PROGRESSION_AWARDS = {
	clearPoints: 100,
	achievements: ['first_clear', 'getting_started'],
	mastery: ['hintless'],
	puzzleRank: 5
};

async function mockProgressionApis(
	page: import('@playwright/test').Page,
	familyId: string,
	familyName: string
) {
	await page.route(`**/api/puzzle-families/${familyId}/leaderboard**`, (route) =>
		route.fulfill({
			json: {
				entries: [
					{
						rank: 1,
						player: { id: 'rival-1', name: 'Rival Player', avatarUrl: null },
						bestTimeSeconds: 30,
						achievedAt: 1
					}
				],
				me: {
					rank: 5,
					player: {
						id: AUTHENTICATED_PLAYER.id,
						name: AUTHENTICATED_PLAYER.name ?? 'E2E Player',
						avatarUrl: null
					},
					bestTimeSeconds: 42,
					achievedAt: 2
				}
			}
		})
	);

	await page.route('**/api/leaderboard', (route) =>
		route.fulfill({
			json: {
				entries: [
					{
						rank: 1,
						player: { id: 'top-1', name: 'Top Scorer', avatarUrl: null },
						score: 500,
						easyClears: 5,
						normalClears: 0,
						hardClears: 0
					}
				],
				me: {
					rank: 3,
					player: {
						id: AUTHENTICATED_PLAYER.id,
						name: AUTHENTICATED_PLAYER.name ?? 'E2E Player',
						avatarUrl: null
					},
					score: 142,
					easyClears: 1,
					normalClears: 0,
					hardClears: 0
				}
			}
		})
	);

	await page.route('**/api/player/progression', (route) =>
		route.fulfill({
			json: {
				score: 142,
				rank: 3,
				easyClears: 1,
				normalClears: 0,
				hardClears: 0,
				achievementsUnlocked: 2,
				achievementsTotal: 10,
				masteryEarned: 1
			}
		})
	);

	await page.route('**/api/player/profile', (route) =>
		route.fulfill({
			json: {
				id: AUTHENTICATED_PLAYER.id,
				email: AUTHENTICATED_PLAYER.email,
				name: AUTHENTICATED_PLAYER.name,
				picture: null,
				createdAt: 1,
				lastLoginAt: 2,
				summary: { puzzlesUploaded: 0, puzzlesSolved: 1, totalCompletions: 1 }
			}
		})
	);

	await page.route('**/api/player/puzzle-families**', (route) =>
		route.fulfill({ json: { families: [], nextCursor: undefined } })
	);

	await page.route('**/api/player/stats**', (route) =>
		route.fulfill({
			json: {
				stats: [
					{
						familyId,
						familyName,
						difficulty: 'easy',
						standardBestTimeSeconds: 42,
						rotationBestTimeSeconds: null,
						totalCompletions: 1,
						firstCompletedAt: 1,
						lastCompletedAt: 2
					}
				]
			}
		})
	);
}

test.describe('Progression and leaderboards @smoke', () => {
	test('authenticated Easy complete surfaces awards, leaderboards, and profile progression', async ({
		gameplayPage
	}) => {
		const page = gameplayPage.page;
		const fixture = getFixture(FIXTURE_ID);
		await mockProgressionApis(page, fixture.familyId, fixture.name);

		await gameplayPage.gotoFixture({
			persona: 'authenticated',
			completion: { kind: 'success', awards: PROGRESSION_AWARDS },
			seedPreferences: IMMEDIATE_START
		});

		await gameplayPage.solveFixture();

		await expect(gameplayPage.celebrationModal()).toBeVisible();
		await expect(page.getByTestId('completion-clear-points')).toHaveText('+100 SCORE');
		await expect(page.getByTestId('completion-achievements')).toContainText('First Clear');
		await expect(page.getByTestId('completion-achievements')).toContainText('Getting Started');
		await expect(page.getByTestId('completion-mastery')).toContainText('Hintless');
		await expect(page.getByTestId('completion-puzzle-rank')).toHaveText('FAMILY RANK #5');

		await page.keyboard.press('Escape');
		await expect(gameplayPage.celebrationModal()).toBeHidden();

		await page.getByTestId('open-family-leaderboard').click();
		await expect(page.getByTestId('family-leaderboard-modal')).toBeVisible();
		await expect(page.getByTestId('leaderboard-entries')).toContainText('Rival Player');
		await expect(page.getByTestId('leaderboard-me')).toContainText('#5');

		await page.goto('/leaderboard');
		await expect(page.getByTestId('leaderboard-link')).toBeVisible();
		await expect(page.getByTestId('overall-leaderboard-table')).toContainText('Top Scorer');
		await expect(page.getByTestId('overall-leaderboard-me')).toContainText('142');

		await page.goto('/profile');
		await expect(page.getByTestId('profile-progression-score')).toHaveText('142');
		await expect(page.getByTestId('profile-progression-rank')).toHaveText('3');
		await expect(page.getByTestId('profile-progression-achievements')).toContainText('2');
		await expect(page.getByTestId('profile-difficulty-easy')).toHaveText('1');
		await expect(page.getByTestId('best-times-list')).toContainText(fixture.name);
		await expect(page.getByTestId('best-times-list')).toContainText('easy');
	});

	test('replay same difficulty does not award additional clear points', async ({
		gameplayPage
	}) => {
		const page = gameplayPage.page;

		await gameplayPage.gotoFixture({
			persona: 'authenticated',
			completion: { kind: 'awarded-success-once', awards: PROGRESSION_AWARDS },
			seedPreferences: IMMEDIATE_START
		});

		await gameplayPage.solveFixture();
		await expect(page.getByTestId('completion-clear-points')).toHaveText('+100 SCORE');

		await gameplayPage.playAgainFromCelebration();
		await gameplayPage.startMission();
		await gameplayPage.solveFixture();

		await expect(gameplayPage.celebrationModal()).toBeVisible();
		await expect(page.getByTestId('completion-clear-points')).toHaveCount(0);
		await expect(page.getByTestId('completion-achievements')).toHaveCount(0);
		await expect(page.getByTestId('completion-mastery')).toHaveCount(0);
		await expect(page.getByTestId('completion-puzzle-rank')).toHaveCount(0);
	});
});
