import type { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/test';
import { assertPageAccessible } from './support/accessibility';
import type { PuzzleFamilySummary } from '@perseus/types';
import {
	buildGameplayConfig,
	getFixture,
	type GameplayFixtureId
} from './gameplay-fixtures/catalog';
import { createFixtureRouter } from './gameplay-fixtures/fixture-router';
import { createImageHoldController } from './gameplay-fixtures/image-hold';
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

const GALLERY_THUMBNAIL_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
	'<rect width="64" height="64" fill="#385" /></svg>';

/** Serve a decodable SVG for one family thumbnail (the plain success route). */
async function mockFamilyThumbnail(page: Page, familyId: string) {
	await page.route(new RegExp(`/api/puzzle-families/${familyId}/thumbnail(?:\\?.*)?$`), (route) =>
		route.fulfill({ contentType: 'image/svg+xml', body: GALLERY_THUMBNAIL_SVG })
	);
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

test.describe('Bookmarks', () => {
	test('gallery bookmark round-trip: bookmark, /bookmarks, reload rehydrate, a11y, unbookmark', async ({
		page
	}) => {
		// UUID ids everywhere: the bookmark GET response passes the client-side
		// contract guard (isPuzzleFamilySummary), which requires UUID-shaped ids.
		const family = makeFamily('00000000-0000-4000-8000-000000000c01', {
			name: 'Bookmark Fixture',
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
		await page.route(/\/api\/auth\/session(?:\?.*)?$/, (route) =>
			route.fulfill({
				json: {
					authenticated: true,
					user: {
						id: 'e2e-bookmark-player',
						email: 'e2e-bookmarks@example.test',
						name: 'E2E Bookmark Player',
						createdAt: 1710000000000,
						lastLoginAt: 1710000001000
					}
				}
			})
		);
		await page.route(/\/api\/player\/progression(?:\?.*)?$/, (route) =>
			route.fulfill({
				json: {
					score: 0,
					rank: 0,
					easyClears: 0,
					normalClears: 0,
					hardClears: 0,
					achievementsUnlocked: 0,
					achievementsTotal: 9,
					masteryEarned: 0
				}
			})
		);

		// In-memory bookmark collection shared by GET/PUT/DELETE for the test
		// lifetime; mirrors the API contract without touching D1.
		const bookmarkedFamilies = new Map<string, PuzzleFamilySummary>();
		await page.route(/\/api\/player\/bookmarks$/, async (route) =>
			route.fulfill({ json: { families: [...bookmarkedFamilies.values()] } })
		);
		await page.route(/\/api\/player\/bookmarks\/[^/]+$/, async (route) => {
			const requestUrl = new URL(route.request().url());
			const familyId = decodeURIComponent(requestUrl.pathname.split('/').pop()!);
			const method = route.request().method();
			if (method !== 'PUT' && method !== 'DELETE') {
				await route.fulfill({ status: 405, json: { error: 'method_not_allowed' } });
				return;
			}
			if (method === 'PUT') {
				bookmarkedFamilies.set(familyId, family);
			} else {
				bookmarkedFamilies.delete(familyId);
			}
			await route.fulfill({ json: { ok: true } });
		});

		// Bookmark the family from the gallery card.
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();
		const card = page.getByTestId('puzzle-card');
		await expect(card).toHaveCount(1);
		const bookmarkButton = card.getByTestId('card-bookmark');
		await bookmarkButton.click();
		await expect(bookmarkButton).toHaveAttribute('aria-pressed', 'true');

		// Navigate to /bookmarks via the shell sidebar; the family appears.
		await page.getByTestId('sidebar-bookmarks-link').click();
		await expect(page).toHaveURL(/\/bookmarks$/);
		await expect(page.getByTestId('bookmarks-grid').getByTestId('puzzle-card')).toHaveCount(1);
		await expect(page.getByTestId('puzzle-card-title')).toHaveText(family.name);

		// Reload; the mocked GET rehydrates the bookmark.
		await page.reload();
		await expect(page.getByTestId('bookmarks-grid').getByTestId('puzzle-card')).toHaveCount(1);
		await expect(page.getByTestId('puzzle-card-title')).toHaveText(family.name);

		// The populated bookmarks page and shell nav pass the axe scan.
		await assertPageAccessible(page, { label: 'bookmarks' });

		// Unbookmark from the bookmarks page; the family disappears.
		await page.getByTestId('card-bookmark').click();
		await expect(page.getByTestId('bookmarks-empty')).toBeVisible();
		await expect(page.getByTestId('puzzle-card')).toHaveCount(0);
	});
});

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

		const easyLink = page
			.locator('[data-testid="difficulty-action"][data-difficulty="easy"]')
			.first();
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

		const easy = page.locator('[data-testid="difficulty-action"][data-difficulty="easy"]');
		const normal = page.locator('[data-testid="difficulty-action"][data-difficulty="normal"]');
		const hard = page.locator('[data-testid="difficulty-action"][data-difficulty="hard"]');

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

		const easyRow = page.locator('[data-testid="difficulty-action"][data-difficulty="easy"]');
		const normalRow = page.locator('[data-testid="difficulty-action"][data-difficulty="normal"]');
		await expect(easyRow.getByTestId('difficulty-progress')).toHaveText('1/16');
		await expect(easyRow).toHaveAttribute(
			'aria-label',
			'Easy difficulty, 16 pieces, continue saved progress 1/16'
		);
		await expect(normalRow.getByTestId('difficulty-progress')).toHaveCount(0);
		await expect(normalRow).toHaveAttribute('aria-label', 'Normal difficulty, 49 pieces');
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
		const easyRow = page.locator('[data-testid="difficulty-action"][data-difficulty="easy"]');
		await expect(easyRow.getByTestId('difficulty-progress')).toHaveCount(0);
		await expect(easyRow).toHaveAttribute('aria-label', 'Easy difficulty, 16 pieces');

		await seedApiVariantProgress(page, variantId, '1:1', 16);
		await page.reload();
		await expect(easyRow.getByTestId('difficulty-progress')).toHaveText('1/16');
		await expect(easyRow).toHaveAttribute(
			'aria-label',
			'Easy difficulty, 16 pieces, continue saved progress 1/16'
		);
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

		await page
			.getByTestId('continue-on-device')
			.getByRole('link', { name: 'Resume test-image' })
			.click();
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
		const easyRow = page.locator('[data-testid="difficulty-action"][data-difficulty="easy"]');
		await expect(easyRow.getByTestId('difficulty-progress')).toHaveText('1/16');
		await expect(easyRow).toHaveAttribute(
			'aria-label',
			'Easy difficulty, 16 pieces, continue saved progress 1/16'
		);

		await page
			.getByTestId('continue-on-device')
			.getByRole('link', { name: 'Resume Resume Fixture (Easy)' })
			.click();
		await expect(page).toHaveURL(new RegExp(`/puzzle/${newestVariant}`));
	});

	test('opens saved progress and resumes an older off-page save', async ({ gameplayPage }) => {
		const page = gameplayPage.page;
		const newestId = STANDARD_EASY_VARIANT;
		const olderId = 'e2e2b000-0000-4000-8000-000000000012';
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
		await page.getByTestId('continue-secondary-toggle').click();
		await page
			.getByTestId('continue-on-device')
			.getByRole('button', { name: 'View saved progress' })
			.click();

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
		const offPageId = 'e2e2b000-0000-4000-8000-000000000012';
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

	test('deep links restore filters, and typing keeps URL and focus in sync', async ({ page }) => {
		const family = makeFamily('fam-url-deep-link');
		const requestSearches: string[] = [];
		await page.route(/\/api\/puzzle-families(?:\?.*)?$/, async (route) => {
			const url = new URL(route.request().url());
			requestSearches.push(url.search);
			if (url.searchParams.get('q') === 'ghost') {
				await route.fulfill({ json: pagedFamilyResponse([]) });
				return;
			}
			await route.fulfill({ json: pagedFamilyResponse([family]) });
		});

		// Deep link: the first fetch reads the committed URL filters and the
		// text input hydrates from the URL.
		await page.goto('/?q=parrot&category=Animals');
		await expect(page.getByTestId('loading-state')).toBeHidden();
		await expect(page.getByTestId('search-input')).toHaveValue('parrot');
		expect(requestSearches[0]).toContain('q=parrot');
		expect(requestSearches[0]).toContain('category=Animals');

		// Debounced typing commits to the URL without stealing focus
		// (goto with reset: false).
		const searchInput = page.getByTestId('search-input');
		await searchInput.fill('ghost');
		await expect(page).toHaveURL(/\?q=ghost/);
		await expect(page.getByTestId('no-results-state')).toBeVisible();
		await expect(searchInput).toBeFocused();

		// A category pick adds a history entry; Back restores the committed
		// query and the input follows.
		await page.locator('label', { has: page.getByRole('radio', { name: 'Nature' }) }).click();
		await expect(page).toHaveURL(/q=ghost&category=Nature/);
		await page.goBack();
		await expect(page).toHaveURL(/\?q=ghost&category=Animals$/);
		await expect(searchInput).toHaveValue('ghost');
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

test.describe('Gallery artwork status (HPA-1029)', () => {
	// The Gallery family thumbnail is NOT under the gameplay fixture namespace,
	// so gameplayPage.assertSettled() is a no-op here. The Gallery tests own
	// their hold cleanup: every test disposes its routes in finally, and the
	// afterEach guard asserts no image hold was left pending (belt and
	// suspenders — dispose() unroutes, assertClean() reports a forgotten
	// release even after a route is gone).
	let activeHolds: ImageHoldController | null = null;

	test.afterEach(() => {
		activeHolds?.assertClean();
		activeHolds = null;
	});

	const FAMILY_A = '00000000-0000-4000-8000-000000000c02';
	const FAMILY_B = '00000000-0000-4000-8000-000000000c03';
	const CONTINUE_FAMILY = '00000000-0000-4000-8000-000000000d01';
	const CONTINUE_EASY_VARIANT = '00000000-0000-4000-8000-000000000d11';
	const CONTINUE_B_FAMILY = '00000000-0000-4000-8000-000000000d02';
	const CONTINUE_B_EASY_VARIANT = '00000000-0000-4000-8000-000000000d21';

	function thumbnailPattern(familyId: string): RegExp {
		return new RegExp(`/api/puzzle-families/${familyId}/thumbnail(?:\\?.*)?$`);
	}

	async function decodedWidth(img: ReturnType<Page['locator']>): Promise<number> {
		return img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
	}

	test('held card thumbnail shows Loading…, then loads decoded after release', async ({ page }) => {
		const family = makeFamily(FAMILY_A, { name: 'Hold Thumbnail' });
		await mockFamilyList(page, [family]);
		const images = createImageHoldController();
		activeHolds = images;
		try {
			const handle = await images.installImageUrl(page, thumbnailPattern(FAMILY_A));

			await page.goto('/');
			const card = page.getByTestId('puzzle-card');
			await expect(card).toHaveCount(1);
			const cardImg = card.locator('img');
			const placeholder = card.getByTestId('puzzle-card-art-placeholder');

			// Held request: the card shows the pending placeholder and the <img>
			// reports pending with no decoded pixels.
			await expect.poll(() => handle.pendingCount).toBe(1);
			await expect(placeholder).toBeVisible();
			await expect(placeholder).toContainText('Loading…');
			await expect(cardImg).toHaveAttribute('data-image-state', 'pending');
			expect(await decodedWidth(cardImg)).toBe(0);

			await handle.release();

			await expect(cardImg).toHaveAttribute('data-image-state', 'loaded');
			await expect.poll(() => decodedWidth(cardImg)).toBeGreaterThan(0);
			await expect(placeholder).toHaveCount(0);
		} finally {
			await images.dispose();
		}
	});

	test('failed card thumbnail shows an explicit No preview state, asserts the exact 404, and still navigates', async ({
		page
	}) => {
		const family = makeFamily(FAMILY_A, { name: 'Failed Thumbnail' });
		await mockFamilyList(page, [family]);
		await mockPuzzleDetail(page, { id: family.variants.easy.id });
		const images = createImageHoldController();
		activeHolds = images;
		try {
			await images.installImageUrl(page, thumbnailPattern(FAMILY_A), { failStatus: 404 });

			// Assert the exact intentional negative: the thumbnail route really
			// answered 404 (not, say, a network error or a silent no-response).
			const thumbnail404 = page.waitForResponse(
				(response) => thumbnailPattern(FAMILY_A).test(response.url()) && response.status() === 404
			);

			await page.goto('/');
			const card = page.getByTestId('puzzle-card');
			await expect(card).toHaveCount(1);
			const cardImg = card.locator('img');
			const placeholder = card.getByTestId('puzzle-card-art-placeholder');

			expect((await thumbnail404).status()).toBe(404);
			await expect(placeholder).toBeVisible();
			await expect(placeholder).toContainText('No preview');
			await expect(cardImg).toHaveAttribute('data-image-state', 'error');
			expect(await decodedWidth(cardImg)).toBe(0);

			// A failed preview is presentation-only: card navigation still works.
			const easyLink = page
				.locator('[data-testid="difficulty-action"][data-difficulty="easy"]')
				.first();
			await expect(easyLink).toBeVisible();
			await easyLink.click();
			await expect(page).toHaveURL(new RegExp(`/puzzle/${family.variants.easy.id}`));
		} finally {
			await images.dispose();
		}
	});

	test('changed card thumbnail URL recovers from a prior failure without a reload', async ({
		page
	}) => {
		const familyA = makeFamily(FAMILY_A, { name: 'Changed Thumbnail A' });
		const familyB = makeFamily(FAMILY_B, { name: 'Changed Thumbnail B' });
		await mockFamilyList(page, [familyA]);
		await mockFamilyThumbnail(page, FAMILY_B);
		const images = createImageHoldController();
		activeHolds = images;
		try {
			await images.installImageUrl(page, thumbnailPattern(FAMILY_A), { failStatus: 404 });

			await page.goto('/');
			const card = page.getByTestId('puzzle-card');
			await expect(card).toHaveCount(1);
			await expect(card.getByTestId('puzzle-card-art-placeholder')).toContainText('No preview');

			// A full reload would reset this marker; recovery must keep it set.
			await page.evaluate(() => {
				(window as unknown as { __galleryNoReload?: boolean }).__galleryNoReload = true;
			});

			// The catalog changes: the family list now returns family B. Leave
			// through family A's card (the fake variant id shows the mission
			// error panel) and return via its RETURN TO ARCADE link — SPA
			// navigation, so the gallery load re-runs without a full reload and
			// the keyed card list mounts family B's card with its (working) URL.
			await mockFamilyList(page, [familyB]);
			const easyLink = page
				.locator('[data-testid="difficulty-action"][data-difficulty="easy"]')
				.first();
			await easyLink.click();
			await expect(page).toHaveURL(new RegExp(`/puzzle/${familyA.variants.easy.id}`));
			await page.getByRole('link', { name: 'RETURN TO ARCADE' }).click();

			await expect(page).toHaveURL(/\/$/);
			await expect(page.getByTestId('puzzle-card')).toHaveCount(1);
			await expect(page.getByTestId('puzzle-card-title')).toHaveText('Changed Thumbnail B');
			const cardImg = page.getByTestId('puzzle-card').locator('img');
			await expect(cardImg).toHaveAttribute('data-image-state', 'loaded');
			await expect.poll(() => decodedWidth(cardImg)).toBeGreaterThan(0);
			await expect(page.getByTestId('puzzle-card-art-placeholder')).toHaveCount(0);

			expect(
				await page.evaluate(
					() => (window as unknown as { __galleryNoReload?: boolean }).__galleryNoReload
				)
			).toBe(true);
		} finally {
			await images.dispose();
		}
	});

	test('continue-on-device art stays silent while held, then loads decoded after release', async ({
		page
	}) => {
		const family = makeFamily(CONTINUE_FAMILY, {
			name: 'Continue Art',
			variants: {
				easy: {
					id: CONTINUE_EASY_VARIANT,
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: '00000000-0000-4000-8000-000000000d12',
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: '00000000-0000-4000-8000-000000000d13',
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});
		await mockFamilyList(page, [family]);
		const images = createImageHoldController();
		activeHolds = images;
		try {
			const handle = await images.installImageUrl(page, thumbnailPattern(CONTINUE_FAMILY));

			await page.goto('/');
			// Seeded progress surfaces the continue panel; the reload re-runs the
			// load against the same mocks (routes live on the page across reloads).
			await seedApiVariantProgress(page, CONTINUE_EASY_VARIANT, '1:1', 16);
			await page.reload();

			const panel = page.getByTestId('continue-on-device');
			await expect(panel).toBeVisible();
			// Decorative art: held silently behind the text overlay — the panel
			// content itself stays fully visible.
			const continueArt = panel.locator('img.continue-art');
			await expect.poll(() => handle.pendingCount).toBe(1);
			await expect(continueArt).toHaveAttribute('data-image-state', 'pending');
			await expect(panel.locator('#continue-on-device-title')).toBeVisible();

			await handle.release();

			await expect(continueArt).toHaveAttribute('data-image-state', 'loaded');
			await expect.poll(() => decodedWidth(continueArt)).toBeGreaterThan(0);
			await expect(panel.locator('#continue-on-device-title')).toBeVisible();
		} finally {
			await images.dispose();
		}
	});

	test('changed continue-on-device art URL recovers from a prior failure without a reload', async ({
		page
	}) => {
		const familyA = makeFamily(CONTINUE_FAMILY, {
			name: 'Continue Fail A',
			variants: {
				easy: {
					id: CONTINUE_EASY_VARIANT,
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: '00000000-0000-4000-8000-000000000d12',
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: '00000000-0000-4000-8000-000000000d13',
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});
		const familyB = makeFamily(CONTINUE_B_FAMILY, {
			name: 'Continue Ok B',
			variants: {
				easy: {
					id: CONTINUE_B_EASY_VARIANT,
					difficulty: 'easy',
					pieceCount: 16,
					status: 'ready'
				},
				normal: {
					id: '00000000-0000-4000-8000-000000000d22',
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: '00000000-0000-4000-8000-000000000d23',
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});
		await mockFamilyList(page, [familyA, familyB]);
		const images = createImageHoldController();
		activeHolds = images;
		try {
			await images.installImageUrl(page, thumbnailPattern(CONTINUE_FAMILY), { failStatus: 404 });
			await mockFamilyThumbnail(page, CONTINUE_B_FAMILY);

			await page.goto('/');
			// Two saved sessions: family A is newest (its thumbnail 404s), family
			// B is the next-newest with a working thumbnail.
			await seedApiVariantProgress(page, CONTINUE_EASY_VARIANT, '1:1', 16, {
				lastUpdated: 3_000
			});
			await seedApiVariantProgress(page, CONTINUE_B_EASY_VARIANT, '1:1', 16, {
				lastUpdated: 2_000
			});
			await page.reload();

			const panel = page.getByTestId('continue-on-device');
			const continueArt = panel.locator('img.continue-art');
			await expect(panel).toContainText('Continue Fail A');
			// The failed decorative art stays silent (no caption) but the <img>
			// reports the failure with no decoded pixels.
			await expect(continueArt).toHaveAttribute('data-image-state', 'error');
			expect(await decodedWidth(continueArt)).toBe(0);

			// A full reload would reset this marker; the recovery must keep it.
			await page.evaluate(() => {
				(window as unknown as { __galleryNoReload?: boolean }).__galleryNoReload = true;
			});

			// Discarding the newest save promotes family B: resumeImageUrl swaps
			// to B's working URL on the SAME <img> element — the src-change
			// recovery path — with no full page reload.
			await page.getByTestId('continue-secondary-toggle').click();
			await page.getByRole('button', { name: 'Discard saved progress' }).click();
			await page
				.getByRole('dialog', { name: 'Discard saved progress' })
				.getByRole('button', { name: 'Discard' })
				.click();

			await expect(panel).toContainText('Continue Ok B');
			await expect(continueArt).toHaveAttribute('data-image-state', 'loaded');
			await expect.poll(() => decodedWidth(continueArt)).toBeGreaterThan(0);
			expect(
				await page.evaluate(
					() => (window as unknown as { __galleryNoReload?: boolean }).__galleryNoReload
				)
			).toBe(true);
		} finally {
			await images.dispose();
		}
	});
});
