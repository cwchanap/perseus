// Component test for PuzzleCard (family catalog card)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleCard from '../PuzzleCard.svelte';
import { getFamilyThumbnailUrl } from '$lib/services/api';
import type { PuzzleFamilySummary } from '@perseus/types';

describe('PuzzleCard', () => {
	const mockFamily: PuzzleFamilySummary = {
		id: 'fam-test',
		name: 'Test Puzzle',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1000,
		variants: {
			easy: { id: 'var-e', difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: 'var-n', difficulty: 'normal', pieceCount: 49, status: 'ready' },
			hard: { id: 'var-h', difficulty: 'hard', pieceCount: 100, status: 'ready' }
		}
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should render puzzle name', async () => {
		render(PuzzleCard, { family: mockFamily });

		await expect.element(page.getByText('Test Puzzle')).toBeVisible();
	});

	it('exposes the full family name as a title on the truncated heading', async () => {
		render(PuzzleCard, {
			family: { ...mockFamily, name: 'A Very Long Mission Name That Truncates' }
		});

		await expect
			.element(page.getByTestId('puzzle-card-title'))
			.toHaveAttribute('title', 'A Very Long Mission Name That Truncates');
	});

	it('renders an art-first card with a compact category icon and three actions', async () => {
		render(PuzzleCard, { family: { ...mockFamily, category: 'Nature' } });

		await expect.element(page.getByTestId('puzzle-card-art')).toBeVisible();
		await expect.element(page.getByTestId('puzzle-card-title')).toBeVisible();
		await expect
			.element(page.getByTestId('category-badge'))
			.toHaveAttribute('data-category-icon', 'leaf');
		await expect.element(page.getByTestId('difficulty-action').nth(2)).toBeVisible();
	});

	it('shows difficulty picker with three actions', async () => {
		render(PuzzleCard, { family: mockFamily });

		await expect.element(page.getByTestId('difficulty-picker')).toBeVisible();
		await expect.element(page.getByTestId('difficulty-action').nth(2)).toBeVisible();
	});

	it('marks a difficulty with saved progress without a text-heavy action', async () => {
		const progress = new Map([['var-e', { placedCount: 7, pieceCount: 16 }]]);
		render(PuzzleCard, { family: mockFamily, progressByVariantId: progress });

		await expect.element(page.getByTestId('difficulty-progress')).toMatchTextContent('7/16');
		await expect
			.element(
				page.getByRole('link', {
					name: 'Easy difficulty, 16 pieces, continue saved progress 7/16'
				})
			)
			.toBeVisible();
		await expect.element(page.getByTestId('card-progress')).toMatchTextContent('7/16');
		const progressBadge = await page.getByTestId('card-progress').element();
		expect(progressBadge.getAttribute('aria-label')).toBeNull();
		expect(page.getByTestId('card-mastery').query()).toBeNull();
	});

	it('should render thumbnail image with correct alt text', async () => {
		render(PuzzleCard, { family: mockFamily });

		const img = (await page.getByTestId('puzzle-card-art').element()).querySelector(
			'img'
		) as HTMLImageElement;
		expect(img.getAttribute('alt')).toBe('Test Puzzle');
		expect(img.getAttribute('src')).toBe(getFamilyThumbnailUrl(mockFamily.id));
	});

	it('hides the failed thumbnail from assistive tech and exposes No preview instead', async () => {
		// The errored img stays mounted (opacity-hidden) so a new src can
		// recover, but opacity alone leaves it in the accessibility tree —
		// announced as the puzzle's artwork while the aria-hidden placeholder
		// said nothing. Mirror the completion dialog: the failed img is
		// aria-hidden and "No preview" is exposed instead.
		render(PuzzleCard, { family: mockFamily });

		const img = (await page.getByTestId('puzzle-card-art').element()).querySelector(
			'img'
		) as HTMLImageElement;
		expect(img).not.toBeNull();
		img.dispatchEvent(new Event('error', { bubbles: true }));

		const placeholder = page.getByTestId('puzzle-card-art-placeholder');
		await expect.element(placeholder).toHaveTextContent('No preview');
		await expect.poll(() => img.getAttribute('aria-hidden')).toBe('true');
		expect(page.getByRole('img', { name: 'Test Puzzle' }).query()).toBeNull();
		expect((await placeholder.element()).getAttribute('aria-hidden')).toBeNull();
	});

	it('should render category badge when family has a category', async () => {
		const familyWithCategory: PuzzleFamilySummary = {
			...mockFamily,
			category: 'Animals'
		};
		render(PuzzleCard, { family: familyWithCategory });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).toBeVisible();
		await expect.element(badge).toHaveAttribute('aria-label', 'Animals');
		await expect.element(badge).toHaveAttribute('data-category-icon', 'paw');
	});

	it('should render a non-clickable card with status overlay for processing families', async () => {
		const processingFamily: PuzzleFamilySummary = {
			...mockFamily,
			status: 'processing',
			variants: {
				easy: { ...mockFamily.variants.easy, status: 'processing' },
				normal: { ...mockFamily.variants.normal, status: 'processing' },
				hard: { ...mockFamily.variants.hard, status: 'processing' }
			}
		};
		render(PuzzleCard, { family: processingFamily });

		await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
		await expect.element(page.getByText('PROCESSING…')).toBeVisible();
	});

	it('should render FAILED label for failed families', async () => {
		const failedFamily: PuzzleFamilySummary = {
			...mockFamily,
			status: 'failed',
			variants: {
				easy: { ...mockFamily.variants.easy, status: 'failed' },
				normal: { ...mockFamily.variants.normal, status: 'failed' },
				hard: { ...mockFamily.variants.hard, status: 'failed' }
			}
		};
		render(PuzzleCard, { family: failedFamily });

		await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
		await expect.element(page.getByText('FAILED')).toBeVisible();
	});

	it('exposes add and remove accessible states on the bookmark button', async () => {
		const { unmount } = await render(PuzzleCard, {
			family: mockFamily,
			bookmarked: false,
			onBookmarkToggle: () => {}
		});
		await expect
			.element(page.getByRole('button', { name: 'Add bookmark: Test Puzzle' }))
			.toBeVisible();
		await unmount();

		render(PuzzleCard, { family: mockFamily, bookmarked: true, onBookmarkToggle: () => {} });
		await expect
			.element(page.getByRole('button', { name: 'Remove bookmark: Test Puzzle' }))
			.toBeVisible();
	});

	it('passes the family to the toggle callback on click', async () => {
		const onBookmarkToggle = vi.fn();
		render(PuzzleCard, { family: mockFamily, onBookmarkToggle });

		await page.getByRole('button', { name: 'Add bookmark: Test Puzzle' }).click();

		expect(onBookmarkToggle).toHaveBeenCalledOnce();
		expect(onBookmarkToggle).toHaveBeenCalledWith(mockFamily);
	});

	it('disables the bookmark button while pending', async () => {
		render(PuzzleCard, {
			family: mockFamily,
			bookmarkPending: true,
			onBookmarkToggle: () => {}
		});

		await expect
			.element(page.getByRole('button', { name: 'Add bookmark: Test Puzzle' }))
			.toBeDisabled();
	});

	it('keeps difficulty links intact and hides the bookmark action without a callback', async () => {
		const { unmount } = await render(PuzzleCard, { family: mockFamily, bookmarked: true });
		expect(page.getByTestId('card-bookmark').query()).toBeNull();
		await unmount();

		render(PuzzleCard, { family: mockFamily, onBookmarkToggle: () => {} });
		await expect.element(page.getByTestId('card-bookmark')).toBeVisible();
		const actions = page.getByTestId('difficulty-action');
		await expect.element(actions.nth(0)).toHaveAttribute('href', '/puzzle/var-e');
		await expect.element(actions.nth(1)).toHaveAttribute('href', '/puzzle/var-n');
		await expect.element(actions.nth(2)).toHaveAttribute('href', '/puzzle/var-h');
	});

	it('renders no cleared badge or status stack without a cleared difficulty', async () => {
		const { unmount } = await render(PuzzleCard, { family: mockFamily });
		expect(page.getByTestId('card-cleared-difficulty').query()).toBeNull();
		expect(page.getByTestId('card-status-stack').query()).toBeNull();
		await unmount();

		render(PuzzleCard, { family: mockFamily, highestClearedDifficulty: null });
		expect(page.getByTestId('card-cleared-difficulty').query()).toBeNull();
		expect(page.getByTestId('card-status-stack').query()).toBeNull();
	});

	it.each([
		['easy', 'Easy', 1, 16],
		['normal', 'Normal', 2, 49],
		['hard', 'Hard', 3, 100]
	] as const)(
		'renders the %s cleared difficulty badge with matching gems and no piece count',
		async (difficulty, label, gemCount, pieceCount) => {
			render(PuzzleCard, { family: mockFamily, highestClearedDifficulty: difficulty });

			await expect
				.element(page.getByRole('img', { name: `Highest cleared difficulty: ${label}` }))
				.toBeVisible();
			const badge = await page.getByTestId('card-cleared-difficulty').element();
			expect(badge.querySelectorAll('[data-testid="difficulty-gem"]')).toHaveLength(gemCount);
			expect(
				badge.querySelector('[data-testid="difficulty-gems"]')?.getAttribute('data-difficulty')
			).toBe(difficulty);
			expect(badge.textContent).not.toContain(String(pieceCount));
		}
	);

	it('keeps piece counts visible in the picker gems while the badge stays compact', async () => {
		render(PuzzleCard, { family: mockFamily, highestClearedDifficulty: 'hard' });

		const picker = await page.getByTestId('difficulty-picker').element();
		expect(picker.textContent).toContain('100');
		const badge = await page.getByTestId('card-cleared-difficulty').element();
		expect(badge.textContent).not.toContain('100');
	});

	it('renders progress-only and clear-only layouts inside the status stack', async () => {
		const { unmount } = await render(PuzzleCard, {
			family: mockFamily,
			progressByVariantId: new Map([['var-e', { placedCount: 7, pieceCount: 16 }]])
		});
		const progressStack = await page.getByTestId('card-status-stack').element();
		expect(progressStack.querySelector('[data-testid="card-progress"]')).not.toBeNull();
		expect(progressStack.querySelector('[data-testid="card-cleared-difficulty"]')).toBeNull();
		await unmount();

		render(PuzzleCard, { family: mockFamily, highestClearedDifficulty: 'normal' });
		await expect.element(page.getByTestId('card-cleared-difficulty')).toBeVisible();
		const clearStack = await page.getByTestId('card-status-stack').element();
		expect(clearStack.querySelector('[data-testid="card-cleared-difficulty"]')).not.toBeNull();
		expect(clearStack.querySelector('[data-testid="card-progress"]')).toBeNull();
	});

	it('renders clear and progress states together inside one status stack', async () => {
		render(PuzzleCard, {
			family: mockFamily,
			highestClearedDifficulty: 'hard',
			progressByVariantId: new Map([['var-e', { placedCount: 7, pieceCount: 16 }]]),
			onBookmarkToggle: () => {}
		});

		const stack = await page.getByTestId('card-status-stack').element();
		expect(stack.querySelector('[data-testid="card-cleared-difficulty"]')).not.toBeNull();
		expect(stack.querySelector('[data-testid="card-progress"]')).not.toBeNull();
		await expect
			.element(page.getByRole('button', { name: 'Add bookmark: Test Puzzle' }))
			.toBeVisible();
		await expect.element(page.getByTestId('difficulty-action')).toHaveLength(3);
	});

	it('keeps the status stack clear of the title row and category badge at 390x844', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			await page.viewport(390, 844);
			render(PuzzleCard, {
				family: { ...mockFamily, category: 'Nature' },
				highestClearedDifficulty: 'hard',
				progressByVariantId: new Map([['var-e', { placedCount: 7, pieceCount: 16 }]]),
				onBookmarkToggle: () => {}
			});

			const intersects = (a: DOMRect, b: DOMRect) =>
				a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			const rectOf = (testId: string) => page.getByTestId(testId).element().getBoundingClientRect();
			const stack = rectOf('card-status-stack');

			expect(intersects(stack, rectOf('puzzle-card-title'))).toBe(false);
			expect(intersects(stack, rectOf('card-bookmark'))).toBe(false);
			expect(intersects(stack, rectOf('card-category-status'))).toBe(false);
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});

	it('resets thumbnail state to pending via update() when the family prop URL changes on a mounted card', async () => {
		const rendered = await render(PuzzleCard, { family: mockFamily });

		const img = (await page.getByTestId('puzzle-card-art').element()).querySelector(
			'img'
		) as HTMLImageElement;
		expect(img).not.toBeNull();
		// Drive the error state directly: the vitest server's answer to the
		// fake thumbnail URL is an HTML fallback whose first (cold) fetch can
		// outlast expect.poll's default timeout.
		img.dispatchEvent(new Event('error', { bubbles: true }));
		await expect.poll(() => img.dataset.imageState).toBe('error');
		await expect
			.element(page.getByTestId('puzzle-card-art-placeholder'))
			.toHaveTextContent('No preview');

		// Record every data-image-state transition on the SAME mounted <img> so a
		// fast 404 on the next URL still proves update() reset state to pending.
		const observedStates: string[] = [];
		const observer = new MutationObserver(() => {
			if (img.dataset.imageState) observedStates.push(img.dataset.imageState);
		});
		observer.observe(img, { attributes: true, attributeFilter: ['data-image-state'] });

		try {
			await rendered.rerender({
				family: { ...mockFamily, id: 'fam-next', name: 'Next Puzzle' }
			});
			expect(observedStates[0]).toBe('pending');
			expect(img.isConnected).toBe(true);
			expect(img.getAttribute('src')).toBe(getFamilyThumbnailUrl('fam-next'));
		} finally {
			observer.disconnect();
		}
	});
});
