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

const VISUAL_ADMIN_FAMILIES: PuzzleFamilySummary[] = [
	...VISUAL_FAMILIES,
	{
		id: '00000000-0000-4000-8000-000000007d01',
		name: 'Aurora Valley',
		category: 'Nature',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1_710_000_000_003,
		variants: {
			easy: {
				id: '00000000-0000-4000-8000-000000007d11',
				difficulty: 'easy',
				pieceCount: 16,
				status: 'ready'
			},
			normal: {
				id: '00000000-0000-4000-8000-000000007d12',
				difficulty: 'normal',
				pieceCount: 49,
				status: 'ready'
			},
			hard: {
				id: '00000000-0000-4000-8000-000000007d13',
				difficulty: 'hard',
				pieceCount: 100,
				status: 'ready'
			}
		}
	},
	{
		id: '00000000-0000-4000-8000-000000007e01',
		name: 'Signal Drift',
		category: 'Abstract',
		aspectRatio: '1:1',
		status: 'processing',
		createdAt: 1_710_000_000_004,
		variants: {
			easy: {
				id: '00000000-0000-4000-8000-000000007e11',
				difficulty: 'easy',
				pieceCount: 16,
				status: 'processing'
			},
			normal: {
				id: '00000000-0000-4000-8000-000000007e12',
				difficulty: 'normal',
				pieceCount: 49,
				status: 'processing'
			},
			hard: {
				id: '00000000-0000-4000-8000-000000007e13',
				difficulty: 'hard',
				pieceCount: 100,
				status: 'processing'
			}
		}
	},
	{
		id: '00000000-0000-4000-8000-000000007f01',
		name: 'Broken Orbit',
		category: 'Architecture',
		aspectRatio: '1:1',
		status: 'failed',
		createdAt: 1_710_000_000_005,
		variants: {
			easy: {
				id: '00000000-0000-4000-8000-000000007f11',
				difficulty: 'easy',
				pieceCount: 16,
				status: 'failed'
			},
			normal: {
				id: '00000000-0000-4000-8000-000000007f12',
				difficulty: 'normal',
				pieceCount: 49,
				status: 'failed'
			},
			hard: {
				id: '00000000-0000-4000-8000-000000007f13',
				difficulty: 'hard',
				pieceCount: 100,
				status: 'failed'
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

async function installVisualFixtureReference(page: Page): Promise<void> {
	await page.route(/\/api\/puzzles\/e2e-square-4\/reference$/, (route) =>
		route.fulfill({
			path: VISUAL_ART,
			contentType: 'image/png',
			headers: { 'x-perseus-e2e-source': 'fixture-router' }
		})
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
		route.fulfill({ json: { families: VISUAL_ADMIN_FAMILIES } })
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
				width: rect.width,
				height: rect.height
			};
		};
		return {
			viewport: { width: window.innerWidth, height: window.innerHeight },
			rail: bounds('[data-testid="puzzle-toolbar"]'),
			stage: bounds('.board-stage'),
			board: bounds('.board-stage .board-panel'),
			tray: bounds('[data-testid="puzzle-inventory-panel"]'),
			trayColumns: (() => {
				const grid = document.querySelector<HTMLElement>('.pieces-grid');
				if (!grid) return 0;
				return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
			})(),
			boardMetrics: (() => {
				const layout = document.querySelector<HTMLElement>('.game-layout');
				if (!layout) return null;
				const style = getComputedStyle(layout);
				return {
					boardWidth: Number.parseFloat(style.getPropertyValue('--board-width')),
					boardHeight: Number.parseFloat(style.getPropertyValue('--board-height')),
					cellSize: Number.parseFloat(style.getPropertyValue('--board-cell-size')),
					pieceSlotSize: Number.parseFloat(style.getPropertyValue('--piece-slot-size')),
					trayColumns: Number.parseInt(style.getPropertyValue('--tray-columns'), 10)
				};
			})(),
			back: bounds('[data-testid="back-to-arcade-link"]'),
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
			),
			dockedActions: ['redo', 'rotation'].map((action) => {
				const button = document.querySelector<HTMLButtonElement>(
					`[data-testid="puzzle-toolbar"] [data-toolbar-action="${action}"]`
				);
				return {
					bounds: bounds(`[data-testid="puzzle-toolbar"] [data-toolbar-action="${action}"]`),
					disabled: button?.disabled ?? false
				};
			})
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
		!geometry.back ||
		!geometry.header ||
		!geometry.hud
	) {
		throw new Error('Gameplay geometry did not mount all expected surfaces');
	}

	if (geometry.viewport.width < 1024) {
		expect(geometry.rail.left).toBeGreaterThanOrEqual(geometry.board.right - 1);
	} else {
		expect(geometry.rail.left).toBeLessThanOrEqual(1);
		expect(geometry.rail.right).toBeLessThanOrEqual(geometry.board.left + 1);
		expect(geometry.tray.right).toBeGreaterThanOrEqual(geometry.viewport.width - 1);
		expect(Math.round(geometry.tray.width)).toBe(geometry.viewport.width >= 1440 ? 352 : 300);
		expect(geometry.trayColumns).toBe(geometry.viewport.width >= 1440 ? 3 : 2);
		expect(geometry.boardMetrics).not.toBeNull();
		if (geometry.boardMetrics) {
			expect(geometry.boardMetrics.boardWidth).toBeGreaterThan(0);
			expect(geometry.boardMetrics.boardHeight).toBeGreaterThan(0);
			expect(geometry.boardMetrics.cellSize).toBeGreaterThan(0);
			expect(geometry.boardMetrics.pieceSlotSize).toBeGreaterThan(0);
			expect(geometry.boardMetrics.trayColumns).toBe(geometry.viewport.width >= 1440 ? 3 : 2);
		}
		for (const action of geometry.dockedActions) {
			expect(action.bounds).not.toBeNull();
			if (action.bounds) {
				expect(action.bounds.width).toBeGreaterThan(0);
				expect(action.bounds.height).toBeGreaterThan(0);
			}
		}
		expect(geometry.dockedActions[1]?.disabled).toBe(true);
		const hint = geometry.actions[0];
		expect(hint).not.toBeNull();
		if (hint) {
			expect(hint.top).toBeGreaterThanOrEqual(geometry.back.bottom + 12);
		}
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

async function expectCompletionPresentation(
	page: Page,
	backgroundPositions: string[]
): Promise<void> {
	const presentation = await page.evaluate(() => {
		const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
		const hints = document.querySelector<SVGElement>('.summary-icon-hints');
		const incorrect = document.querySelector<SVGElement>('.summary-icon-incorrect');
		const actions = Array.from(document.querySelectorAll<HTMLElement>('.modal-actions > button'));
		return {
			backgroundImage: backdrop ? getComputedStyle(backdrop).backgroundImage : '',
			hintsFill: hints ? getComputedStyle(hints).fill : '',
			incorrectFill: incorrect ? getComputedStyle(incorrect).fill : '',
			actionFontSizes: actions.map((button) =>
				Number.parseFloat(getComputedStyle(button).fontSize)
			),
			actionOverflowFree: actions.every((button) => button.scrollWidth <= button.clientWidth + 1),
			pageOverflowFree:
				document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
		};
	});

	for (const position of backgroundPositions) {
		expect(presentation.backgroundImage).toContain(position);
	}
	expect(presentation.backgroundImage).not.toContain('255, 143, 48');
	expect(presentation.hintsFill).toBe('rgb(255, 204, 0)');
	expect(presentation.incorrectFill).toBe('rgb(255, 46, 166)');
	for (const fontSize of presentation.actionFontSizes) {
		expect(fontSize).toBeGreaterThanOrEqual(14);
	}
	expect(presentation.actionOverflowFree).toBe(true);
	expect(presentation.pageOverflowFree).toBe(true);
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
		const phoneCardGeometry = await page
			.getByTestId('puzzle-card-art')
			.first()
			.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { width: rect.width, height: rect.height, ratio: rect.width / rect.height };
			});
		expect(phoneCardGeometry.ratio).toBeCloseTo(343 / 215, 2);
		const continueTitle = page.locator('.continue-title');
		await expect(continueTitle).toHaveText('Sunset Ridge');
		const continueTitleGeometry = await continueTitle.evaluate((element) => ({
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth
		}));
		expect(continueTitleGeometry.scrollWidth).toBeLessThanOrEqual(
			continueTitleGeometry.clientWidth + 1
		);
		const compactControls = await page
			.locator(
				'[data-testid="arcade-compact-search"]:visible, [data-testid="arcade-mobile-menu-toggle"]:visible, a.compact-avatar:visible'
			)
			.evaluateAll((elements) =>
				elements.map((element) => {
					const rect = element.getBoundingClientRect();
					return { width: rect.width, height: rect.height };
				})
			);
		expect(compactControls).toHaveLength(3);
		for (const control of compactControls) {
			expect(control.width).toBeGreaterThanOrEqual(44);
			expect(control.height).toBeGreaterThanOrEqual(44);
		}
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
		const phoneStatus = await page.getByTestId('phone-status-capsule').evaluate((element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			const backRect = document
				.querySelector<HTMLElement>('[data-testid="back-to-arcade-link"]')
				?.getBoundingClientRect();
			return {
				width: rect.width,
				height: rect.height,
				left: rect.left,
				backRight: backRect?.right ?? 0,
				borderRadius: style.borderRadius,
				borderColor: style.borderColor,
				hasTimer: element.querySelector('[data-testid="game-timer"]') !== null,
				hasPieces: element.querySelector('.hud-pieces') !== null,
				hasProgressRing: element.querySelector('.progress-ring') !== null
			};
		});
		expect(phoneStatus.width).toBeGreaterThanOrEqual(200);
		expect(phoneStatus.height).toBeGreaterThanOrEqual(40);
		expect(phoneStatus.left).toBeGreaterThan(phoneStatus.backRight + 8);
		expect(phoneStatus.borderRadius).toBe('18px');
		expect(phoneStatus.borderColor).toBe('rgb(56, 36, 111)');
		expect(phoneStatus.hasTimer).toBe(true);
		expect(phoneStatus.hasPieces).toBe(true);
		expect(phoneStatus.hasProgressRing).toBe(false);
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
		await installVisualFixtureReference(page);
		await gameplayPage.solveFixture();
		await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		const playAgain = page.getByRole('button', { name: 'PLAY AGAIN' });
		await expect(playAgain).toBeFocused();
		const phoneCompletionGeometry = await page
			.getByTestId('celebration-modal')
			.evaluate((modal) => {
				const box = modal.querySelector<HTMLElement>('.modal-box');
				const stars = box?.querySelector<HTMLElement>('.completion-stars');
				const artwork = box?.querySelector<HTMLElement>('[data-testid="completion-reference-art"]');
				const finalTime = box?.querySelector<HTMLElement>('[data-testid="completion-final-time"]');
				const summary = box?.querySelector<HTMLElement>('[data-testid="completion-run-summary"]');
				const actions = box?.querySelector<HTMLElement>('.modal-actions');
				const boxRect = box?.getBoundingClientRect();
				const viewport = { width: window.innerWidth, height: window.innerHeight };
				const rectInside = (element: HTMLElement | null | undefined) => {
					if (!element || !boxRect) return false;
					const rect = element.getBoundingClientRect();
					return (
						rect.left >= boxRect.left - 1 &&
						rect.right <= boxRect.right + 1 &&
						rect.top >= boxRect.top - 1 &&
						rect.bottom <= boxRect.bottom + 1
					);
				};
				return {
					scrollTop: box?.scrollTop ?? 0,
					scrollHeight: box?.scrollHeight ?? 0,
					clientHeight: box?.clientHeight ?? 0,
					viewport,
					boxFitsViewport:
						boxRect !== undefined &&
						boxRect.left >= 0 &&
						boxRect.right <= viewport.width &&
						boxRect.top >= 0 &&
						boxRect.bottom <= viewport.height,
					starsBeforeArtwork:
						stars !== null &&
						artwork !== null &&
						stars !== undefined &&
						artwork !== undefined &&
						stars.getBoundingClientRect().bottom <= artwork.getBoundingClientRect().top,
					naturalContentVisible: [stars, artwork, finalTime, summary, actions].every(rectInside),
					actionsVisible: actions !== null && actions !== undefined && rectInside(actions),
					actionCount: actions?.querySelectorAll('button').length ?? 0
				};
			});
		expect(phoneCompletionGeometry.scrollTop).toBe(0);
		expect(phoneCompletionGeometry.scrollHeight).toBeLessThanOrEqual(
			phoneCompletionGeometry.clientHeight + 2
		);
		expect(phoneCompletionGeometry.boxFitsViewport).toBe(true);
		expect(phoneCompletionGeometry.starsBeforeArtwork).toBe(true);
		expect(phoneCompletionGeometry.naturalContentVisible).toBe(true);
		expect(phoneCompletionGeometry.actionsVisible).toBe(true);
		expect(phoneCompletionGeometry.actionCount).toBe(2);
		await expect(playAgain).toBeFocused();
		await expect(playAgain).toBeVisible();
		await expectCompletionPresentation(page, ['50% 26%', '12% 82%', '88% 70%']);
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
		await installVisualFixtureReference(page);
		await gameplayPage.solveFixture();
		await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		await expectCompletionPresentation(page, ['50% 12%', '10% 86%', '90% 78%']);
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
		await installVisualFixtureReference(page);
		await gameplayPage.solveFixture();
		await gameplayPage.waitForDialog(/E2E SQUARE 4/i);
		await expectCompletionPresentation(page, ['50% 16%', '8% 88%', '92% 80%']);
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
		await expect(page.getByText('Signal Drift')).toBeVisible();
		await expect(page.getByText('Broken Orbit')).toBeVisible();
		await expect(page.getByTestId('admin-missions-count')).toHaveText('6');
		await expect(page.getByTestId('admin-players-count')).toHaveText('4');
		await expect(page.getByLabel('4 ready')).toBeVisible();
		await expect(page.getByLabel('1 processing')).toBeVisible();
		await expect(page.getByLabel('1 failed')).toBeVisible();
		for (const controls of [
			page.getByRole('button', { name: /^View full image/ }),
			page.getByRole('button', { name: /delete/i })
		]) {
			const bounds = await controls.evaluateAll((elements) =>
				elements.map((element) => {
					const rect = element.getBoundingClientRect();
					return { width: rect.width, height: rect.height };
				})
			);
			for (const bound of bounds) {
				expect(bound.width).toBeGreaterThanOrEqual(44);
				expect(bound.height).toBeGreaterThanOrEqual(44);
			}
		}
		const uploadBounds = await page
			.getByRole('link', { name: 'UPLOAD MISSION' })
			.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return {
					width: rect.width,
					height: rect.height,
					fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
					scrollWidth: element.scrollWidth,
					clientWidth: element.clientWidth
				};
			});
		expect(uploadBounds.height).toBeGreaterThanOrEqual(47);
		expect(uploadBounds.fontSize).toBeGreaterThanOrEqual(14);
		expect(uploadBounds.scrollWidth).toBeLessThanOrEqual(uploadBounds.clientWidth + 1);
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
		const addPlayerBounds = await page
			.getByRole('button', { name: 'ADD PLAYER' })
			.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return {
					width: rect.width,
					height: rect.height,
					fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
					scrollWidth: element.scrollWidth,
					clientWidth: element.clientWidth
				};
			});
		expect(addPlayerBounds.width).toBeGreaterThanOrEqual(183);
		expect(addPlayerBounds.height).toBeGreaterThanOrEqual(47);
		expect(addPlayerBounds.fontSize).toBeGreaterThanOrEqual(14);
		expect(addPlayerBounds.scrollWidth).toBeLessThanOrEqual(addPlayerBounds.clientWidth + 1);
		const removeBounds = await page
			.getByRole('button', { name: /remove pilot@example.com/i })
			.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { width: rect.width, height: rect.height };
			});
		expect(removeBounds.width).toBeGreaterThanOrEqual(44);
		expect(removeBounds.height).toBeGreaterThanOrEqual(44);
		await waitForVisualReady(page);
		await expect(page).toHaveScreenshot('galaxy-admin-player-access.png', {
			maxDiffPixelRatio: 0.005
		});
	});
});
