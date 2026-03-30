import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LoginPage from './+page.svelte';
import { login, ApiError } from '$lib/services/api';
import { goto } from '$app/navigation';

vi.mock('$lib/services/api', () => {
	class MockApiError extends Error {
		status: number;
		error: string;
		constructor(status: number, error: string, message: string) {
			super(message);
			this.name = 'ApiError';
			this.status = status;
			this.error = error;
		}
	}
	return {
		login: vi.fn(),
		ApiError: MockApiError
	};
});

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

vi.mock('$app/paths', () => ({
	resolve: (path: string) => path
}));

describe('Admin Login Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the admin access heading', async () => {
		render(LoginPage);
		await expect.element(page.getByRole('heading', { name: /ADMIN ACCESS/i })).toBeVisible();
	});

	it('renders the passkey input', async () => {
		render(LoginPage);
		await expect.element(page.getByLabelText(/PASSKEY/i)).toBeVisible();
	});

	it('renders back to arcade link', async () => {
		render(LoginPage);
		await expect.element(page.getByRole('link', { name: /BACK TO ARCADE/i })).toBeVisible();
	});

	it('authenticate button is disabled when passkey is empty', async () => {
		render(LoginPage);
		await expect.element(page.getByRole('button', { name: /AUTHENTICATE/i })).toBeDisabled();
	});

	it('authenticate button is enabled when passkey is entered', async () => {
		render(LoginPage);
		await page.getByLabelText(/PASSKEY/i).fill('mypasskey');
		await expect.element(page.getByRole('button', { name: /AUTHENTICATE/i })).toBeEnabled();
	});

	it('navigates to /admin after successful login', async () => {
		vi.mocked(login).mockResolvedValue({ success: true });

		render(LoginPage);
		await page.getByLabelText(/PASSKEY/i).fill('correct-passkey');
		await page.getByRole('button', { name: /AUTHENTICATE/i }).click();

		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/admin');
		});
	});

	it('shows error message when login fails with ApiError', async () => {
		vi.mocked(login).mockRejectedValue(new ApiError(401, 'unauthorized', 'Invalid passkey'));

		render(LoginPage);
		await page.getByLabelText(/PASSKEY/i).fill('wrongkey');
		await page.getByRole('button', { name: /AUTHENTICATE/i }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByText('Invalid passkey')).toBeVisible();
	});

	it('shows generic error when login throws non-ApiError', async () => {
		vi.mocked(login).mockRejectedValue(new Error('Network failure'));

		render(LoginPage);
		await page.getByLabelText(/PASSKEY/i).fill('something');
		await page.getByRole('button', { name: /AUTHENTICATE/i }).click();

		await expect.element(page.getByText('Failed to connect to server')).toBeVisible();
	});
});
