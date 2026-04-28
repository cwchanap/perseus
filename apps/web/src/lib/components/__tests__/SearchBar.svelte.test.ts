import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import SearchBar from '../SearchBar.svelte';

describe('SearchBar', () => {
	it('renders a search input with the provided value', async () => {
		render(SearchBar, { value: 'Ocean', onInput: vi.fn() });

		await expect
			.element(page.getByRole('searchbox', { name: 'Search puzzles' }))
			.toHaveValue('Ocean');
	});

	it('calls onInput with the new value when the user types', async () => {
		const onInput = vi.fn();
		render(SearchBar, { value: '', onInput });

		await userEvent.type(page.getByRole('searchbox', { name: 'Search puzzles' }), 'galaxy');

		expect(onInput).toHaveBeenLastCalledWith('galaxy');
	});

	it('exposes an accessible label via role searchbox and name Search puzzles', async () => {
		render(SearchBar, { value: '', onInput: vi.fn() });

		await expect.element(page.getByRole('searchbox', { name: 'Search puzzles' })).toBeVisible();
	});
});
