import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
	loadPersistedSession,
	validationContextFrom,
	type PersistedPuzzleSessionV1
} from '@perseus/game-core';
import type { PuzzleFamilySummary } from '@perseus/types';
import { test, expect } from './support/test';
import { getFixture } from './gameplay-fixtures/catalog';
import {
	buildMinimalSeed,
	progressKey,
	seedApiVariantProgress
} from './gameplay-fixtures/persisted-state';
import type { StoredQuickPuzzle } from '../src/lib/services/quickPuzzle/types';
import { QUICK_PUZZLE_KEY_PREFIX } from '../src/lib/services/quickPuzzle/types';
import { DEFAULT_GAMEPLAY_PREFERENCES } from '../src/lib/services/gameplay/session/preferences';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_ART = path.join(__dirname, 'fixtures', 'galaxy-reference-art.png');
const IMMEDIATE_START = { ...DEFAULT_GAMEPLAY_PREFERENCES, startImmediately: true };
const VISUAL_PLAYER = {
	id: '00000000-0000-4000-8000-00000000a001',
	email: 'arcade@example.test',
	name: 'Arcade Pilot',
	createdAt: 1_710_000_000_020,
	lastLoginAt: 1_710_000_000_021
};
const VISUAL_PROGRESSION = {
	score: 900,
	rank: 38,
	easyClears: 4,
	normalClears: 2,
	hardClears: 1,
	achievementsUnlocked: 3,
	achievementsTotal: 9,
	masteryEarned: 2
};

const VISUAL_FAMILIES: PuzzleFamilySummary[] = [
	{
		id: '00000000-0000-4000-8000-000000007a01',
		name: 'Sunset Ridge',
		category: 'Nature',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1_710_000_000_000,
		variants: {
			easy: {
				id: '00000000-0000-4000-8000-000000007a11',
				difficulty: 'easy',
				pieceCount: 16,
				status: 'ready'
			},
			normal: {
				id: '00000000-0000-4000-8000-000000007a12',
				difficulty: 'normal',
				pieceCount: 49,
				status: 'ready'
			},
			hard: {
				id: '00000000-0000-4000-8000-000000007a13',
				difficulty: 'hard',
				pieceCount: 100,
				status: 'ready'
			}
		}
	},
	{
		id: '00000000-0000-4000-8000-000000007b01',
		name: 'Tide Pools',
		category: 'Animals',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1_710_000_000_001,
		variants: {
			easy: {
				id: '00000000-0000-4000-8000-000000007b11',
				difficulty: 'easy',
				pieceCount: 16,
				status: 'ready'
			},
			normal: {
				id: '00000000-0000-4000-8000-000000007b12',
				difficulty: 'normal',
				pieceCount: 49,
				status: 'ready'
			},
			hard: {
				id: '00000000-0000-4000-8000-000000007b13',
				difficulty: 'hard',
				pieceCount: 100,
				status: 'ready'
			}
		}
	},
	{
		id: '00000000-0000-4000-8000-000000007c01',
		name: 'Glass District',
		category: 'Architecture',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1_710_000_000_002,
		variants: {
			easy: {
				id: '00000000-0000-4000-8000-000000007c11',
				difficulty: 'easy',
				pieceCount: 16,
				status: 'ready'
			},
			normal: {
				id: '00000000-0000-4000-8000-000000007c12',
				difficulty: 'normal',
				pieceCount: 49,
				status: 'ready'
			},
			hard: {
				id: '00000000-0000-4000-8000-000000007c13',
				difficulty: 'hard',
				pieceCount: 100,
				status: 'ready'
			}
		}
	}
];

const VISUAL_ALLOWLIST = [
	{
		email: 'pilot@example.com',
		createdAt: 1_710_000_000_010,
		addedBy: 'admin',
		player: {
			id: '00000000-0000-4000-8000-00000000a001',
			email: 'pilot@example.com',
			name: 'Pilot One',
			createdAt: 1_710_000_000_010,
			lastLoginAt: 1_710_000_000_100
		}
	},
	{ email: 'navigator@example.com', createdAt: 1_710_000_000_011, addedBy: 'admin' },
	{ email: 'builder@example.com', createdAt: 1_710_000_000_012, addedBy: 'admin' },
	{ email: 'captain@example.com', createdAt: 1_710_000_000_013, addedBy: 'admin' }
];

