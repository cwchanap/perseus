import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SavedProgressDialog from '../SavedProgressDialog.svelte';
import type { GalleryProgress } from '$lib/services/gameplay/galleryProgress';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

const progress: GalleryProgress[] = [
	{
		puzzleId: 'old-save',
		name: 'Older Mission',
		source: 'api',
		placedCount: 3,
		pieceCount: 12,
		lastUpdated: 1_000
	}
];

describe('SavedProgressDialog', () => {
	it('renders loading and empty states', async () => {
		const view = render(SavedProgressDialog, { progress: [], loading: true, onClose: vi.fn() });
		await expect.element(page.getByText('LOADING SAVED PROGRESS...')).toBeVisible();
		await view.rerender({ progress: [], loading: false, onClose: vi.fn() });
		await expect.element(page.getByText('NO SAVED PROGRESS')).toBeVisible();
	});

	it('renders a semantic row with a distinguishable Continue link', async () => {
		render(SavedProgressDialog, { progress, loading: false, onClose: vi.fn() });
		const list = page.getByRole('list');
		await expect.element(list).toBeVisible();
		const row = page.getByTestId('saved-progress-row-old-save');
		await expect.element(row).toHaveTextContent('Older Mission');
		await expect.element(row).toHaveTextContent('3/12 PLACED');
		await expect
			.element(row.getByRole('link', { name: 'Continue Older Mission' }))
			.toHaveAttribute('href', '/puzzle/old-save');
	});

	it('closes from Close and Escape', async () => {
		const onClose = vi.fn();
		render(SavedProgressDialog, { progress, loading: false, onClose });
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		expect(onClose).toHaveBeenCalledTimes(1);
		const dialog = await page.getByRole('dialog', { name: 'Saved progress' }).element();
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
