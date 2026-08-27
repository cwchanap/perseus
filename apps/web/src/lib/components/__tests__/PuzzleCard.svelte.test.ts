// Component test for PuzzleCard (family catalog card)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleCard from '../PuzzleCard.svelte';
import { getFamilyThumbnailUrl } from '$lib/services/api';
import type { PuzzleFamilySummary } from '@perseus/types';

describe('PuzzleCard', () => {
	const mockFamily: PuzzleFamilySummary = {
		id: 'fam-test',
		name: 'Test Puzzle',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1000,
		variants: {
			easy: { id: 'var-e', difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: 'var-n', difficulty: 'normal', pieceCount: 49, status: 'ready' },
			hard: { id: 'var-h', difficulty: 'hard', pieceCount: 100, status: 'ready' }
		}
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should render puzzle name', async () => {
		render(PuzzleCard, { family: mockFamily });

		await expect.element(page.getByText('Test Puzzle')).toBeVisible();
	});

	it('shows difficulty picker with three actions', async () => {
		render(PuzzleCard, { family: mockFamily });

		await expect.element(page.getByTestId('difficulty-picker')).toBeVisible();
		await expect.element(page.getByTestId('difficulty-action').nth(2)).toBeVisible();
	});

	it('shows Continue on a difficulty with saved progress', async () => {
		const progress = new Map([['var-e', { placedCount: 7, pieceCount: 16 }]]);
		render(PuzzleCard, { family: mockFamily, progressByVariantId: progress });

		await expect.element(page.getByText('CONTINUE 7/16')).toBeVisible();
	});

	it('should render thumbnail image with correct alt text', async () => {
		render(PuzzleCard, { family: mockFamily });

		const img = page.getByRole('img');
		await expect.element(img).toHaveAttribute('alt', 'Test Puzzle');
		await expect.element(img).toHaveAttribute('src', getFamilyThumbnailUrl(mockFamily.id));
	});

	it('should render category badge when family has a category', async () => {
		const familyWithCategory: PuzzleFamilySummary = {
			...mockFamily,
			category: 'Animals'
		};
		render(PuzzleCard, { family: familyWithCategory });

		const badge = page.getByTestId('category-badge');
		await expect.element(badge).toBeVisible();
		await expect.element(badge).toHaveTextContent('Animals');
	});

	it('should render a non-clickable card with status overlay for processing families', async () => {
		const processingFamily: PuzzleFamilySummary = {
			...mockFamily,
			status: 'processing',
			variants: {
				easy: { ...mockFamily.variants.easy, status: 'processing' },
				normal: { ...mockFamily.variants.normal, status: 'processing' },
				hard: { ...mockFamily.variants.hard, status: 'processing' }
			}
		};
		render(PuzzleCard, { family: processingFamily });

		await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
		await expect.element(page.getByText('PROCESSING…')).toBeVisible();
	});

	it('should render FAILED label for failed families', async () => {
		const failedFamily: PuzzleFamilySummary = {
			...mockFamily,
			status: 'failed',
			variants: {
				easy: { ...mockFamily.variants.easy, status: 'failed' },
				normal: { ...mockFamily.variants.normal, status: 'failed' },
				hard: { ...mockFamily.variants.hard, status: 'failed' }
			}
		};
		render(PuzzleCard, { family: failedFamily });

		await expect.element(page.getByTestId('card-status-overlay')).toBeVisible();
		await expect.element(page.getByText('FAILED')).toBeVisible();
	});
});
