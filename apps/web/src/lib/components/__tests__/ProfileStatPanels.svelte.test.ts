import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import type { PlayerProgressionSummary } from '@perseus/types';
import ProfileStatPanels from '../profile/ProfileStatPanels.svelte';

const summary = { puzzlesUploaded: 4, puzzlesSolved: 11, totalCompletions: 18 };

const progression: PlayerProgressionSummary = {
	score: 2650,
	rank: 7,
	easyClears: 6,
	normalClears: 4,
	hardClears: 1,
	achievementsUnlocked: 5,
	achievementsTotal: 9,
	masteryEarned: 3
};

describe('ProfileStatPanels', () => {
	it('shows clears, achievements, mastery and activity counts', async () => {
		render(ProfileStatPanels, { progression, summary });

		await expect.element(page.getByText('11 TOTAL', { exact: true })).toBeVisible();
		await expect.element(page.getByTestId('profile-difficulty-easy')).toHaveTextContent('6');
		await expect.element(page.getByTestId('profile-difficulty-normal')).toHaveTextContent('4');
		await expect.element(page.getByTestId('profile-difficulty-hard')).toHaveTextContent('1');
		await expect.element(page.getByText('5 of 9 unlocked')).toBeVisible();
		await expect.element(page.getByTestId('profile-mastery-earned')).toHaveTextContent('3');
		await expect.element(page.getByTestId('profile-summary-uploaded')).toHaveTextContent('4');
		await expect.element(page.getByTestId('profile-summary-solved')).toHaveTextContent('11');
		await expect.element(page.getByTestId('profile-summary-completions')).toHaveTextContent('18');
	});

	it('shows zeros while progression is unavailable', async () => {
		render(ProfileStatPanels, { progression: null, summary });

		await expect.element(page.getByText('0 TOTAL', { exact: true })).toBeVisible();
		await expect.element(page.getByText('0 of 9 unlocked')).toBeVisible();
		await expect.element(page.getByTestId('profile-mastery-earned')).toHaveTextContent('0');
	});

	it('does not divide by zero when there are no achievements to unlock', async () => {
		render(ProfileStatPanels, {
			progression: { ...progression, achievementsUnlocked: 0, achievementsTotal: 0 },
			summary
		});

		await expect.element(page.getByText('0 of 0 unlocked')).toBeVisible();
		await expect.element(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
	});
});
