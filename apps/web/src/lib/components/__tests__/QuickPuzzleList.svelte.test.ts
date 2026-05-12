import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import QuickPuzzleList from '../QuickPuzzleList.svelte';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';

function makeStored(overrides: Partial<StoredQuickPuzzle> = {}): StoredQuickPuzzle {
	return {
		id: 'q-a',
		name: 'Test',
		pieceCount: 24,
		gridRows: 4,
		gridCols: 6,
		imageWidth: 100,
		imageHeight: 100,
		imageDataUrl: 'data:image/jpeg;base64,/9j/AAAA',
		pieces: [],
		createdAt: Date.now(),
		schemaVersion: 1,
		...overrides
	};
}

describe('QuickPuzzleList', () => {
	it('renders empty state when list is empty', async () => {
		render(QuickPuzzleList, { puzzles: [], onDelete: vi.fn() });
		await expect.element(page.getByTestId('quick-list-empty')).toBeInTheDocument();
	});

	it('renders one row per puzzle with name and piece count', async () => {
		render(QuickPuzzleList, {
			puzzles: [
				makeStored({ id: 'q-a', name: 'Beach' }),
				makeStored({ id: 'q-b', name: 'Forest', pieceCount: 48 })
			],
			onDelete: vi.fn()
		});
		await expect.element(page.getByText('Beach')).toBeInTheDocument();
		await expect.element(page.getByText('Forest')).toBeInTheDocument();
		await expect.element(page.getByText(/24 pieces/)).toBeInTheDocument();
		await expect.element(page.getByText(/48 pieces/)).toBeInTheDocument();
	});

	it('uses imageDataUrl for the thumbnail', async () => {
		render(QuickPuzzleList, {
			puzzles: [makeStored({ imageDataUrl: 'data:image/jpeg;base64,XYZ' })],
			onDelete: vi.fn()
		});
		const thumbnail = await page.getByTestId('quick-list-thumb-q-a').element();
		expect((thumbnail as HTMLImageElement).src).toContain('data:image/jpeg;base64,XYZ');
	});

	it('calls onDelete when the delete button is clicked', async () => {
		const onDelete = vi.fn();
		render(QuickPuzzleList, { puzzles: [makeStored({ id: 'q-x' })], onDelete });
		await page.getByTestId('quick-list-delete-q-x').click();
		expect(onDelete).toHaveBeenCalledWith('q-x');
	});

	it('row has a link to /puzzle/<id>', async () => {
		render(QuickPuzzleList, { puzzles: [makeStored({ id: 'q-link' })], onDelete: vi.fn() });
		const link = await page.getByTestId('quick-list-link-q-link').element();
		expect((link as HTMLAnchorElement).getAttribute('href')).toContain('/puzzle/q-link');
	});
});
