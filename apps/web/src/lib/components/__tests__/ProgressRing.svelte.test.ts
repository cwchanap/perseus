import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ProgressRing from '../ProgressRing.svelte';

describe('ProgressRing', () => {
	it.each([
		[-20, '0'],
		[38, '38'],
		[140, '100']
	])('clamps %s to %s', async (percent, value) => {
		render(ProgressRing, { percent, label: 'Puzzle progress' });

		const ring = page.getByRole('progressbar');
		await expect.element(ring).toHaveAttribute('aria-valuemin', '0');
		await expect.element(ring).toHaveAttribute('aria-valuemax', '100');
		await expect.element(ring).toHaveAttribute('aria-valuenow', value);
		await expect.element(ring).toHaveAccessibleName('Puzzle progress');
	});

	it('can hide the visible percentage while retaining its accessible label', async () => {
		render(ProgressRing, { percent: 38, label: 'Puzzle progress', showValue: false });

		await expect.element(page.getByRole('progressbar')).toBeVisible();
		await expect.element(page.getByText('38')).not.toBeInTheDocument();
	});
});
