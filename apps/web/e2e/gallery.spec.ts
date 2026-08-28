import type { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/test';
import type { PuzzleFamilySummary } from '@perseus/types';
import {
	buildGameplayConfig,
	getFixture,
	type GameplayFixtureId
} from './gameplay-fixtures/catalog';
import { createFixtureRouter } from './gameplay-fixtures/fixture-router';
import {
	buildMinimalSeed,
	createPersistedStateController,
	legacyProgressKey,
	progressKey,
	seedApiVariantProgress
} from './gameplay-fixtures/persisted-state';

const STANDARD_EASY_VARIANT = '00000000-0000-4000-8000-000000000e01';
const STANDARD_NORMAL_VARIANT = '00000000-0000-4000-8000-000000000e02';
const STANDARD_HARD_VARIANT = '00000000-0000-4000-8000-000000000e03';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUICK_FIXTURE = path.join(__dirname, 'fixtures', 'test-image.jpg');

const pagedFamilyResponse = (
	families: PuzzleFamilySummary[],
	overrides: { total?: number; offset?: number; limit?: number; nextCursor?: string } = {}
) => ({
	families,
	total: overrides.total ?? families.length,
	offset: overrides.offset ?? 0,
	limit: overrides.limit ?? 20,
	...(overrides.nextCursor ? { nextCursor: overrides.nextCursor } : {})
});

function makeFamily(id: string, overrides: Partial<PuzzleFamilySummary> = {}): PuzzleFamilySummary {
	return {
		id,
		name: `Family ${id}`,
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1000,
		variants: {
			easy: {
				id: `${id}-easy`,
				difficulty: 'easy',
				pieceCount: 16,
				status: 'ready'
			},
			normal: {
				id: `${id}-normal`,
				difficulty: 'normal',
				pieceCount: 49,
				status: 'ready'
			},
			hard: {
				id: `${id}-hard`,
				difficulty: 'hard',
				pieceCount: 100,
				status: 'ready'
			}
		},
		...overrides
	};
}

async function mockFamilyList(page: Page, families: PuzzleFamilySummary[]) {
	await page.route(/\/api\/puzzle-families(?:\?.*)?$/, (route) =>
		route.fulfill({ json: pagedFamilyResponse(families) })
	);
}

async function mockPuzzleDetail(page: Page, puzzle: { id: string }) {
	await page.route(`**/api/puzzles/${puzzle.id}`, (route) => route.fulfill({ json: puzzle }));
}

// Plant the frozen gameplay config global for a fixture so a navigation into
// /puzzle/<e2e-*> loads cleanly under the harness runtime reader. Registered
// as an init script so it runs before the puzzle page's app scripts; guarded
// so repeated navigations (the global persists across same-origin loads) do
// not attempt to redefine the non-configurable property.
async function plantGameplayConfig(page: Page, fixtureId: GameplayFixtureId): Promise<void> {
	const configJson = JSON.stringify(buildGameplayConfig(getFixture(fixtureId)));
	await page.addInitScript(
		(args: { configJson: string; configGlobal: string }) => {
			const w = window as unknown as Record<string, unknown>;
			if (w[args.configGlobal]) return;
			const deepFreeze = (value: unknown): void => {
				if (value === null || typeof value !== 'object') return;
				Object.freeze(value);
				if (Array.isArray(value)) {
					for (const item of value) deepFreeze(item);
				} else {
					for (const child of Object.values(value as Record<string, unknown>)) {
						deepFreeze(child);
					}
				}
			};
			const config = JSON.parse(args.configJson);
			deepFreeze(config);
			Object.defineProperty(w, args.configGlobal, {
				value: config,
				writable: false,
				configurable: false,
				enumerable: true
			});
		},
		{ configJson, configGlobal: '__PERSEUS_E2E_GAMEPLAY_V1__' }
	);
}

test.describe('Main Gallery Page', () => {
	test('should display the gallery page', async ({ page }) => {
		await mockFamilyList(page, []);
		await page.goto('/');
		await expect(page).toHaveTitle(/Perseus|Jigsaw/i);
	});

	test('should show empty state when no puzzles exist', async ({ page }) => {
		await mockFamilyList(page, []);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		await expect(page.getByTestId('error-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeHidden();
		await expect(page.getByTestId('empty-state')).toBeVisible();
	});

	test('should display puzzle cards when puzzles exist', async ({ page }) => {
		await mockFamilyList(page, [makeFamily('fam-display')]);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		await expect(page.getByTestId('error-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeVisible();
		await expect(page.getByTestId('empty-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-card')).toHaveCount(1);
	});

	test('should navigate to puzzle page when clicking a difficulty action', async ({ page }) => {
		const family = makeFamily('fam-nav');
		await mockFamilyList(page, [family]);
		await mockPuzzleDetail(page, { id: family.variants.easy.id });
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const easyLink = page.getByTestId('difficulty-action').filter({ hasText: 'Easy' }).first();
		await expect(easyLink).toBeVisible();
		await easyLink.click();
		await expect(page).toHaveURL(new RegExp(`/puzzle/${family.variants.easy.id}`));
	});

	test('family card exposes distinct difficulty variant ids and piece counts', async ({ page }) => {
		const family = makeFamily('00000000-0000-4000-8000-000000000f01', {
			name: 'Mountain Family',
			variants: {
				easy: {
					id: '00000000-0000-4000-8000-000000000e01',
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: '00000000-0000-4000-8000-000000000e02',
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: '00000000-0000-4000-8000-000000000e03',
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});
		await mockFamilyList(page, [family]);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const actions = page.getByTestId('difficulty-action');
		await expect(actions).toHaveCount(3);

		const easy = actions.filter({ hasText: 'Easy' });
		const normal = actions.filter({ hasText: 'Normal' });
		const hard = actions.filter({ hasText: 'Hard' });

		await expect(easy).toHaveAttribute('href', /00000000-0000-4000-8000-000000000e01/);
		await expect(normal).toHaveAttribute('href', /00000000-0000-4000-8000-000000000e02/);
		await expect(hard).toHaveAttribute('href', /00000000-0000-4000-8000-000000000e03/);

		await expect(easy).toContainText('16');
		await expect(normal).toContainText('49');
		await expect(hard).toContainText('100');
	});

	test('resume state belongs to the selected difficulty variant', async ({ page }) => {
		const family = makeFamily('fam-resume-difficulty', {
			name: 'Resume Difficulty Family',
			variants: {
				easy: {
					id: STANDARD_EASY_VARIANT,
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: STANDARD_NORMAL_VARIANT,
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: STANDARD_HARD_VARIANT,
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});

		await mockFamilyList(page, [family]);
		await page.goto('/');
		await seedApiVariantProgress(page, STANDARD_EASY_VARIANT, '1:1', 16);
		await page.reload();

		const easyRow = page.getByTestId('difficulty-action').filter({ hasText: 'Easy' });
		const normalRow = page.getByTestId('difficulty-action').filter({ hasText: 'Normal' });
		await expect(easyRow).toContainText('CONTINUE 1/16');
		await expect(normalRow).not.toContainText('CONTINUE');
		const stored = await page.evaluate(
			(key) => localStorage.getItem(key),
			progressKey(STANDARD_EASY_VARIANT)
		);
		expect(stored).not.toBeNull();
	});

	test('ignores legacy puzzle-progress keys without the v2 namespace', async ({ page }) => {
		const variantId = STANDARD_EASY_VARIANT;
		const family = makeFamily('fam-legacy-ignore', {
			variants: {
				easy: {
					id: variantId,
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: STANDARD_NORMAL_VARIANT,
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: STANDARD_HARD_VARIANT,
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});

		await mockFamilyList(page, [family]);
		await page.goto('/');
		await seedApiVariantProgress(page, variantId, '1:1', 16);
		const validJson = await page.evaluate(
			(key) => localStorage.getItem(key),
			progressKey(variantId)
		);
		await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
			key: legacyProgressKey(variantId),
			value: validJson!
		});
		await page.evaluate((key) => localStorage.removeItem(key), progressKey(variantId));
		await page.reload();

		await expect(page.getByTestId('continue-on-device')).toHaveCount(0);
		const easyRow = page.getByTestId('difficulty-action').filter({ hasText: 'Easy' });
		await expect(easyRow).not.toContainText('CONTINUE');

		await seedApiVariantProgress(page, variantId, '1:1', 16);
		await page.reload();
		await expect(easyRow).toContainText('CONTINUE 1/16');
	});

	test('quick puzzle resume still uses puzzle-progress-q keys', async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());

		await page.goto('/quick');
		await page.getByTestId('quick-uploader-file').setInputFiles(QUICK_FIXTURE);
		await page.getByTestId('quick-uploader-submit').click();
		await page.waitForURL(/\/puzzle\/q-/, { timeout: 10_000 });
		const quickId = page.url().match(/\/puzzle\/(q-[\w-]+)/)![1];

		const setup = page.getByRole('dialog', { name: 'Mission Setup' });
		if (await setup.isVisible()) {
			await setup.getByRole('button', { name: 'Start Mission' }).click();
		}
		await page.getByTestId('puzzle-piece').first().click();
		await page.locator('[data-testid="drop-zone"][data-x="0"][data-y="0"]').click();
		await expect
			.poll(() =>
				page.evaluate(() => {
					for (let i = 0; i < localStorage.length; i += 1) {
						const key = localStorage.key(i);
						if (key?.startsWith('puzzle-progress-q-')) return key;
					}
					return null;
				})
			)
			.not.toBeNull();

		await page.goto('/');
		await expect(page.getByTestId('continue-on-device')).toBeVisible();
		await expect(page.getByTestId('continue-on-device')).toContainText('test-image');

		const quickProgressKey = await page.evaluate(() => {
			for (let i = 0; i < localStorage.length; i += 1) {
				const key = localStorage.key(i);
				if (key?.startsWith('puzzle-progress-q-')) return key;
			}
			return null;
		});
		expect(quickProgressKey).toBe(`puzzle-progress-${quickId}`);

		await page.getByTestId('continue-on-device').getByRole('link', { name: 'CONTINUE' }).click();
		await expect(page).toHaveURL(new RegExp(`/puzzle/${quickId}`));
	});

	test('shows current-device progress and continues the newest session', async ({ page }) => {
		const newestVariant = STANDARD_EASY_VARIANT;
		const family = makeFamily('fam-continue', {
			name: 'Resume Fixture',
			variants: {
				easy: {
					id: newestVariant,
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: STANDARD_NORMAL_VARIANT,
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: STANDARD_HARD_VARIANT,
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});

		await mockFamilyList(page, [family]);
		await page.goto('/');
		await seedApiVariantProgress(page, newestVariant, '1:1', 16);
		await page.reload();

		await expect(page.getByTestId('continue-on-device')).toContainText('Resume Fixture');
		await expect(page.getByTestId('continue-on-device')).toContainText('1/16 PLACED');
		const easyRow = page.getByTestId('difficulty-action').filter({ hasText: 'Easy' });
		await expect(easyRow).toContainText('CONTINUE 1/16');

		await page.getByTestId('continue-on-device').getByRole('link', { name: 'CONTINUE' }).click();
		await expect(page).toHaveURL(new RegExp(`/puzzle/${newestVariant}`));
	});

	test('opens saved progress and resumes an older off-page save', async ({ gameplayPage }) => {
		const page = gameplayPage.page;
		const newestId = STANDARD_EASY_VARIANT;
		const olderId = 'e2e-landscape-12';
		const older = getFixture(olderId);
		const olderPiece = older.pieces[0]!;
		const storage = createPersistedStateController();

		const family = makeFamily('fam-saved-progress', {
			name: 'Newest Resume Fixture',
			variants: {
				easy: {
					id: newestId,
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: STANDARD_NORMAL_VARIANT,
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: STANDARD_HARD_VARIANT,
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});

		await mockFamilyList(page, [family]);
		await createFixtureRouter().install(page);
		await plantGameplayConfig(page, olderId);
		await page.goto('/');

		await seedApiVariantProgress(page, newestId, '1:1', 16, { lastUpdated: 3_000 });
		await storage.seedValid(page, olderId, {
			...buildMinimalSeed(olderId),
			placedPieces: [
				{
					pieceId: olderPiece.id,
					x: olderPiece.correctX,
					y: olderPiece.correctY
				}
			],
			timerStarted: true,
			hasUserActivity: true,
			lastUpdated: 2_000
		});
		await page.reload();

		await expect(page.getByTestId('continue-on-device')).toContainText('Newest Resume Fixture');
		await page.getByRole('button', { name: 'View saved progress' }).click();

		const dialog = page.getByRole('dialog', { name: 'Saved progress' });
		await expect(dialog.getByTestId(`saved-progress-row-${newestId}`)).toBeVisible();
		await expect(dialog.getByTestId(`saved-progress-row-${olderId}`)).toContainText(older.name);
		await dialog.getByRole('link', { name: `Continue ${older.name}` }).click();
		await expect(page).toHaveURL(new RegExp(`/puzzle/${olderId}$`));
		await expect(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
	});

	test('keeps VIEW SAVED PROGRESS after a transient off-page detail-fetch failure', async ({
		gameplayPage
	}) => {
		const page = gameplayPage.page;
		const offPageId = 'e2e-landscape-12';
		const fixture = getFixture(offPageId);
		const firstPiece = fixture.pieces[0]!;
		const storage = createPersistedStateController();

		await mockFamilyList(page, []);
		await page.route(`**/api/puzzles/${offPageId}`, (route) =>
			route.fulfill({ status: 500, json: { error: 'transient_failure' } })
		);

		await page.goto('/');

		await storage.seedValid(page, offPageId, {
			...buildMinimalSeed(offPageId),
			placedPieces: [
				{
					pieceId: firstPiece.id,
					x: firstPiece.correctX,
					y: firstPiece.correctY
				}
			],
			timerStarted: true,
			hasUserActivity: true,
			lastUpdated: 2_000
		});
		await page.reload();

		await expect(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
		await page.getByRole('button', { name: 'View saved progress' }).click();

		const dialog = page.getByRole('dialog', { name: 'Saved progress' });
		await expect(dialog.getByText('UNABLE TO LOAD SAVED PROGRESS — TRY AGAIN')).toBeVisible();
		await expect(dialog.getByText('NO SAVED PROGRESS')).toHaveCount(0);

		await page.getByRole('button', { name: 'Close saved progress' }).click();
		await expect(dialog).toHaveCount(0);

		await expect(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
	});

	test('should show no-results state when search returns empty', async ({ page }) => {
		const family = makeFamily('fam-search');
		await page.route(/\/api\/puzzle-families(?:\?.*)?$/, async (route) => {
			const url = route.request().url();
			if (url.includes('q=')) {
				await route.fulfill({ json: pagedFamilyResponse([]) });
			} else {
				await route.fulfill({ json: pagedFamilyResponse([family]) });
			}
		});

		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const searchInput = page.getByTestId('search-input');
		await searchInput.fill('xyznotfound');

		await expect(page.getByTestId('no-results-state')).toBeVisible();
	});

	test('should append more puzzles when scrolling to sentinel', async ({ page }) => {
		const firstPage: PuzzleFamilySummary[] = Array.from({ length: 20 }, (_, i) =>
			makeFamily(`fam-p${i}`, { name: `Puzzle ${i}` })
		);
		const secondPage: PuzzleFamilySummary[] = [makeFamily('fam-p20', { name: 'Puzzle 20' })];
		const cursorValue = 'cursor-page-2';

		let callCount = 0;
		await page.route(/\/api\/puzzle-families(?:\?.*)?$/, async (route) => {
			callCount++;
			const url = route.request().url();
			if (url.includes(`cursor=${cursorValue}`)) {
				await route.fulfill({
					json: pagedFamilyResponse(secondPage, { total: 21, offset: 20 })
				});
			} else {
				await route.fulfill({
					json: pagedFamilyResponse(firstPage, {
						total: 21,
						nextCursor: cursorValue
					})
				});
			}
		});

		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeVisible();

		await page.getByTestId('scroll-sentinel').scrollIntoViewIfNeeded();

		await expect(page.getByTestId('puzzle-card')).toHaveCount(21, { timeout: 2000 });
		await expect.poll(() => callCount).toBe(2);
	});
});
