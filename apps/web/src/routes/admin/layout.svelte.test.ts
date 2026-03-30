import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import AdminLayout from './+layout.svelte';
import { checkSession } from '$lib/services/api';
import { goto } from '$app/navigation';

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

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
}));

vi.mock('$lib/services/api', () => ({
	checkSession: vi.fn()
}));

function makeChildren(text = 'child-content') {
	return createRawSnippet(() => ({
		render: () => `<span data-testid="child-content">${text}</span>`,
		setup: () => {}
	}));
}

describe('Admin Layout', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPage.set({ url: { pathname: '/admin' }, status: 200, error: null });
	});

	it('renders children immediately on the login page without checking session', async () => {
		mockPage.set({ url: { pathname: '/admin/login' }, status: 200, error: null });
		render(AdminLayout, { children: makeChildren() });

		await expect.element(page.getByTestId('child-content')).toBeVisible();
	});

	it('shows checking/loading state while session check is in flight', async () => {
		// Never resolves during this test
		vi.mocked(checkSession).mockReturnValue(new Promise(() => {}));

		render(AdminLayout, { children: makeChildren() });

		await expect.element(page.getByRole('status')).toBeVisible();
		await expect.element(page.getByText(/VERIFYING ACCESS/i)).toBeVisible();
	});

	it('renders children after session check confirms authentication', async () => {
		vi.mocked(checkSession).mockResolvedValue(true);

		render(AdminLayout, { children: makeChildren() });

		await expect.element(page.getByTestId('child-content')).toBeVisible();
	});

	it('redirects to /admin/login when session check returns false', async () => {
		vi.mocked(checkSession).mockResolvedValue(false);

		render(AdminLayout, { children: makeChildren() });

		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/admin/login');
		});
	});

	it('redirects to /admin/login when session check throws', async () => {
		vi.mocked(checkSession).mockRejectedValue(new Error('Network error'));

		render(AdminLayout, { children: makeChildren() });

		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/admin/login');
		});
	});

	it('shows redirecting state after unauthenticated session check', async () => {
		vi.mocked(checkSession).mockResolvedValue(false);

		render(AdminLayout, { children: makeChildren() });

		await vi.waitFor(async () => {
			await expect.element(page.getByText(/REDIRECTING/i)).toBeVisible();
		});
	});
});
