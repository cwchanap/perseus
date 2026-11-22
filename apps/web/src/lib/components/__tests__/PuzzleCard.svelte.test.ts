// Component test for PuzzleCard (family catalog card)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
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

	it('clamps the title to two lines and bottom-aligns it with the bookmark', async () => {
		render(PuzzleCard, {
			family: {
				...mockFamily,
				name: 'An Exceptionally Long Puzzle Family Name That Wraps Beyond One Line'
			},
			onBookmarkToggle: () => {}
		});

		const title = page.getByTestId('puzzle-card-title');
		await expect.element(title).toBeVisible();
		const titleEl = (await title.element()) as HTMLElement;
		const titleStyle = getComputedStyle(titleEl);
		// layout.css is imported above, so these are the production styles:
		// two-line clamp, no fixed height, bottom-aligned absolute row.
		expect(titleStyle.getPropertyValue('-webkit-line-clamp')).toBe('2');
		expect(titleEl.className).not.toMatch(/min-h|h-\[/);

		const row = titleEl.parentElement as HTMLElement;
		const rowStyle = getComputedStyle(row);
		expect(rowStyle.position).toBe('absolute');
		expect(rowStyle.alignItems).toMatch(/^(flex|flow)-end$/);
	});

	it('keeps the status stack clear of the title row and category badge at 390x844 (ready and processing)', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		const intersects = (a: DOMRect, b: DOMRect) =>
			a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
		// Every edge inside the art box, not just the bottom.
		const containedBy = (inner: DOMRect, outer: DOMRect) =>
			inner.left >= outer.left &&
			inner.right <= outer.right &&
			inner.top >= outer.top &&
			inner.bottom <= outer.bottom;
		const rectOf = (testId: string) => page.getByTestId(testId).element().getBoundingClientRect();
		// Mobile gallery: viewport minus 1.125rem padding on both sides.
		const GALLERY_CARD_390 = 390 - 2 * 18;
		try {
			await page.viewport(390, 844);

			const ready = await render(PuzzleCard, {
				family: {
					...mockFamily,
					category: 'Nature',
					name: 'An Exceptionally Long Puzzle Family Name That Wraps To Two Lines'
				},
				highestClearedDifficulty: 'hard',
				progressByVariantId: new Map([['var-e', { placedCount: 7, pieceCount: 16 }]]),
				onBookmarkToggle: () => {}
			});
			const readyCard = (await page.getByTestId('puzzle-card').element()) as HTMLElement;
			readyCard.style.width = `${GALLERY_CARD_390}px`;

			const stack = rectOf('card-status-stack');
			const art = rectOf('puzzle-card-art');
			const title = rectOf('puzzle-card-title');
			const bookmark = rectOf('card-bookmark');
			const category = rectOf('card-category-status');

			expect(intersects(stack, title)).toBe(false);
			expect(intersects(stack, bookmark)).toBe(false);
			expect(intersects(stack, category)).toBe(false);
			// Two-line clamp grows upward from the bottom row: the title and
			// bookmark stay fully inside the art area and never collide.
			expect(intersects(title, bookmark)).toBe(false);
			expect(containedBy(title, art)).toBe(true);
			expect(containedBy(bookmark, art)).toBe(true);
			expect(containedBy(stack, art)).toBe(true);
			expect(containedBy(category, art)).toBe(true);
			ready.unmount();

			// Processing card at the same footprint: centered overlay text must
			// not collide with the title row or bookmark.
			render(PuzzleCard, {
				family: {
					...mockFamily,
					category: 'Nature',
					status: 'processing',
					name: 'An Exceptionally Long Puzzle Family Name That Wraps To Two Lines',
					variants: {
						easy: { ...mockFamily.variants.easy, status: 'processing' },
						normal: { ...mockFamily.variants.normal, status: 'processing' },
						hard: { ...mockFamily.variants.hard, status: 'processing' }
					}
				},
				onBookmarkToggle: () => {}
			});
			const processingCard = (await page.getByTestId('puzzle-card').element()) as HTMLElement;
			processingCard.style.width = `${GALLERY_CARD_390}px`;

			const pArt = rectOf('puzzle-card-art');
			const pTitle = rectOf('puzzle-card-title');
			const pBookmark = rectOf('card-bookmark');
			const overlay = await page.getByTestId('card-status-overlay').element();
			const overlayText = (overlay.querySelector('span') as HTMLElement).getBoundingClientRect();

			await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
			expect(intersects(overlayText, pTitle)).toBe(false);
			expect(intersects(overlayText, pBookmark)).toBe(false);
			expect(intersects(pTitle, pBookmark)).toBe(false);
			expect(containedBy(pTitle, pArt)).toBe(true);
			expect(containedBy(pBookmark, pArt)).toBe(true);
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});

	it.each([
		['1:1', 'ready'],
		['4:3', 'processing']
	] as const)(
		'keeps the two-line title clear of the category badge at the 171px Bookmarks/Profile footprint (%s, %s)',
		async (aspectRatio, status) => {
			const originalWidth = window.innerWidth;
			const originalHeight = window.innerHeight;
			const intersects = (a: DOMRect, b: DOMRect) =>
				a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			const containedBy = (inner: DOMRect, outer: DOMRect) =>
				inner.left >= outer.left &&
				inner.right <= outer.right &&
				inner.top >= outer.top &&
				inner.bottom <= outer.bottom;
			const rectOf = (testId: string) => page.getByTestId(testId).element().getBoundingClientRect();
			try {
				// /bookmarks and /profile both use grid-cols-2 gap-4 at 390px:
				// (390 - 2*18 padding - 16 gap) / 2 = 171px cards.
				await page.viewport(390, 844);

				const onBookmarkToggle = vi.fn();
				render(PuzzleCard, {
					family: {
						...mockFamily,
						category: 'Nature',
						aspectRatio,
						status,
						name: 'An Exceptionally Long Puzzle Family Name That Wraps To Two Lines',
						variants:
							status === 'processing'
								? {
										easy: { ...mockFamily.variants.easy, status: 'processing' },
										normal: { ...mockFamily.variants.normal, status: 'processing' },
										hard: { ...mockFamily.variants.hard, status: 'processing' }
									}
								: mockFamily.variants
					},
					highestClearedDifficulty: status === 'ready' ? 'hard' : undefined,
					progressByVariantId:
						status === 'ready'
							? new Map([['var-e', { placedCount: 7, pieceCount: 16 }]])
							: undefined,
					onBookmarkToggle
				});
				const card = (await page.getByTestId('puzzle-card').element()) as HTMLElement;
				card.style.width = '171px';

				const art = rectOf('puzzle-card-art');
				const title = rectOf('puzzle-card-title');
				const bookmark = rectOf('card-bookmark');
				const category = rectOf('card-category-status');

				// The two-line title must clear the top-left category badge and
				// stay inside the art alongside the bookmark.
				expect(intersects(title, category)).toBe(false);
				expect(intersects(title, bookmark)).toBe(false);
				expect(containedBy(title, art)).toBe(true);
				expect(containedBy(bookmark, art)).toBe(true);
				expect(containedBy(category, art)).toBe(true);

				if (status === 'ready') {
					const stack = rectOf('card-status-stack');
					expect(intersects(stack, title)).toBe(false);
					expect(intersects(stack, bookmark)).toBe(false);
					expect(containedBy(stack, art)).toBe(true);
				}

				// Activation, not just visibility: physical clicks must reach the
				// bookmark button (and, when ready, the difficulty links).
				await page.getByRole('button', { name: /Add bookmark:/ }).click();
				expect(onBookmarkToggle).toHaveBeenCalledOnce();
				if (status === 'ready') {
					const easyLink = (await page
						.getByRole('link', { name: /Easy difficulty/ })
						.element()) as HTMLAnchorElement;
					expect(easyLink.getAttribute('href')).toBe('/puzzle/var-e');
				}
			} finally {
				await page.viewport(originalWidth, originalHeight);
			}
		}
	);

	it('keeps title, bookmark and actions usable on 640px three-column cards (ready and processing)', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		const intersects = (a: DOMRect, b: DOMRect) =>
			a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
		const containedBy = (inner: DOMRect, outer: DOMRect) =>
			inner.left >= outer.left &&
			inner.right <= outer.right &&
			inner.top >= outer.top &&
			inner.bottom <= outer.bottom;
		const rectOf = (testId: string) => page.getByTestId(testId).element().getBoundingClientRect();
		try {
			await page.viewport(640, 800);

			// Ready card: real difficulty links plus clear/progress badges.
			const onBookmarkToggle = vi.fn();
			const ready = await render(PuzzleCard, {
				family: {
					...mockFamily,
					category: 'Abstract',
					name: 'An Exceptionally Long Puzzle Family Name That Wraps To Two Lines'
				},
				highestClearedDifficulty: 'normal',
				progressByVariantId: new Map([['var-e', { placedCount: 7, pieceCount: 16 }]]),
				onBookmarkToggle
			});
			// Three-column grid at 640px lands cards at ~180px squares.
			const readyCard = (await page.getByTestId('puzzle-card').element()) as HTMLElement;
			readyCard.style.width = '180px';

			const art = rectOf('puzzle-card-art');
			const title = rectOf('puzzle-card-title');
			const bookmark = rectOf('card-bookmark');
			const stack = rectOf('card-status-stack');

			expect(intersects(title, bookmark)).toBe(false);
			expect(intersects(stack, title)).toBe(false);
			expect(intersects(stack, bookmark)).toBe(false);
			expect(intersects(stack, rectOf('card-category-status'))).toBe(false);
			expect(containedBy(title, art)).toBe(true);
			expect(containedBy(bookmark, art)).toBe(true);
			expect(containedBy(stack, art)).toBe(true);

			// Activation, not just visibility: a physical click must reach the
			// bookmark button and the hard-difficulty link at this footprint.
			await page.getByRole('button', { name: /Add bookmark:/ }).click();
			expect(onBookmarkToggle).toHaveBeenCalledOnce();

			const hardLink = (await page
				.getByRole('link', { name: /Hard difficulty/ })
				.element()) as HTMLAnchorElement;
			expect(hardLink.getAttribute('href')).toBe('/puzzle/var-h');
			let linkActivated = false;
			hardLink.addEventListener('click', (e) => {
				linkActivated = true;
				e.preventDefault();
			});
			await page.getByRole('link', { name: /Hard difficulty/ }).click();
			expect(linkActivated).toBe(true);
			ready.unmount();

			// Processing card: centered overlay text must not collide with the
			// title row, and actions are unavailable groups, not links.
			const onProcessingBookmark = vi.fn();
			render(PuzzleCard, {
				family: {
					...mockFamily,
					category: 'Abstract',
					status: 'processing',
					name: 'An Exceptionally Long Puzzle Family Name That Wraps To Two Lines',
					variants: {
						easy: { ...mockFamily.variants.easy, status: 'processing' },
						normal: { ...mockFamily.variants.normal, status: 'processing' },
						hard: { ...mockFamily.variants.hard, status: 'processing' }
					}
				},
				onBookmarkToggle: onProcessingBookmark
			});
			const processingCard = (await page.getByTestId('puzzle-card').element()) as HTMLElement;
			processingCard.style.width = '180px';

			const pArt = rectOf('puzzle-card-art');
			const pTitle = rectOf('puzzle-card-title');
			const pBookmark = rectOf('card-bookmark');
			const overlay = await page.getByTestId('card-status-overlay').element();
			const overlayText = (overlay.querySelector('span') as HTMLElement).getBoundingClientRect();

			await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
			expect(intersects(overlayText, pTitle)).toBe(false);
			expect(intersects(overlayText, pBookmark)).toBe(false);
			expect(intersects(pTitle, pBookmark)).toBe(false);
			expect(containedBy(pTitle, pArt)).toBe(true);
			expect(containedBy(pBookmark, pArt)).toBe(true);
			// The dimming overlay is pointer-events-none, so the bookmark must
			// still receive a physical click underneath it.
			await page.getByRole('button', { name: /Add bookmark:/ }).click();
			expect(onProcessingBookmark).toHaveBeenCalledOnce();
			expect(page.getByRole('link', { name: /difficulty/ }).query()).toBeNull();
			const unavailable = page.getByTestId('difficulty-action').nth(2);
			await expect.element(unavailable).toBeVisible();
			expect((await unavailable.element()).tagName).toBe('DIV');
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
