import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import ArcadeShell from '../ArcadeShell.svelte';

const authenticatedProps = {
	currentPath: '/',
	authStatus: 'authenticated' as const,
	playerDisplayName: 'Alex C.',
	score: 900,
	rank: 38,
	onLogout: vi.fn(),
	children: createRawSnippet(() => ({
		render: () => '<span data-testid="shell-child">child</span>',
		setup: () => {}
	}))
};

describe('ArcadeShell', () => {
	it('activates the persistent sidebar only at 1440px', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			await page.viewport(1439, 900);
			render(ArcadeShell, authenticatedProps);
			const sidebar = await page.getByTestId('arcade-sidebar').element();
			expect(getComputedStyle(sidebar).display).toBe('none');

			await page.viewport(1440, 900);
			expect(getComputedStyle(sidebar).display).not.toBe('none');
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});

	it('renders arcade navigation and authenticated score and rank', async () => {
		await page.viewport(1440, 900);
		render(ArcadeShell, authenticatedProps);

		for (const name of ['Arcade', 'Ranks', 'Upload', 'Quick', 'Profile']) {
			await expect.element(page.getByRole('link', { name, exact: true })).toBeVisible();
		}
		await expect.element(page.getByTestId('arcade-score')).toHaveTextContent('900');
		await expect.element(page.getByTestId('arcade-rank')).toHaveTextContent('#38');
		await expect.element(page.getByTestId('shell-child')).toBeVisible();
	});

	it('fills the desktop content area beside the fixed sidebar', async () => {
		await page.viewport(1440, 900);
		render(ArcadeShell, authenticatedProps);

		const sidebar = await page.getByTestId('arcade-sidebar').element();
		const content = document.querySelector<HTMLElement>('.arcade-content');
		expect(content).not.toBeNull();
		const sidebarRect = sidebar.getBoundingClientRect();
		const contentRect = content!.getBoundingClientRect();

		expect(sidebarRect.width).toBe(232);
		expect(contentRect.left).toBe(232);
		expect(contentRect.right).toBe(window.innerWidth);
	});

	it('preserves a single main landmark when route content provides one', async () => {
		await page.viewport(1440, 900);
		render(ArcadeShell, {
			...authenticatedProps,
			children: createRawSnippet(() => ({
				render: () => '<main data-testid="shell-main-child">child</main>',
				setup: () => {}
			}))
		});

		expect(document.querySelectorAll('main')).toHaveLength(1);
		await expect.element(page.getByTestId('shell-main-child')).toBeVisible();
	});

	it('keeps the compact navigation available below the sidebar breakpoint', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			await page.viewport(390, 844);
			render(ArcadeShell, authenticatedProps);
			await expect.element(page.getByTestId('arcade-mobile-nav')).toBeVisible();
			await expect.element(page.getByTestId('arcade-sidebar')).not.toBeVisible();
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});
});
