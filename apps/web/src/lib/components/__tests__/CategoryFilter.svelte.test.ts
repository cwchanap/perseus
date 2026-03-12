import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import CategoryFilter from '../CategoryFilter.svelte';
import { PUZZLE_CATEGORIES, CATEGORY_ALL } from '$lib/constants/categories';

describe('CategoryFilter', () => {
	it('renders a radio option for each category including All', async () => {
		render(CategoryFilter, { selected: CATEGORY_ALL, onSelect: vi.fn() });

		const filter = page.getByTestId('category-filter');
		await expect.element(filter).toBeVisible();

		// All + each puzzle category
		const allButtons = page.getByRole('radio');
		await expect.element(allButtons.nth(0)).toHaveAccessibleName(CATEGORY_ALL);
		for (let i = 0; i < PUZZLE_CATEGORIES.length; i++) {
			await expect.element(allButtons.nth(i + 1)).toHaveAccessibleName(PUZZLE_CATEGORIES[i]);
		}
	});

	it('marks only the selected radio as checked', async () => {
		render(CategoryFilter, { selected: 'Animals', onSelect: vi.fn() });

		const animalsButton = page.getByRole('radio', { name: 'Animals' });
		await expect.element(animalsButton).toBeChecked();

		const allButton = page.getByRole('radio', { name: CATEGORY_ALL });
		await expect.element(allButton).not.toBeChecked();
	});

	it('calls onSelect with the category when a button is clicked', async () => {
		const onSelect = vi.fn();
		render(CategoryFilter, { selected: CATEGORY_ALL, onSelect });

		const natureButton = page.getByRole('radio', { name: 'Nature' });
		await natureButton.click();

		expect(onSelect).toHaveBeenCalledWith('Nature');
	});

	it('calls onSelect with All when the All button is clicked', async () => {
		const onSelect = vi.fn();
		render(CategoryFilter, { selected: 'Animals', onSelect });

		const allButton = page.getByRole('radio', { name: CATEGORY_ALL });
		await allButton.click();

		expect(onSelect).toHaveBeenCalledWith(CATEGORY_ALL);
	});

	it('uses a shared native radio name for grouping', async () => {
		render(CategoryFilter, { selected: 'Animals', onSelect: vi.fn() });

		const radios = page.getByRole('radio');
		for (let i = 0; i <= PUZZLE_CATEGORIES.length; i++) {
			await expect.element(radios.nth(i)).toHaveAttribute('name', 'puzzle-category');
		}
	});
});
