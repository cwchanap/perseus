import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import CategoryFilter from '../CategoryFilter.svelte';
import { PUZZLE_CATEGORIES, CATEGORY_ALL } from '$lib/constants/categories';

// CategoryFilter reads `navigating` to resync its click intent once
// navigation settles; outside a router an always-idle object keeps the
// resync effect a plain `chosen = selected` tracker.
vi.mock('$app/state', () => ({
	navigating: { to: null, from: null, type: null, willUnload: null, delta: null, complete: null }
}));

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

	it('uses compact icon badges without losing radio names', async () => {
		render(CategoryFilter, { selected: CATEGORY_ALL, onSelect: vi.fn() });

		await expect.element(page.getByTestId('category-badge')).toHaveLength(PUZZLE_CATEGORIES.length);
		for (let i = 0; i < PUZZLE_CATEGORIES.length; i++) {
			await expect.element(page.getByRole('radio', { name: PUZZLE_CATEGORIES[i] })).toBeVisible();
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

	// Labeled chips are gated on a measured wide-header breakpoint. The
	// gallery header gives the auto-sized categories column at most ~50rem
	// (80rem layout − 4rem padding − 26rem search) once it is capped, so the
	// labels only appear where the full labeled row plus the always-open
	// wide search still fit without the fieldset scrolling.
	const WIDE_BREAKPOINT_PX = 1201; // 75.0625rem — first viewport past the compact header
	const WIDE_CATEGORY_BUDGET_PX = 50 * 16; // measured categories column at >= 90rem

	it('keeps icon-only chips below the wide breakpoint and reveals aria-hidden labels above it', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			await page.viewport(1024, 800);
			render(CategoryFilter, { selected: CATEGORY_ALL, onSelect: vi.fn() });

			const filter = page.getByTestId('category-filter');
			await expect.element(filter).toBeVisible();
			const chip = (await filter.element()).querySelector('.category-icon-chip') as HTMLElement;
			expect(getComputedStyle(chip.querySelector('.category-chip-label')!).display).toBe('none');
			// Compact presentation preserved: fixed-width icon chip, native
			// radio still named and checkable.
			expect(chip.getBoundingClientRect().width).toBeLessThanOrEqual(44);
			await expect.element(page.getByRole('radio', { name: 'Architecture' })).toBeVisible();

			await page.viewport(WIDE_BREAKPOINT_PX, 800);
			const labels = (await filter.element()).querySelectorAll('.category-chip-label');
			expect(labels).toHaveLength(PUZZLE_CATEGORIES.length);
			for (let i = 0; i < PUZZLE_CATEGORIES.length; i++) {
				const label = labels[i] as HTMLElement;
				expect(label.textContent).toBe(PUZZLE_CATEGORIES[i]);
				expect(label.getAttribute('aria-hidden')).toBe('true');
				expect(getComputedStyle(label).display).not.toBe('none');
			}
			// Labels are filter-local and aria-hidden: the radio's accessible
			// name still comes from the label's badge text, not duplicated.
			for (const cat of PUZZLE_CATEGORIES) {
				await expect.element(page.getByRole('radio', { name: cat })).toBeInTheDocument();
			}
			// Card badge chips stay icon-only: the fixed width is only relaxed
			// on .category-icon-chip, and only inside this component.
			expect(getComputedStyle(chip).width).not.toBe('44px');
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});

	it('fits all labeled chips without horizontal scrolling at 1440px and just above the breakpoint', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			for (const width of [1440, WIDE_BREAKPOINT_PX]) {
				await page.viewport(width, 900);
				const { unmount } = await render(CategoryFilter, {
					selected: CATEGORY_ALL,
					onSelect: vi.fn(),
					total: 128
				});
				const filter = (await page.getByTestId('category-filter').element()) as HTMLElement;
				// Constrain the fieldset to the measured categories column so the
				// assertion tracks the real wide-header budget, not the viewport.
				const column = document.createElement('div');
				column.style.width = `${WIDE_CATEGORY_BUDGET_PX}px`;
				filter.parentElement!.insertBefore(column, filter);
				column.appendChild(filter);
				// In production the radios are clipped to 1px and add no width;
				// this harness has no Tailwind, so subtract whatever their
				// rendered boxes contribute before comparing to the budget.
				const radioWidth = [...filter.querySelectorAll('input[type="radio"]')].reduce(
					(sum, input) => sum + (input as HTMLElement).getBoundingClientRect().width,
					0
				);
				const chipRowWidth = filter.scrollWidth - radioWidth;
				expect(chipRowWidth).toBeLessThanOrEqual(filter.clientWidth);
				expect(chipRowWidth).toBeLessThanOrEqual(WIDE_CATEGORY_BUDGET_PX);
				column.replaceWith(filter);
				unmount();
			}
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});
});
