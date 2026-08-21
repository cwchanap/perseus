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
		const live = document.querySelector('[aria-live="polite"]');
		expect(live).not.toBeNull();
		expect(live?.textContent).toContain('NO SAVED PROGRESS');
	});

	it('surfaces a retryable outage when discovery is incomplete', async () => {
		// complete=false with no rows means a transient 5xx/network failure
		// interrupted discovery — the dialog must NOT claim progress is gone.
		render(SavedProgressDialog, {
			progress: [],
			loading: false,
			complete: false,
			onClose: vi.fn()
		});
		await expect.element(page.getByText('UNABLE TO LOAD SAVED PROGRESS — TRY AGAIN')).toBeVisible();
		expect(document.body.textContent).not.toContain('NO SAVED PROGRESS');
		expect(document.body.textContent).not.toContain('LOADING SAVED PROGRESS');
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

	it('renders a just-started row with zero placed and a nullish-count row without crashing', async () => {
		// A freshly opened puzzle has placedCount 0; the row must still render
		// the "0/N PLACED" label rather than omitting it.
		const zeroRow: GalleryProgress = {
			puzzleId: 'fresh',
			name: 'Fresh Mission',
			source: 'api',
			placedCount: 0,
			pieceCount: 12,
			lastUpdated: 1_000
		};
		// A defensive case: a malformed progress entry with nullish counts must
		// not throw (Svelte renders nullish text interpolations as empty).
		const nullishRow = {
			puzzleId: 'corrupt',
			name: 'Corrupt Mission',
			source: 'api' as const,
			placedCount: undefined as unknown as number,
			pieceCount: undefined as unknown as number,
			lastUpdated: 1_000
		};
		render(SavedProgressDialog, {
			progress: [zeroRow, nullishRow],
			loading: false,
			onClose: vi.fn()
		});

		const fresh = page.getByTestId('saved-progress-row-fresh');
		await expect.element(fresh).toHaveTextContent('0/12 PLACED');
		await expect
			.element(fresh.getByRole('link', { name: 'Continue Fresh Mission' }))
			.toHaveAttribute('href', '/puzzle/fresh');

		const corrupt = page.getByTestId('saved-progress-row-corrupt');
		await expect.element(corrupt).toHaveTextContent('Corrupt Mission');
		await expect
			.element(corrupt.getByRole('link', { name: 'Continue Corrupt Mission' }))
			.toHaveAttribute('href', '/puzzle/corrupt');
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
