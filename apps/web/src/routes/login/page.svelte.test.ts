import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LoginPage from './+page.svelte';
import { getGoogleLoginUrl } from '$lib/services/api';

const mockPage = vi.hoisted(() => {
	const subscribers = new Set<(value: unknown) => void>();
	let value: unknown = {
		url: new URL('https://perseus.test/login'),
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

vi.mock('$app/stores', () => ({
	page: mockPage
}));

vi.mock('$app/paths', () => ({
	resolve: (path: string) => path
}));

vi.mock('$lib/services/api', () => ({
	getGoogleLoginUrl: vi.fn(() => '/api/auth/google/start?returnTo=%2F')
}));

function setLoginUrl(search = '') {
	mockPage.set({
		url: new URL(`https://perseus.test/login${search}`),
		status: 200,
		error: null,
		params: {},
		route: { id: null }
	});
}

describe('Player Login Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setLoginUrl();
		vi.mocked(getGoogleLoginUrl).mockReturnValue('/api/auth/google/start?returnTo=%2F');
	});

	it('shows not allowed errors and the Google sign in link', async () => {
		setLoginUrl('?error=not_allowed');

		render(LoginPage);

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect
			.element(page.getByText('This Google account is not on the player access list.'))
			.toBeVisible();
		await expect
			.element(page.getByRole('link', { name: /sign in with google/i }))
			.toHaveAttribute('href', '/api/auth/google/start?returnTo=%2F');
		expect(getGoogleLoginUrl).toHaveBeenCalledWith('/');
	});

	it('does not show an alert when error is missing', async () => {
		render(LoginPage);

		await expect.poll(() => page.getByRole('alert').query()).toBeNull();
	});

	it('does not show an alert when error is unknown', async () => {
		setLoginUrl('?error=unknown');

		render(LoginPage);

		await expect.poll(() => page.getByRole('alert').query()).toBeNull();
	});
});