async function installVisualAuth(page: Page, authenticated = false): Promise<void> {
	await page.route(/\/api\/auth\/session$/, (route) =>
		route.fulfill({
			json: authenticated ? { authenticated: true, user: VISUAL_PLAYER } : { authenticated: false }
		})
	);
	if (authenticated) {
		await page.route(/\/api\/player\/progression$/, (route) =>
			route.fulfill({ json: VISUAL_PROGRESSION })
		);
	}
}

async function installVisualThumbnail(page: Page): Promise<void> {
	await page.route(/\/api\/puzzle-families\/[^/]+\/thumbnail$/, (route) =>
		route.fulfill({ path: VISUAL_ART, contentType: 'image/png' })
	);
}

async function installVisualGallery(page: Page, families: PuzzleFamilySummary[]): Promise<void> {
	await installVisualAuth(page, true);
	await page.route(/\/api\/puzzle-families(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { families, total: families.length, offset: 0, limit: 20 } })
	);
	await installVisualThumbnail(page);
}

async function installVisualAdmin(page: Page): Promise<void> {
	await installVisualAuth(page);
	await page.route(/\/api\/admin\/puzzle-families(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { families: VISUAL_FAMILIES } })
	);
	await page.route(/\/api\/admin\/player-allowlist(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { entries: VISUAL_ALLOWLIST } })
	);
	await installVisualThumbnail(page);
}

async function prepareVisualGallery(page: Page): Promise<void> {
	await installVisualGallery(page, VISUAL_FAMILIES);
	await page.goto('/');
	await seedApiVariantProgress(page, VISUAL_FAMILIES[0]!.variants.easy.id, '1:1', 16);
	await page.reload();
	await expect(page.getByTestId('continue-on-device')).toBeVisible();
	await expect(page.getByTestId('puzzle-grid')).toBeVisible();
	await expect(
		page.locator(
			'[data-testid="arcade-score"]:visible, [data-testid="arcade-compact-score"]:visible'
		)
	).toHaveText('900');
	await expect(page.getByRole('link', { name: 'Profile for Arcade Pilot' })).toBeVisible();
}

async function waitForVisualReady(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all(
			Array.from(document.images).map(async (image) => {
				if (!image.complete) {
					await new Promise<void>((resolve) => {
						image.addEventListener('load', () => resolve(), { once: true });
						image.addEventListener('error', () => resolve(), { once: true });
					});
				}
				try {
					await image.decode();
				} catch {
					// load/error above is the deterministic boundary
				}
			})
		);
	});
}

async function prepareVisualGameplay(page: Page): Promise<void> {
	await installVisualAuth(page);
	await page.clock.install({ time: new Date('2026-09-09T12:00:00Z') });
	await page.goto('/quick');
	await page.getByTestId('quick-uploader-file').setInputFiles(VISUAL_ART);
	await page.getByTestId('quick-uploader-name').fill('Sunset Ridge');
	await page.getByTestId('quick-uploader-aspect').selectOption('3:4');
	await page.getByTestId('quick-uploader-pieces').selectOption('48');
	await Promise.all([
		page.waitForURL(/\/puzzle\/q-[^/]+$/),
		page.getByTestId('quick-uploader-submit').click()
	]);

	const quickId = new URL(page.url()).pathname.split('/').pop();
	if (!quickId?.startsWith('q-')) throw new Error(`Expected quick puzzle id, got ${quickId}`);
	const quickJson = await page.evaluate(
		(key) => localStorage.getItem(key),
		`${QUICK_PUZZLE_KEY_PREFIX}${quickId}`
	);
	if (!quickJson) throw new Error(`Missing quick puzzle metadata for ${quickId}`);
	const stored = JSON.parse(quickJson) as StoredQuickPuzzle;
	const fixture = getFixture('e2e-portrait-12');
	const placedPieces = stored.pieces.slice(0, 18).map(({ id, correctX, correctY }) => ({
		pieceId: id,
		x: correctX,
		y: correctY
	}));
	const snapshot: PersistedPuzzleSessionV1 = {
		...buildMinimalSeed('e2e-portrait-12'),
		puzzleId: quickId,
		source: 'local',
		elapsedActiveSeconds: 215,
		timerStarted: true,
		placedPieces,
		trayOrder: stored.pieces.map(({ id }) => id),
		hasUserActivity: true,
		lastUpdated: 1_757_400_000_000
	};
	const context = validationContextFrom({
		puzzleId: quickId,
		source: 'local',
		pieceCount: stored.pieceCount,
		gridCols: stored.gridCols,
		gridRows: stored.gridRows,
		pieces: stored.pieces.map(({ id, correctX, correctY }) => ({ id, correctX, correctY }))
	});
	const snapshotJson = JSON.stringify(snapshot);
	const validation = loadPersistedSession(snapshotJson, context);
	if (validation.status !== 'loaded') {
		throw new Error(`Visual gameplay seed rejected: ${validation.status}`);
	}

	await page.clock.pauseAt(new Date('2026-09-09T12:30:00Z'));
	await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
		key: progressKey(quickId),
		value: snapshotJson
	});
	await page.reload();
	const resumeDialog = page.getByRole('dialog', { name: 'Resume Mission' });
	await expect(resumeDialog).toBeVisible();
	await resumeDialog.getByRole('button', { name: 'Resume', exact: true }).click();
	await expect(page.getByTestId('puzzle-board')).toBeVisible();
	await waitForVisualReady(page);
}

