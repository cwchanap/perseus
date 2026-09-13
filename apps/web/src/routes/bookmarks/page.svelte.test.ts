import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import BookmarksPage from './+page.svelte';
import * as pageConfig from './+page';
import type { PuzzleFamilySummary } from '@perseus/types';

vi.mock('$lib/services/api', () => ({
	getFamilyThumbnailUrl: vi.fn((id: string) => `/api/puzzle-families/${id}/thumbnail`)
}));

vi.mock('$app/paths', () => ({
	resolve: (path: string) => path
}));

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
		}
	};
});

const mockBookmarks = vi.hoisted(() => {
	const subscribers = new Set<(value: unknown) => void>();
	const initial = {
		accountId: null,
		status: 'idle',
		families: [] as unknown[],
		ids: [] as string[],
		error: null,
		pendingIds: [] as string[]
	};
	let value: unknown = initial;

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
		load: vi.fn().mockResolvedValue(undefined),
		toggle: vi.fn().mockResolvedValue(undefined),
		clear: vi.fn()
	};
});

vi.mock('$lib/stores/playerAuth', () => ({
	playerAuth: mockPlayerAuth
}));

vi.mock('$lib/stores/bookmarks', () => ({
	bookmarks: mockBookmarks
}));

const authenticatedAuth = {
	status: 'authenticated' as const,
	user: {
		id: 'player-1',
		email: 'player-1@example.com',
		name: 'Player One',
		createdAt: 1716500000000,
		lastLoginAt: 1716500000000
	},
	error: null
};

const makeFamily = (id: string): PuzzleFamilySummary => ({
	id,
	name: `Puzzle ${id}`,
	aspectRatio: '1:1',
	status: 'ready',
	createdAt: 1000,
	variants: {
		easy: { id: `${id}-e`, difficulty: 'easy', pieceCount: 16, status: 'ready' },
		normal: { id: `${id}-n`, difficulty: 'normal', pieceCount: 169, status: 'ready' },
		hard: { id: `${id}-h`, difficulty: 'hard', pieceCount: 100, status: 'ready' }
	}
});

describe('Bookmarks Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPlayerAuth.set({
			status: 'anonymous',
			user: null,
			error: null
		});
		mockBookmarks.set({
			accountId: null,
			status: 'idle',
			families: [],
			ids: [],
			error: null,
			pendingIds: []
		});
	});

	it('declares the static-adapter prerender contract', () => {
		expect(pageConfig.prerender).toBe(false);
	});

	it('shows a pending state while auth is loading', async () => {
		mockPlayerAuth.set({
			status: 'loading',
			user: null,
			error: null
		});

		render(BookmarksPage);

		await expect.element(page.getByTestId('bookmarks-auth-loading')).toBeVisible();
		expect(mockBookmarks.load).not.toHaveBeenCalled();
	});

	it('shows a sign-in prompt for anonymous players without loading bookmarks', async () => {
		render(BookmarksPage);

		await expect
			.element(page.getByTestId('bookmarks-sign-in').getByRole('link', { name: 'Sign in' }))
			.toBeVisible();
		expect(mockBookmarks.load).not.toHaveBeenCalled();
	});

	it('shows a loading state while bookmarks load', async () => {
		mockPlayerAuth.set(authenticatedAuth);
		mockBookmarks.set({
			accountId: 'player-1',
			status: 'loading',
			families: [],
			ids: [],
			error: null,
			pendingIds: []
		});

		render(BookmarksPage);

		await expect.element(page.getByTestId('bookmarks-loading')).toBeVisible();
		await vi.waitFor(() => expect(mockBookmarks.load).toHaveBeenCalledOnce());
	});

	it('shows an empty state for a player with no bookmarks', async () => {
		mockPlayerAuth.set(authenticatedAuth);
		mockBookmarks.set({
			accountId: 'player-1',
			status: 'loaded',
			families: [],
			ids: [],
			error: null,
			pendingIds: []
		});

		render(BookmarksPage);

		await expect.element(page.getByTestId('bookmarks-empty')).toBeVisible();
	});

	it('renders bookmarked families with store-driven card state', async () => {
		mockPlayerAuth.set(authenticatedAuth);
		mockBookmarks.set({
			accountId: 'player-1',
			status: 'loaded',
			families: [makeFamily('f1')],
			ids: ['f1'],
			error: null,
			pendingIds: []
		});

		render(BookmarksPage);

		await expect.element(page.getByTestId('bookmarks-grid')).toBeVisible();
		await expect.element(page.getByTestId('puzzle-card-title')).toHaveTextContent('Puzzle f1');
		await expect.element(page.getByRole('button', { name: 'Remove bookmark' })).toBeVisible();
	});

	it('shows a mutation error banner even when bookmarks are loaded', async () => {
		mockPlayerAuth.set(authenticatedAuth);
		mockBookmarks.set({
			accountId: 'player-1',
			status: 'loaded',
			families: [makeFamily('f1')],
			ids: ['f1'],
			error: 'bookmark_limit_reached',
			pendingIds: []
		});

		render(BookmarksPage);

		// Mutation errors surface independently of load status so a failed
		// toggle (e.g. the 409 quota response) is still visible.
		await expect
			.element(page.getByTestId('bookmarks-mutation-error'))
			.toHaveTextContent('bookmark_limit_reached');
		await expect
			.element(page.getByTestId('bookmarks-mutation-error'))
			.toHaveAttribute('role', 'alert');
		await expect.element(page.getByTestId('bookmarks-grid')).toBeVisible();
	});

	it('shows the store error with a retry that reloads', async () => {
		mockPlayerAuth.set(authenticatedAuth);
		mockBookmarks.set({
			accountId: 'player-1',
			status: 'error',
			families: [],
			ids: [],
			error: 'Failed to load bookmarks',
			pendingIds: []
		});

		render(BookmarksPage);

		await expect
			.element(page.getByTestId('bookmarks-error'))
			.toHaveTextContent('Failed to load bookmarks');
		// The load failure renders once: no duplicate mutation-error banner.
		expect(page.getByTestId('bookmarks-mutation-error').query()).toBeNull();
		await expect.element(page.getByTestId('bookmarks-error')).toHaveAttribute('role', 'alert');
		await page.getByTestId('bookmarks-retry').click();
		expect(mockBookmarks.load).toHaveBeenCalledTimes(2);
	});

	it('removes a bookmark through the shared store toggle', async () => {
		const family = makeFamily('f1');
		mockPlayerAuth.set(authenticatedAuth);
		mockBookmarks.set({
			accountId: 'player-1',
			status: 'loaded',
			families: [family],
			ids: ['f1'],
			error: null,
			pendingIds: []
		});

		render(BookmarksPage);

		await page.getByRole('button', { name: 'Remove bookmark' }).click();
		expect(mockBookmarks.toggle).toHaveBeenCalledExactlyOnceWith(family);
	});
});
