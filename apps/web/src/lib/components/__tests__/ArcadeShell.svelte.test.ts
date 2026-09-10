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

const unknownProgressProps = {
	...authenticatedProps,
	score: null,
	rank: null
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

	it('exposes known desktop score and rank as ordinary accessible text', async () => {
		await page.viewport(1440, 900);
		render(ArcadeShell, authenticatedProps);

		await expect.element(page.getByTestId('arcade-score')).toHaveTextContent('900');
		await expect.element(page.getByTestId('arcade-rank')).toHaveTextContent('#38');
		expect(document.querySelector('.score-card')).not.toHaveAttribute('aria-label');
	});

	it('exposes known compact score as ordinary accessible text', async () => {
		await page.viewport(390, 844);
		render(ArcadeShell, authenticatedProps);

		await expect.element(page.getByTestId('arcade-compact-score')).toHaveTextContent('900');
		expect(document.querySelector('.compact-score')).not.toHaveAttribute('aria-label');
	});

	it('keeps unknown desktop score and rank as visible dashes without announcing zero', async () => {
		await page.viewport(1440, 900);
		render(ArcadeShell, unknownProgressProps);

		await expect.element(page.getByTestId('arcade-score')).toHaveTextContent('—');
		await expect.element(page.getByTestId('arcade-rank')).toHaveTextContent('#—');
		const cardText = document.querySelector('.score-card')?.textContent ?? '';
		expect(cardText).not.toContain('0');
		expect(document.querySelector('.score-card')).not.toHaveAttribute('aria-label');
	});

	it('keeps unknown compact score as a visible dash without announcing zero', async () => {
		await page.viewport(390, 844);
		render(ArcadeShell, unknownProgressProps);

		await expect.element(page.getByTestId('arcade-compact-score')).toHaveTextContent('—');
		const compactText = document.querySelector('.compact-score')?.textContent ?? '';
		expect(compactText).not.toContain('0');
		expect(document.querySelector('.compact-score')).not.toHaveAttribute('aria-label');
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
			await expect.element(page.getByTestId('arcade-mobile-nav')).toBeInTheDocument();
			await page.getByTestId('arcade-mobile-menu-toggle').click();
			await expect
				.element(page.getByTestId('arcade-mobile-nav').getByRole('link', { name: 'Ranks' }))
				.toHaveAttribute('href', '/leaderboard');
			await expect.element(page.getByTestId('arcade-sidebar')).not.toBeVisible();
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});

	it('shows the gallery compact search for an anonymous player on mobile', async () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			await page.viewport(390, 844);
			render(ArcadeShell, {
				...authenticatedProps,
				authStatus: 'anonymous' as const,
				currentPath: '/'
			});

			const search = await page.getByTestId('arcade-compact-search').element();
			await expect.element(page.getByTestId('arcade-compact-search')).toBeVisible();
			expect(search.getAttribute('aria-label')).toBe('Search puzzles');
			// Usable: clicking invokes openGallerySearch without throwing even when
			// the gallery disclosure is absent in this isolated shell render.
			await page.getByTestId('arcade-compact-search').click();
		} finally {
			await page.viewport(originalWidth, originalHeight);
		}
	});
});