async function expectGameplayGeometry(page: Page): Promise<void> {
	const geometry = await page.evaluate(() => {
		const bounds = (selector: string) => {
			const element = document.querySelector<HTMLElement>(selector);
			if (!element) return null;
			const rect = element.getBoundingClientRect();
			return {
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				width: rect.width
			};
		};
		return {
			viewport: { width: window.innerWidth, height: window.innerHeight },
			rail: bounds('[data-testid="puzzle-toolbar"]'),
			stage: bounds('.board-stage'),
			board: bounds('.board-stage .board-panel'),
			tray: bounds('[data-testid="puzzle-inventory-panel"]'),
			trayControls: Array.from(
				document.querySelectorAll<HTMLElement>(
					'[data-testid="puzzle-inventory-panel"] .panel-header .inv-count, [data-testid="puzzle-inventory-panel"] .panel-header .inventory-tools .panel-action, [data-testid="puzzle-inventory-panel"] .panel-header .panel-actions .panel-action'
				)
			)
				.filter((element) => {
					const rect = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
				})
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return {
						label: element.getAttribute('aria-label') ?? element.className,
						interactive: !element.matches('.inv-count'),
						left: rect.left,
						right: rect.right,
						top: rect.top,
						bottom: rect.bottom,
						width: rect.width,
						height: rect.height
					};
				}),
			header: bounds('.board-stage > .hud-header'),
			hud: bounds('[data-testid="gameplay-hud"]'),
			actions: ['hint', 'reference', 'undo', 'fit', 'pause'].map((action) =>
				bounds(`[data-testid="puzzle-toolbar"] [data-toolbar-action="${action}"]`)
			)
		};
	});

	expect(geometry.rail).not.toBeNull();
	expect(geometry.stage).not.toBeNull();
	expect(geometry.board).not.toBeNull();
	expect(geometry.tray).not.toBeNull();
	expect(geometry.header).not.toBeNull();
	expect(geometry.hud).not.toBeNull();
	if (
		!geometry.rail ||
		!geometry.stage ||
		!geometry.board ||
		!geometry.tray ||
		!geometry.header ||
		!geometry.hud
	) {
		throw new Error('Gameplay geometry did not mount all expected surfaces');
	}

	if (geometry.viewport.width < 1024) {
		expect(geometry.rail.left).toBeGreaterThanOrEqual(geometry.board.right - 1);
	} else {
		expect(geometry.rail.right).toBeLessThanOrEqual(geometry.board.left + 1);
		expect(Math.round(geometry.tray.width)).toBe(geometry.viewport.width >= 1440 ? 352 : 300);
	}
	expect(geometry.header.left).toBeGreaterThanOrEqual(geometry.stage.left);
	expect(geometry.header.right).toBeLessThanOrEqual(geometry.stage.right + 1);
	expect(geometry.hud.left).toBeGreaterThanOrEqual(geometry.stage.left);
	expect(geometry.hud.right).toBeLessThanOrEqual(geometry.stage.right + 1);

	for (const action of geometry.actions) {
		expect(action).not.toBeNull();
		if (!action) continue;
		expect(action.left).toBeGreaterThanOrEqual(geometry.rail.left);
		expect(action.right).toBeLessThanOrEqual(geometry.rail.right + 1);
		expect(action.top).toBeGreaterThanOrEqual(0);
		expect(action.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
	}

	for (const control of geometry.trayControls) {
		expect(control.left).toBeGreaterThanOrEqual(geometry.tray.left);
		expect(control.right).toBeLessThanOrEqual(geometry.tray.right + 1);
		if (geometry.viewport.width <= 1279 && control.interactive) {
			expect(control.width, `${control.label} width`).toBeGreaterThanOrEqual(44);
			expect(control.height, `${control.label} height`).toBeGreaterThanOrEqual(44);
		}
	}
	for (let index = 0; index < geometry.trayControls.length; index += 1) {
		const control = geometry.trayControls[index]!;
		const next = geometry.trayControls[index + 1];
		if (next) {
			expect(control.right, `${control.label} intersects ${next.label}`).toBeLessThanOrEqual(
				next.left + 1
			);
		}
	}
}

