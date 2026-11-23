import type { Page, Response } from '@playwright/test';
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
import {
	createFixtureRouter,
	FIXTURE_ROUTER_HEADER,
	FIXTURE_ROUTER_SOURCE
} from './gameplay-fixtures/fixture-router';
import {
	createImageHoldController,
	type ImageHoldController,
	type ImageHoldHandle
} from './gameplay-fixtures/image-hold';
import { createPageDiagnostics, type PageDiagnostics } from './support/diagnostics';
import { settleRequestAround } from './support/settle-request';
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
		// Once the next-page request has settled, neither request spinner persists.
		await expect(page.getByTestId('load-more-spinner')).toBeHidden();
		await expect(page.getByTestId('loading-state')).toBeHidden();
	});

	test('labeled category chips fit the real header with search open at 1440/1201 and stay compact at 390', async ({
		page
	}) => {
		const family = makeFamily('fam-header-fit');
		await mockFamilyList(page, [family]);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();
		const filter = page.getByTestId('category-filter');
		await expect(filter).toBeVisible();

		// The wide band (>= 75.0625rem) is the two-column header with an
		// always-open search. The component fit test pins a synthetic 50rem
		// wrapper around the fieldset; here the fieldset must fit the REAL
		// auto-sized categories column, unadjusted — scrollWidth <=
		// clientWidth with every chip inside the fieldset's box.
		for (const width of [1440, 1201]) {
			await page.setViewportSize({ width, height: 900 });
			await page.getByTestId('gallery-search-disclosure').evaluate((el) => {
				(el as HTMLDetailsElement).open = true;
			});
			await expect(page.getByTestId('search-input')).toBeVisible();
			// Filter-local labels are the wide-band presentation.
			await expect(filter.locator('.category-chip-label').first()).toBeVisible();

			const fit = await filter.evaluate((el) => {
				const box = el.getBoundingClientRect();
				return {
					scrollWidth: el.scrollWidth,
					clientWidth: el.clientWidth,
					left: box.left,
					right: box.right,
					chips: [...el.querySelectorAll('.category-option')].map((chip) => {
						const r = chip.getBoundingClientRect();
						return { left: r.left, right: r.right };
					})
				};
			});
			expect(
				fit.scrollWidth,
				`category filter scrolls at ${width}px: scrollWidth ${fit.scrollWidth} > clientWidth ${fit.clientWidth}`
			).toBeLessThanOrEqual(fit.clientWidth);
			for (const chip of fit.chips) {
				expect(chip.left).toBeGreaterThanOrEqual(fit.left - 0.5);
				expect(chip.right).toBeLessThanOrEqual(fit.right + 0.5);
			}
			const docOverflow = await page.evaluate(
				() => document.documentElement.scrollWidth - window.innerWidth
			);
			expect(docOverflow, `document horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
		}

		// Below the compact band the chips collapse to icons while the
		// radios keep their accessible names. The row is allowed to scroll
		// internally (overflow-x: auto is the design), but the fieldset box
		// itself must stay inside the viewport — min-width: 0 on the fieldset
		// defeats the UA min-content floor that otherwise shoves the row past
		// the right edge and produces document-level overflow.
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(filter.locator('.category-chip-label').first()).toBeHidden();
		for (const name of ['Animals', 'Architecture', 'Travel']) {
			await expect(page.getByRole('radio', { name })).toBeVisible();
		}
		const narrowFit = await filter.evaluate((el) => {
			const box = el.getBoundingClientRect();
			return { right: box.right, left: box.left };
		});
		expect(
			narrowFit.right,
			`category filter overflows viewport at 390px: right ${narrowFit.right}`
		).toBeLessThanOrEqual(390 + 0.5);
		const narrowDocOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth
		);
		expect(narrowDocOverflow, 'document horizontal overflow at 390px').toBeLessThanOrEqual(0);
	});
});

test.describe('Gallery artwork status (HPA-1029) @smoke', () => {
	// @smoke scopes this whole block: it is the CI smoke gate (desktop +
	// mobile), so these HPA-1029 regressions cannot silently drop out of the
	// automatic lane the way untagged gallery tests do. No unrelated gallery
	// test is tagged.
	// The Gallery family thumbnail is NOT under the gameplay fixture namespace,
	// so gameplayPage.assertSettled() is a no-op here. The Gallery tests own
	// their diagnostics and hold cleanup: every test attaches page diagnostics
	// (so unrelated console/page/request/response failures stay fatal) and
	// declares its intentional image failures (exact URL/method/status/
	// provenance), disposes its routes in finally, and the afterEach guard
	// asserts no image hold was left pending and no unexpected error occurred
	// (belt and suspenders — dispose() unroutes, assertClean() reports a
	// forgotten release even after a route is gone).
	let activeHolds: ImageHoldController | null = null;
	let activeDiagnostics: PageDiagnostics | null = null;

	test.afterEach(() => {
		activeHolds?.assertClean();
		activeDiagnostics?.assertNoUnexpectedErrors();
		activeDiagnostics?.assertNoUnexpectedFixtureRequests();
		activeHolds = null;
		activeDiagnostics = null;
	});

	// Real catalog fixtures for card navigation: the fixture router serves
	// their full puzzle payload with provenance, so navigating into a card is
	// fully controlled — never dependent on the real backend.
	const CARD_FIXTURE_A: GameplayFixtureId = 'e2e2b000-0000-4000-8000-000000000012';

	/** Attach page diagnostics to this test and register it for teardown. */
	function attachDiagnostics(page: Page): PageDiagnostics {
		const diagnostics = createPageDiagnostics(page);
		activeDiagnostics = diagnostics;
		return diagnostics;
	}

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

	/** Declare one intentional family-thumbnail failure (GET + exact status). */
	function declareThumbnailFailure(diagnostics: PageDiagnostics, familyId: string): void {
		diagnostics.setDeclaredImageFailures([
			{ url: thumbnailPattern(familyId), method: 'GET', status: 404, outcome: 'status' }
		]);
	}

	/**
	 * Wait for the declared thumbnail failure: exact URL, GET method, and the
	 * fixture-router provenance marker (a real-backend answer cannot match).
	 */
	function declaredThumbnailFailure(page: Page, familyId: string): Promise<Response> {
		return page.waitForResponse(
			(response) =>
				thumbnailPattern(familyId).test(response.url()) &&
				response.request().method() === 'GET' &&
				response.headers()[FIXTURE_ROUTER_HEADER] === FIXTURE_ROUTER_SOURCE
		);
	}

	const AUTH_SESSION_PATH = /\/api\/auth\/session(?:\?.*)?$/;

	/**
	 * `page.goto` that does not return until the initial `GET
	 * /api/auth/session` of the loaded document is fully over — finished or
	 * failed. The root layout fires `playerAuth.refresh()` fire-and-forget
	 * on mount, so neither 'load' nor 'domcontentloaded' waits for it: a
	 * later `page.reload()` can tear the document down while the
	 * real-backend fetch is still in flight, and diagnostics records its
	 * `net::ERR_ABORTED` as an unexpected request failure.
	 */
	async function gotoAndSettleAuthSession(
		page: Page,
		url: string,
		options?: Parameters<Page['goto']>[1]
	): Promise<void> {
		await settleRequestAround(page, { url: AUTH_SESSION_PATH, method: 'GET' }, () =>
			page.goto(url, options)
		);
	}

	/**
	 * `handle.release()` resolves when `route.fulfill()` returns — BEFORE
	 * the page has finished the released request. Settle the released
	 * request's terminal event so a following reload cannot abort it
	 * mid-flight.
	 */
	function releaseAndSettle(page: Page, handle: ImageHoldHandle, familyId: string): Promise<void> {
		return settleRequestAround(page, { url: thumbnailPattern(familyId), method: 'GET' }, () =>
			handle.release()
		);
	}

	test('held card thumbnail shows Loading…, then loads decoded after release', async ({ page }) => {
		const diagnostics = attachDiagnostics(page);
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
			diagnostics.dispose();
		}
	});

	test('failed card thumbnail shows an explicit No preview state, asserts the exact 404, and still navigates', async ({
		page
	}) => {
		const diagnostics = attachDiagnostics(page);
		const family = makeFamily(FAMILY_A, {
			name: 'Failed Thumbnail',
			// The easy variant is a real catalog fixture: the fixture router
			// serves its puzzle payload with provenance, so the navigation below
			// is fully controlled — the real backend is never consulted.
			variants: {
				easy: { id: CARD_FIXTURE_A, difficulty: 'easy', pieceCount: 12, status: 'ready' },
				normal: {
					id: `${FAMILY_A}-normal`,
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: `${FAMILY_A}-hard`,
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});
		await mockFamilyList(page, [family]);
		await createFixtureRouter().install(page);
		await plantGameplayConfig(page, CARD_FIXTURE_A);
		const images = createImageHoldController();
		activeHolds = images;
		try {
			await images.installImageUrl(page, thumbnailPattern(FAMILY_A), { failStatus: 404 });
			declareThumbnailFailure(diagnostics, FAMILY_A);

			// Assert the exact intentional negative: the declared thumbnail URL
			// really answered GET 404 with fixture-router provenance (not a
			// network error, another method, or a real-backend answer).
			const thumbnail404 = declaredThumbnailFailure(page, FAMILY_A);

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

			// A failed preview is presentation-only: card navigation still works
			// and lands on the fixture-served puzzle page.
			const easyLink = page
				.locator('[data-testid="difficulty-action"][data-difficulty="easy"]')
				.first();
			await expect(easyLink).toBeVisible();
			await easyLink.click();
			await expect(page).toHaveURL(new RegExp(`/puzzle/${CARD_FIXTURE_A}`));
			// Fresh fixture entry presents the mandatory Mission Setup dialog —
			// proof the puzzle page actually loaded (not just a URL change).
			await expect(page.getByRole('dialog', { name: 'Mission Setup' })).toBeVisible();
		} finally {
			await images.dispose();
			diagnostics.dispose();
		}
	});

	test('replaces a failed card thumbnail when returning to an updated catalog without a reload', async ({
		page
	}) => {
		const diagnostics = attachDiagnostics(page);
		const familyA = makeFamily(FAMILY_A, {
			name: 'Changed Thumbnail A',
			// The easy variant is a real catalog fixture: the fixture router
			// serves its puzzle payload with provenance, so leaving through the
			// card is fully controlled — no backend-dependent error panel.
			variants: {
				easy: { id: CARD_FIXTURE_A, difficulty: 'easy', pieceCount: 12, status: 'ready' },
				normal: {
					id: `${FAMILY_A}-normal`,
					difficulty: 'normal',
					pieceCount: 49,
					status: 'ready'
				},
				hard: {
					id: `${FAMILY_A}-hard`,
					difficulty: 'hard',
					pieceCount: 100,
					status: 'ready'
				}
			}
		});
		const familyB = makeFamily(FAMILY_B, { name: 'Changed Thumbnail B' });
		await mockFamilyList(page, [familyA]);
		await mockFamilyThumbnail(page, FAMILY_B);
		await createFixtureRouter().install(page);
		await plantGameplayConfig(page, CARD_FIXTURE_A);
		const images = createImageHoldController();
		activeHolds = images;
		try {
			await images.installImageUrl(page, thumbnailPattern(FAMILY_A), { failStatus: 404 });
			declareThumbnailFailure(diagnostics, FAMILY_A);

			await page.goto('/');
			const card = page.getByTestId('puzzle-card');
			await expect(card).toHaveCount(1);
			const cardImg = card.locator('img');
			await expect(card.getByTestId('puzzle-card-art-placeholder')).toContainText('No preview');
			await expect(cardImg).toHaveAttribute('data-image-state', 'error');

			// The failure is asserted — retire the declaration so any NEW
			// failure (including a spurious repeat of A's 404) stays fatal.
			diagnostics.setDeclaredImageFailures([]);

			// A full reload would reset this marker; recovery must keep it set.
			await page.evaluate(() => {
				(window as unknown as { __galleryNoReload?: boolean }).__galleryNoReload = true;
			});

			// The catalog changes: the family list now returns family B. Leave
			// through family A's card — the fixture router serves its puzzle page
			// (controlled) — and return via browser history: SPA navigation, so
			// the gallery load re-runs without a full reload and the keyed card
			// list mounts family B's card with its (working) URL.
			await mockFamilyList(page, [familyB]);
			const easyLink = page
				.locator('[data-testid="difficulty-action"][data-difficulty="easy"]')
				.first();
			await easyLink.click();
			await expect(page).toHaveURL(new RegExp(`/puzzle/${CARD_FIXTURE_A}`));
			await expect(page.getByRole('dialog', { name: 'Mission Setup' })).toBeVisible();
			await page.goBack();

			await expect(page).toHaveURL(/\/$/);
			await expect(page.getByTestId('puzzle-card')).toHaveCount(1);
			await expect(page.getByTestId('puzzle-card-title')).toHaveText('Changed Thumbnail B');
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
			diagnostics.dispose();
		}
	});

	test('continue-on-device art stays silent while held, then loads decoded after release', async ({
		page
	}) => {
		const diagnostics = attachDiagnostics(page);
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

			// Settle the initial auth session before the reload below: the
			// layout's fire-and-forget refresh is NOT covered by 'load', so
			// without this the reload can abort it and diagnostics records a
			// spurious net::ERR_ABORTED failure.
			await gotoAndSettleAuthSession(page, '/');
			// Seeded progress surfaces the continue panel; the reload re-runs the
			// load against the same mocks (routes live on the page across reloads).
			await seedApiVariantProgress(page, CONTINUE_EASY_VARIANT, '1:1', 16);
			// The first load's gallery card already requests this same thumbnail
			// URL. Under trace/mobile overhead that pre-reload request is captured
			// before page.reload() tears the document down, and its stale route
			// entry survives into the hold (count 2 instead of 1). Drain the first
			// load deterministically — wait for the card's capture, release it —
			// so the count below is exactly the post-reload request on every run.
			await expect.poll(() => handle.pendingCount).toBe(1);
			// release() resolves at route fulfillment — BEFORE the page has
			// finished the request — so a reload could still abort it.
			// Settle the released request's terminal event first.
			await releaseAndSettle(page, handle, CONTINUE_FAMILY);
			// The settled auth refresh re-rendered the shell, which can fire
			// late requests (a font fetch was observed aborting at reload in
			// scratch). This wait is best-effort: it can reuse an earlier
			// idle event and resolve while newer requests are in flight.
			// Auth and held thumbnails are separately awaited to terminal
			// events above.
			await page.waitForLoadState('networkidle');
			// DOM content only: the reload re-issues the continue-art request
			// into the hold, and an eager <img> in flight before 'load' would
			// stall the reload past the timeout before release can run.
			await page.reload({ waitUntil: 'domcontentloaded' });

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
			diagnostics.dispose();
		}
	});

	test('changed continue-on-device art URL recovers from a prior failure without a reload', async ({
		page
	}) => {
		const diagnostics = attachDiagnostics(page);
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
			declareThumbnailFailure(diagnostics, CONTINUE_FAMILY);
			const handleB = await images.installImageUrl(page, thumbnailPattern(CONTINUE_B_FAMILY));

			// Same initial-auth settle as the sibling continue-art test: the
			// reload below must not abort a still-in-flight session fetch.
			await gotoAndSettleAuthSession(page, '/', { waitUntil: 'domcontentloaded' });
			// Two saved sessions: family A is newest (its thumbnail 404s), family
			// B is the next-newest whose held thumbnail proves update() resets
			// the mounted img back to pending before loading.
			await seedApiVariantProgress(page, CONTINUE_EASY_VARIANT, '1:1', 16, {
				lastUpdated: 3_000
			});
			await seedApiVariantProgress(page, CONTINUE_B_EASY_VARIANT, '1:1', 16, {
				lastUpdated: 2_000
			});
			// The first load's family-B card already requests this same
			// thumbnail URL into the hold. Drain it deterministically — wait
			// for the capture, then release it through the same completion
			// barrier as the sibling drain (route fulfillment ≠ page-side
			// requestfinished) — so the reload neither aborts the request
			// (net::ERR_ABORTED in diagnostics) nor leaves a stale entry
			// inflating the post-reload count.
			await expect.poll(() => handleB.pendingCount).toBe(1);
			await releaseAndSettle(page, handleB, CONTINUE_B_FAMILY);
			// Same best-effort quiet as the sibling test: the wait can
			// reuse an earlier idle event while late requests are still in
			// flight; auth and the held thumbnail are already awaited to
			// terminal events.
			await page.waitForLoadState('networkidle');
			await page.reload({ waitUntil: 'domcontentloaded' });

			const panel = page.getByTestId('continue-on-device');
			const continueArt = panel.locator('img.continue-art');
			await expect(panel).toContainText('Continue Fail A');
			// The failed decorative art stays silent (no caption) but the <img>
			// reports the failure with no decoded pixels.
			await expect(continueArt).toHaveAttribute('data-image-state', 'error');
			expect(await decodedWidth(continueArt)).toBe(0);

			// The failure is asserted — retire the declaration so any NEW
			// failure (including a spurious repeat of A's 404) stays fatal.
			diagnostics.setDeclaredImageFailures([]);

			// A full reload would reset this marker; the recovery must keep it.
			await page.evaluate(() => {
				(window as unknown as { __galleryNoReload?: boolean }).__galleryNoReload = true;
			});
			await continueArt.evaluate((el) => {
				(el as HTMLImageElement).dataset.urlChangeProbe = 'mounted';
			});

			// Discarding the newest save promotes family B: resumeImageUrl swaps
			// to B's URL through the Svelte prop on the SAME <img> element,
			// exercising imageStatus.update() (error -> pending -> loaded).
			await page.getByTestId('continue-secondary-toggle').click();
			await page.getByRole('button', { name: 'Discard saved progress' }).click();
			await page
				.getByRole('dialog', { name: 'Discard saved progress' })
				.getByRole('button', { name: 'Discard' })
				.click();

			await expect(panel).toContainText('Continue Ok B');
			await expect(continueArt).toHaveAttribute('data-image-state', 'pending');
			expect(await continueArt.getAttribute('data-url-change-probe')).toBe('mounted');
			await expect.poll(() => handleB.pendingCount).toBeGreaterThanOrEqual(1);
			await expect
				.poll(async () => {
					await handleB.release();
					return decodedWidth(continueArt);
				})
				.toBeGreaterThan(0);

			await expect(continueArt).toHaveAttribute('data-image-state', 'loaded');
			expect(
				await page.evaluate(
					() => (window as unknown as { __galleryNoReload?: boolean }).__galleryNoReload
				)
			).toBe(true);
		} finally {
			await images.dispose();
			diagnostics.dispose();
		}
	});
});
