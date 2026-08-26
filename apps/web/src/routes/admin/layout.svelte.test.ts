import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import AdminLayout from './+layout.svelte';
import {
	forceAdminDocumentNavigation,
	isClientRoutedAdminPath
} from '$lib/services/adminNavigation';

// Hoisted mutable page store so individual tests can set the URL
const mockPage = vi.hoisted(() => {
	const subscribers = new Set<(v: unknown) => void>();
	let value: unknown = {
		url: { pathname: '/admin' },
		status: 200,
		error: null,
		params: {},
		route: { id: null }
	};
	return {
		subscribe(fn: (v: unknown) => void) {
			fn(value);
			subscribers.add(fn);
			return () => {
				subscribers.delete(fn);
			};
		},
		set(v: unknown) {
			value = v;
			subscribers.forEach((fn) => fn(value));
		}
	};
});

vi.mock('$app/stores', () => ({
	page: mockPage
}));

vi.mock('$app/paths', () => ({
	base: '',
	resolve: (p: string) => p
}));

vi.mock('$lib/services/adminNavigation', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/adminNavigation')>();
	return {
		...actual,
		forceAdminDocumentNavigation: vi.fn(),
		isClientRoutedAdminPath: vi.fn(() => false)
	};
});

function makeChildren(text = 'child-content') {
	return createRawSnippet(() => ({
		render: () => `<span data-testid="child-content">${text}</span>`,
		setup: () => {}
	}));
}

describe('Admin Layout', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isClientRoutedAdminPath).mockReturnValue(false);
		mockPage.set({ url: { pathname: '/admin' }, status: 200, error: null });
	});

	it('renders children after deciding no document navigation is needed', async () => {
		render(AdminLayout, { children: makeChildren() });

		await expect.element(page.getByTestId('child-content')).toBeVisible();
		expect(isClientRoutedAdminPath).toHaveBeenCalledWith('/admin');
		expect(forceAdminDocumentNavigation).not.toHaveBeenCalled();
	});

	it('keeps children blocked while forcing a client-routed document navigation', async () => {
		vi.mocked(isClientRoutedAdminPath).mockReturnValue(true);

		render(AdminLayout, { children: makeChildren() });

		await vi.waitFor(() => {
			expect(forceAdminDocumentNavigation).toHaveBeenCalledWith(
				expect.objectContaining({ pathname: '/admin' })
			);
		});
		await expect.poll(() => page.getByTestId('child-content').query()).toBeNull();
	});
});
