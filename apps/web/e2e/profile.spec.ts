import { test, expect } from '@playwright/test';

test('profile page redirects anonymous users to login', async ({ page }) => {
	await page.goto('/profile');
	await expect(page).toHaveURL(/\/login/);
});

test('authenticated profile shows identity and stats', async ({ page }) => {
	// This test requires seeding a `perseus_player_session` cookie.
	// Mark as fixme until a player-auth e2e fixture exists.
	test.fixme();
});
