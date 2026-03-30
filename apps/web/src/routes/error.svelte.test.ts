import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ErrorPage from './+error.svelte';

// Hoisted mutable page store for controlling $page.status / $page.error
const mockPage = vi.hoisted(() => {
	const subscribers = new Set<(v: unknown) => void>();
	let value: unknown = {
		url: { pathname: '/missing' },
		status: 404,
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

describe('+error.svelte', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPage.set({ url: { pathname: '/missing' }, status: 404, error: null });
	});

	it('displays the HTTP status code', async () => {
		render(ErrorPage);
		await expect.element(page.getByText('404')).toBeVisible();
	});

	it('shows SECTOR NOT FOUND heading for 404 errors', async () => {
		render(ErrorPage);
		await expect.element(page.getByRole('heading', { name: /SECTOR NOT FOUND/i })).toBeVisible();
	});

	it('shows SYSTEM ERROR heading for non-404 errors', async () => {
		mockPage.set({ url: { pathname: '/error' }, status: 500, error: { status: 500 } });
		render(ErrorPage);
		await expect.element(page.getByRole('heading', { name: /SYSTEM ERROR/i })).toBeVisible();
	});

	it('displays the 500 status code', async () => {
		mockPage.set({ url: { pathname: '/error' }, status: 500, error: null });
		render(ErrorPage);
		await expect.element(page.getByText('500')).toBeVisible();
	});

	it('shows network error message for TypeError', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 500,
			error: { name: 'TypeError', status: 500 }
		});
		render(ErrorPage);
		await expect
			.element(page.getByText('Network error. Please check your connection and try again.'))
			.toBeVisible();
	});

	it('shows session expired message for 401 error', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 401,
			error: { status: 401 }
		});
		render(ErrorPage);
		await expect
			.element(page.getByText('Your session has expired. Please log in again.'))
			.toBeVisible();
	});

	it('shows permission denied message for 403 error', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 403,
			error: { status: 403 }
		});
		render(ErrorPage);
		await expect
			.element(page.getByText('You do not have permission to view this page.'))
			.toBeVisible();
	});

	it('shows file too large message for 413 error', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 413,
			error: { status: 413 }
		});
		render(ErrorPage);
		await expect
			.element(page.getByText('That file is too large. Please try a smaller one.'))
			.toBeVisible();
	});

	it('shows server error message for 503 error', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 503,
			error: { status: 503 }
		});
		render(ErrorPage);
		await expect
			.element(page.getByText('The server encountered an error. Please try again later.'))
			.toBeVisible();
	});

	it('shows generic error message for 400-level errors', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 422,
			error: { status: 422 }
		});
		render(ErrorPage);
		await expect.element(page.getByText('Something went wrong. Please try again.')).toBeVisible();
	});

	it('shows fallback message when error has no recognized fields', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 500,
			error: {}
		});
		render(ErrorPage);
		await expect
			.element(page.getByText('An unexpected error occurred. Please try again.'))
			.toBeVisible();
	});

	it('shows fallback message when error is null', async () => {
		mockPage.set({
			url: { pathname: '/error' },
			status: 500,
			error: null
		});
		render(ErrorPage);
		await expect
			.element(page.getByText('An unexpected error occurred. Please try again.'))
			.toBeVisible();
	});

	it('renders return to arcade link', async () => {
		render(ErrorPage);
		await expect.element(page.getByRole('link', { name: /RETURN TO ARCADE/i })).toBeVisible();
	});
});
