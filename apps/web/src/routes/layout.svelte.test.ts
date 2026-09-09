import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import RootLayout from './+layout.svelte';
import { playerAuth } from '$lib/stores/playerAuth';

const mockProgression = vi.hoisted(() => vi.fn());

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

vi.mock('$lib/services/api', () => ({
	getPlayerProgression: mockProgression
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
		mockProgression.mockResolvedValue({
			score: 900,
			rank: 38,
			easyClears: 0,
			normalClears: 0,
			hardClears: 0,
			achievementsUnlocked: 0,
			achievementsTotal: 0,
			masteryEarned: 0
		});
		setPathname('/');
		mockPlayerAuth.set({
			status: 'anonymous',
			user: null,
			error: null
		});
	});

	it('renders anonymous player navigation and refreshes auth on mount', async () => {
		render(RootLayout, { children: makeChildren() });

		await page.getByTestId('arcade-mobile-menu-toggle').click();
		await expect.element(page.getByTestId('arcade-mobile-nav')).toBeVisible();
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

		await page.getByTestId('arcade-mobile-menu-toggle').click();
		await expect.element(page.getByTestId('arcade-mobile-nav')).toBeVisible();
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

		await expect
			.element(page.getByTestId('arcade-mobile-header').getByLabelText('Profile for Player One'))
			.toBeVisible();
		await page.getByTestId('arcade-mobile-menu-toggle').click();
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

			await page.getByTestId('arcade-mobile-menu-toggle').click();
			await page.getByRole('button', { name: /SIGN OUT/i }).click();

			expect(playerAuth.logout).toHaveBeenCalledOnce();
			await vi.waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith('Failed to sign out player', logoutError);
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it('bypasses the player shell on puzzle routes', async () => {
		setPathname('/puzzle/puzzle-1');

		render(RootLayout, { children: makeChildren() });

		await expect.poll(() => page.getByTestId('arcade-shell').query()).toBeNull();
		await expect.element(page.getByTestId('layout-child')).toBeVisible();
	});

	it('bypasses the player shell on admin routes', async () => {
		setPathname('/admin');

		render(RootLayout, { children: makeChildren() });

		await expect.poll(() => page.getByTestId('arcade-shell').query()).toBeNull();
		await expect.element(page.getByTestId('layout-child')).toBeVisible();
	});

	it('keeps route content mounted while shell chrome toggles', async () => {
		render(RootLayout, { children: makeChildren() });
		const child = await page.getByTestId('layout-child').element();

		setPathname('/puzzle/puzzle-1');
		await expect.poll(() => page.getByTestId('arcade-shell').query()).toBeNull();
		expect(await page.getByTestId('layout-child').element()).toBe(child);

		setPathname('/leaderboard');
		await expect.element(page.getByTestId('arcade-shell')).toBeVisible();
		expect(await page.getByTestId('layout-child').element()).toBe(child);
	});

	it('uses the player shell on ordinary routes', async () => {
		setPathname('/leaderboard');

		render(RootLayout, { children: makeChildren() });

		await expect.element(page.getByTestId('arcade-shell')).toBeVisible();
		await expect.element(page.getByTestId('layout-child')).toBeVisible();
	});

	it('keeps shell navigation usable when progression rejects', async () => {
		const progressionError = new Error('progression unavailable');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mockProgression.mockRejectedValue(progressionError);
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
			await expect.element(page.getByTestId('arcade-shell')).toBeVisible();
			await page.getByTestId('arcade-mobile-menu-toggle').click();
			await expect.element(page.getByTestId('leaderboard-link')).toBeVisible();
			await vi.waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith(
					'Failed to load shell progression',
					progressionError
				);
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it('refetches progression when authenticated navigation changes routes', async () => {
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
		await vi.waitFor(() => expect(mockProgression).toHaveBeenCalledTimes(1));

		setPathname('/leaderboard');
		await vi.waitFor(() => expect(mockProgression).toHaveBeenCalledTimes(2));
	});

	it('aborts a superseded progression request', async () => {
		const signals: AbortSignal[] = [];
		mockProgression.mockImplementation((signal: AbortSignal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
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
		await vi.waitFor(() => expect(mockProgression).toHaveBeenCalledTimes(1));

		setPathname('/upload');
		await vi.waitFor(() => expect(mockProgression).toHaveBeenCalledTimes(2));
		expect(signals[0]?.aborted).toBe(true);
	});
});