test.describe('phone @visual', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		reducedMotion: 'reduce'
	});

	test('2a gallery @visual', async ({ page }) => {
		await prepareVisualGallery(page);
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-phone-gallery.png', {
			maxDiffPixelRatio: 0.005
		});
	});

	test('saved progress disclosure menu @visual', async ({ page }) => {
		await prepareVisualGallery(page);
		const activeEasyGems = page.locator(
			'[data-testid="difficulty-action"][data-difficulty="easy"].difficulty-action-active [data-testid="difficulty-gems"]'
		);
		const activeGemColors = await activeEasyGems.evaluate((element) => ({
			root: getComputedStyle(element).color,
			gem: getComputedStyle(element.querySelector('svg')!).color,
			count: getComputedStyle(element.lastElementChild!).color
		}));
		expect(activeGemColors).toEqual({
			root: 'rgb(3, 32, 42)',
			gem: 'rgb(3, 32, 42)',
			count: 'rgb(3, 32, 42)'
		});
		const toggle = page.getByTestId('continue-secondary-toggle');
		const menu = page.locator('.continue-secondary-menu');
		await toggle.focus();
		await expect(toggle).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(menu).toBeVisible();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Discard saved progress' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'View saved progress' })).toBeFocused();
		const geometry = await menu.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return {
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight
			};
		});
		expect(geometry.left).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.top).toBeGreaterThanOrEqual(0);
		expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
	});

	test('2b gameplay @visual', async ({ page }) => {
		await prepareVisualGameplay(page);
		await expectGameplayGeometry(page);
		await expect(page).toHaveScreenshot('galaxy-phone-gameplay.png', {
			maxDiffPixelRatio: 0.005
		});
	});

	test('2c completion @visual', async ({ gameplayPage, page }) => {
		await gameplayPage.gotoFixture({
			fixtureId: 'e2e-square-4',
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START
		});
		await gameplayPage.solveFixture();
		await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		const playAgain = page.getByRole('button', { name: 'PLAY AGAIN' });
		await expect(playAgain).toBeFocused();
		await page.getByTestId('celebration-modal').evaluate((modal) => {
			const box = modal.querySelector<HTMLElement>('.modal-box');
			const actions = box?.querySelector<HTMLElement>('.modal-actions');
			actions?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		});
		const phoneCompletionScroll = await page.getByTestId('celebration-modal').evaluate((modal) => {
			const box = modal.querySelector<HTMLElement>('.modal-box');
			const actions = box?.querySelector<HTMLElement>('.modal-actions');
			const boxRect = box?.getBoundingClientRect();
			const actionsRect = actions?.getBoundingClientRect();
			return {
				scrollTop: box?.scrollTop ?? 0,
				scrollHeight: box?.scrollHeight ?? 0,
				clientHeight: box?.clientHeight ?? 0,
				actionsReachableByScroll:
					boxRect !== undefined &&
					actionsRect !== undefined &&
					actionsRect.top >= boxRect.top &&
					actionsRect.bottom <= boxRect.bottom,
				actionCount: actions?.querySelectorAll('button').length ?? 0
			};
		});
		expect(phoneCompletionScroll.scrollHeight).toBeGreaterThan(phoneCompletionScroll.clientHeight);
		expect(phoneCompletionScroll.actionsReachableByScroll).toBe(true);
		expect(phoneCompletionScroll.actionCount).toBe(2);
		await expect(playAgain).toBeFocused();
		await expect(playAgain).toBeVisible();
		await page.getByTestId('celebration-modal').evaluate((modal) => {
			modal.querySelector<HTMLElement>('.modal-box')?.scrollTo({ top: 0, left: 0 });
		});
		const resetScrollTop = await page
			.getByTestId('celebration-modal')
			.evaluate((modal) => modal.querySelector<HTMLElement>('.modal-box')?.scrollTop ?? 0);
		expect(resetScrollTop).toBe(0);
		await expect(playAgain).toBeFocused();
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-phone-completion.png', {
			maxDiffPixelRatio: 0.005
		});
	});
});

