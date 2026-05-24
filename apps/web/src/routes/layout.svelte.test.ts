import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import RootLayout from './+layout.svelte';
import { playerAuth } from '$lib/stores/playerAuth';

const mockPage = vi.hoisted(() => {
	const subscribers = new Set<(value: unknown) => void>();
	let value: unknown = {
		url: new URL('https://perseus.test/'),
		status: 200,
		error: null,
		params: {},
		route: { id: null }
	};

	return {
		subscribe(fn: (value: unknown) => void) {
			fn(value);
			subscribers.add(fn);
			return () => {
				subscribers.delete(fn);
			};
		},
		set(nextValue: unknown) {
			value = nextValue;
			subscribers.forEach((fn) => fn(value));
		}
	};
});

const mockPlayerAuth = vi.hoisted(() => {
	const subscribers = new Set<(value: unknown) => void>();
	let value: unknown = {
		status: 'anonymous',
		user: null,
		error: null
	};

	return {
		subscribe(fn: (value: unknown) => void) {
			fn(value);
			subscribers.add(fn);
			return () => {
				subscribers.delete(fn);
			};
		},
		set(nextValue: unknown) {
			value = nextValue;
			subscribers.forEach((fn) => fn(value));
		},
		refresh: vi.fn().mockResolvedValue(undefined),
		logout: vi.fn().mockResolvedValue(undefined)
	};
});

vi.mock('$app/stores', () => ({
	page: mockPage
}));

vi.mock('$app/paths', () => ({
	resolve: (path: string) => path
}));

vi.mock('$lib/stores/playerAuth', () => ({
	playerAuth: mockPlayerAuth
}));

function setPathname(pathname: string) {
	mockPage.set({
		url: new URL(`https://perseus.test${pathname}`),
		status: 200,
		error: null,
		params: {},
		route: { id: null }
	});
}

function makeChildren() {
	return createRawSnippet(() => ({
		render: () => '<span data-testid="layout-child">child</span>',
		setup: () => {}
	}));
}

describe('Root Layout', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setPathname('/');
		mockPlayerAuth.set({
			status: 'anonymous',
			user: null,
			error: null
		});
	});

	it('renders anonymous player navigation and refreshes auth on mount', async () => {
		render(RootLayout, { children: makeChildren() });

		await expect.element(page.getByLabelText('Player navigation')).toBeVisible();
		await expect.element(page.getByTestId('quick-puzzle-link')).toBeVisible();
		await expect.element(page.getByRole('link', { name: /SIGN IN/i })).toBeVisible();
		await vi.waitFor(() => {
			expect(playerAuth.refresh).toHaveBeenCalledOnce();
		});
	});

	it('does not show SIGN IN while auth status is loading', async () => {
		mockPlayerAuth.set({
			status: 'loading',
			user: null,
			error: null
		});

		render(RootLayout, { children: makeChildren() });

		await expect.element(page.getByLabelText('Player navigation')).toBeVisible();
		await expect.element(page.getByRole('link', { name: /SIGN IN/i })).not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: /SIGN OUT/i })).not.toBeInTheDocument();
	});

	it('renders authenticated user navigation and signs out', async () => {
		mockPlayerAuth.set({
			status: 'authenticated',
			user: {
				id: 'player-1',
				email: 'player@example.com',
				name: 'Player One',
				createdAt: 1779530400000,
				lastLoginAt: 1779530400000
			},
			error: null
		});

		render(RootLayout, { children: makeChildren() });

		await expect.element(page.getByText('Player One')).toBeVisible();
		await page.getByRole('button', { name: /SIGN OUT/i }).click();
		expect(playerAuth.logout).toHaveBeenCalledOnce();
	});

	it('catches rejected player sign out attempts', async () => {
		const logoutError = new Error('logout failed');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(playerAuth.logout).mockRejectedValue(logoutError);
		mockPlayerAuth.set({
			status: 'authenticated',
			user: {
				id: 'player-1',
				email: 'player@example.com',
				name: 'Player One',
				createdAt: 1779530400000,
				lastLoginAt: 1779530400000
			},
			error: null
		});

		try {
			render(RootLayout, { children: makeChildren() });

			await page.getByRole('button', { name: /SIGN OUT/i }).click();

			expect(playerAuth.logout).toHaveBeenCalledOnce();
			await vi.waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith('Failed to sign out player', logoutError);
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it('hides player navigation on puzzle routes', async () => {
		setPathname('/puzzle/puzzle-1');

		render(RootLayout, { children: makeChildren() });

		await expect.poll(() => page.getByLabelText('Player navigation').query()).toBeNull();
	});
});
