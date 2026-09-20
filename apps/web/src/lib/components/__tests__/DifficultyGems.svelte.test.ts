import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import DifficultyGems from '../DifficultyGems.svelte';

describe('DifficultyGems', () => {
	it.each([
		['easy', 'Easy', 1, 12],
		['normal', 'Normal', 2, 48],
		['hard', 'Hard', 3, 108]
	] as const)('renders %s with the closed gem count', async (difficulty, label, gems, pieces) => {
		render(DifficultyGems, { difficulty, pieceCount: pieces });

		await expect
			.element(page.getByLabelText(`${label} difficulty, ${pieces} pieces`))
			.toBeVisible();
		await expect.element(page.getByTestId('difficulty-gem')).toHaveLength(gems);
		await expect.element(page.getByText(String(pieces))).toBeVisible();
	});

	it('omits only the visible piece count in compact mode', async () => {
		render(DifficultyGems, { difficulty: 'normal', pieceCount: 48, showPieceCount: false });

		await expect.element(page.getByLabelText('Normal difficulty, 48 pieces')).toBeVisible();
		await expect.element(page.getByTestId('difficulty-gem')).toHaveLength(2);
		expect(page.getByText('48').query()).toBeNull();
	});
});
