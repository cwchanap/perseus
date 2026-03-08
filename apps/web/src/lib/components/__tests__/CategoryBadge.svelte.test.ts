import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import CategoryBadge from '../CategoryBadge.svelte';
import type { PuzzleCategory } from '$lib/types/puzzle';

describe('CategoryBadge', () => {
	it('renders badge when category is provided', async () => {
		render(CategoryBadge, { category: 'Animals' as PuzzleCategory });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).toBeVisible();
		await expect.element(badge).toHaveTextContent('Animals');
	});

	it('renders nothing when category is undefined', async () => {
		render(CategoryBadge, { category: undefined });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).not.toBeInTheDocument();
	});

	it('applies the cat-badge class for Nature category', async () => {
		render(CategoryBadge, { category: 'Nature' as PuzzleCategory });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).toHaveClass('cat-badge');
	});
});