test.describe('landscape tablet @visual', () => {
	test.use({
		viewport: { width: 1080, height: 810 },
		hasTouch: true,
		isMobile: true,
		reducedMotion: 'reduce'
	});

	test('2d gallery @visual', async ({ page }) => {
		await prepareVisualGallery(page);
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-tablet-gallery.png', {
			maxDiffPixelRatio: 0.005
		});
	});

	test('saved progress disclosure menu @visual', async ({ page }) => {
		await prepareVisualGallery(page);
		const toggle = page.getByTestId('continue-secondary-toggle');
		const menu = page.locator('.continue-secondary-menu');
		await toggle.focus();
		await expect(toggle).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(menu).toBeVisible();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Discard saved progress' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'View saved progress' })).toBeFocused();
		const geometry = await menu.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return {
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight
			};
		});
		expect(geometry.left).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.top).toBeGreaterThanOrEqual(0);
		expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
	});

	test('tablet inventory filter disclosure keyboard @visual', async ({ page }) => {
		await prepareVisualGameplay(page);
		const filterDisclosure = page.getByTestId('inventory-filter-disclosure');
		const filterToggle = page.getByTestId('inventory-filter-toggle');
		const cornerFilter = page.getByRole('button', { name: 'Corner pieces' });
		await filterToggle.focus();
		await expect(filterToggle).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(filterDisclosure).toHaveAttribute('open', '');
		await expect(cornerFilter).toBeVisible();
		await cornerFilter.focus();
		await expect(cornerFilter).toBeFocused();
		await filterToggle.focus();
		await page.keyboard.press('Enter');
		await expect(filterDisclosure).not.toHaveAttribute('open');
	});

	test('2e gameplay @visual', async ({ page }) => {
		await prepareVisualGameplay(page);
		await expectGameplayGeometry(page);
		await expect(page).toHaveScreenshot('galaxy-tablet-gameplay.png', {
			maxDiffPixelRatio: 0.005
		});
	});

	test('2f completion @visual', async ({ gameplayPage, page }) => {
		await gameplayPage.gotoFixture({
			fixtureId: 'e2e-square-4',
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START
		});
		await gameplayPage.solveFixture();
		await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-tablet-completion.png', {
			maxDiffPixelRatio: 0.005
		});
	});
});

test.describe('desktop @visual', () => {
	test.use({
		viewport: { width: 1440, height: 900 },
		hasTouch: false,
		isMobile: false,
		reducedMotion: 'reduce'
	});

	test('3a gallery @visual', async ({ page }) => {
		await prepareVisualGallery(page);
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-desktop-gallery.png', {
			maxDiffPixelRatio: 0.005
		});
	});

	test('3b gameplay @visual', async ({ page }) => {
		await prepareVisualGameplay(page);
		await expectGameplayGeometry(page);
		await expect(page).toHaveScreenshot('galaxy-desktop-gameplay.png', {
			maxDiffPixelRatio: 0.005
		});
	});

	test('3c completion @visual', async ({ gameplayPage, page }) => {
		await gameplayPage.gotoFixture({
			fixtureId: 'e2e-square-4',
			completion: { kind: 'success' },
			seedPreferences: IMMEDIATE_START
		});
		await gameplayPage.solveFixture();
		await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-desktop-completion.png', {
			maxDiffPixelRatio: 0.005
		});
	});
});

test.describe('admin @visual', () => {
	test.use({
		viewport: { width: 1440, height: 900 },
		hasTouch: false,
		isMobile: false,
		reducedMotion: 'reduce'
	});

	test('4a missions @visual', async ({ page }) => {
		await installVisualAdmin(page);
		await page.goto('/admin');
		await expect(page.getByRole('tab', { name: 'Missions' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.getByText('Sunset Ridge')).toBeVisible();
		await expect(page.getByTestId('admin-missions-count')).toHaveText('3');
		await expect(page.getByTestId('admin-players-count')).toHaveText('4');
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-admin-missions.png', {
			maxDiffPixelRatio: 0.005
		});
	});

	test('4a player access @visual', async ({ page }) => {
		await installVisualAdmin(page);
		await page.goto('/admin');
		await page.getByRole('tab', { name: 'Player access' }).click();
		await expect(page.getByText('pilot@example.com')).toBeVisible();
		await expect(page.getByTestId('admin-players-count')).toHaveText('4');
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-admin-player-access.png', {
			maxDiffPixelRatio: 0.005
		});
	});
});
