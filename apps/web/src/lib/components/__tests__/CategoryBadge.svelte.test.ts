import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import CategoryBadge from '../CategoryBadge.svelte';
import { PUZZLE_CATEGORIES, type PuzzleCategory } from '$lib/constants/categories';

const EXPECTED_CATEGORY_ICON: Record<PuzzleCategory, string> = {
	Animals: 'paw',
	Nature: 'leaf',
	Art: 'art',
	Architecture: 'building',
	Abstract: 'abstract',
	Food: 'food',
	Travel: 'compass'
};

describe('CategoryBadge', () => {
	it('renders badge when category is provided', async () => {
		render(CategoryBadge, { category: 'Animals' as PuzzleCategory });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).toBeVisible();
		await expect.element(badge).toHaveTextContent('Animals');
		await expect.element(badge).toHaveAttribute('data-category-icon', 'paw');
	});

	it('renders nothing when category is undefined', async () => {
		render(CategoryBadge, { category: undefined });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).not.toBeInTheDocument();
	});

	it('renders badge for any valid category', async () => {
		render(CategoryBadge, { category: 'Nature' as PuzzleCategory });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).toBeVisible();
		await expect.element(badge).toHaveTextContent('Nature');
	});

	it.each(PUZZLE_CATEGORIES)('maps %s to its decorative icon', async (category) => {
		render(CategoryBadge, { category });

		const badge = page.getByTestId('category-badge');
		await expect
			.element(badge)
			.toHaveAttribute('data-category-icon', EXPECTED_CATEGORY_ICON[category]);
		expect(
			document.querySelector('[data-testid="category-badge"] svg')?.getAttribute('aria-hidden')
		).toBe('true');
	});

	it('keeps the category name accessible in compact mode', async () => {
		render(CategoryBadge, { category: 'Travel', compact: true });

		await expect.element(page.getByTestId('category-badge')).toHaveAccessibleName('Travel');
	});
});
