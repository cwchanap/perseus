import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import ProfileLayout from './+layout.svelte';
import { goto } from '$app/navigation';

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

vi.mock('$app/paths', () => ({
	base: '',
	resolve: (p: string) => p
}));

// Mutable playerAuth store mock so individual tests can set the auth state.
const mockPlayerAuth = vi.hoisted(() => {
	const subscribers = new Set<(v: unknown) => void>();
	let value: unknown = { status: 'loading', user: null, error: null };
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

vi.mock('$lib/stores/playerAuth', () => ({
	playerAuth: mockPlayerAuth
}));

function makeChildren(text = 'child-content') {
	return createRawSnippet(() => ({
		render: () => `<span data-testid="child-content">${text}</span>`,
		setup: () => {}
	}));
}

describe('Profile Layout guard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPlayerAuth.set({ status: 'loading', user: null, error: null });
	});

	it('shows a checking state while playerAuth is loading', async () => {
		render(ProfileLayout, { children: makeChildren() });
		await expect.element(page.getByText('VERIFYING ACCESS…')).toBeVisible();
		// Children must NOT render while loading.
		expect(page.getByTestId('child-content').elements()).toHaveLength(0);
	});

	it('renders children when playerAuth is authenticated', async () => {
		mockPlayerAuth.set({
			status: 'authenticated',
			user: { id: 'p1', email: 'e', name: 'P', picture: null, createdAt: 1, lastLoginAt: 2 },
			error: null
		});
		render(ProfileLayout, { children: makeChildren() });
		await expect.element(page.getByTestId('child-content')).toBeVisible();
	});

	it('redirects to /login and does not render children when anonymous', async () => {
		mockPlayerAuth.set({ status: 'anonymous', user: null, error: null });
		render(ProfileLayout, { children: makeChildren() });
		await expect.element(page.getByText('REDIRECTING…')).toBeVisible();
		expect(vi.mocked(goto)).toHaveBeenCalledWith('/login');
		// Children must NOT render for anonymous users.
		expect(page.getByTestId('child-content').elements()).toHaveLength(0);
	});
});
