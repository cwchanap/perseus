// Component tests for PuzzleDifficultyPicker
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleDifficultyPicker from '../PuzzleDifficultyPicker.svelte';
import { getBestTime } from '$lib/services/stats';
import type { PuzzleFamilySummary } from '@perseus/types';

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn().mockReturnValue(null)
}));

function familySummary(overrides: Partial<PuzzleFamilySummary> = {}): PuzzleFamilySummary {
	return {
		id: 'fam-1',
		name: 'Test Family',
		aspectRatio: '1:1',
		status: 'ready',
		createdAt: 1000,
		variants: {
			easy: { id: 'var-e', difficulty: 'easy', pieceCount: 16, status: 'ready' },
			normal: { id: 'var-n', difficulty: 'normal', pieceCount: 49, status: 'ready' },
			hard: { id: 'var-h', difficulty: 'hard', pieceCount: 100, status: 'ready' }
		},
		...overrides
	};
}

describe('PuzzleDifficultyPicker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getBestTime).mockReturnValue(null);
	});

	it('renders three independent difficulty rows', async () => {
		render(PuzzleDifficultyPicker, { family: familySummary() });

		const actions = page.getByTestId('difficulty-action');
		await expect.element(actions.nth(0)).toBeVisible();
		await expect.element(actions.nth(1)).toBeVisible();
		await expect.element(actions.nth(2)).toBeVisible();
	});

	it('exposes saved progress on multiple difficulties without text-heavy actions', async () => {
		const progress = new Map([
			['var-e', { placedCount: 7, pieceCount: 16 }],
			['var-n', { placedCount: 3, pieceCount: 49 }]
		]);
		render(PuzzleDifficultyPicker, { family: familySummary(), progressByVariantId: progress });

		await expect.element(page.getByTestId('difficulty-progress').nth(0)).toHaveTextContent('7/16');
		await expect.element(page.getByTestId('difficulty-progress').nth(1)).toHaveTextContent('3/49');
		await expect
			.element(
				page.getByRole('link', {
					name: 'Easy difficulty, 16 pieces, continue saved progress 7/16'
				})
			)
			.toBeVisible();
	});

	it('links play actions to variant routes', async () => {
		render(PuzzleDifficultyPicker, { family: familySummary() });

		const easy = page.getByTestId('difficulty-action').nth(0);
		await expect.element(easy).toHaveAttribute('href', '/puzzle/var-e');
		await expect
			.element(page.getByRole('link', { name: 'Easy difficulty, 16 pieces' }))
			.toBeVisible();
	});

	it('shows per-difficulty best times', async () => {
		vi.mocked(getBestTime).mockImplementation((id: string) => (id === 'var-e' ? 192 : null));
		render(PuzzleDifficultyPicker, { family: familySummary() });

		await expect.element(page.getByText('◆ 03:12')).toBeVisible();
	});

	it('renders non-link rows when playableLinks is false', async () => {
		render(PuzzleDifficultyPicker, { family: familySummary(), playableLinks: false });

		const easy = page.getByTestId('difficulty-action').nth(0);
		await expect.element(easy).not.toHaveAttribute('href');
	});
});
