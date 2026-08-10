import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleCompletionDialog from '../PuzzleCompletionDialog.svelte';

function timedProps() {
	return {
		puzzleName: 'Test Mission',
		timed: true,
		elapsedSeconds: 75,
		bestTime: 75,
		isNewBest: true,
		localStatsFailed: false,
		serverSubmissionRetryable: true,
		onRetryServerSubmission: vi.fn(),
		onPlayAgain: vi.fn(),
		onBackToArcade: vi.fn(),
		onDismiss: vi.fn()
	};
}

describe('PuzzleCompletionDialog', () => {
	it('preserves backdrop Escape, inner dialog focus, and current actions', async () => {
		const input = timedProps();
		render(PuzzleCompletionDialog, input);

		const backdrop = await page.getByTestId('celebration-modal').element();
		const dialog = backdrop.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.getAttribute('aria-modal')).toBe('true');
		await expect.poll(() => dialog?.contains(document.activeElement)).toBe(true);

		await expect.element(page.getByText('S RANK')).toBeVisible();
		await expect.element(page.getByText('FINAL TIME')).toBeVisible();
		await expect.element(page.getByText('NEW RECORD')).toBeVisible();

		await page.getByTestId('retry-server-submission').click();
		await page.getByRole('button', { name: 'PLAY AGAIN' }).click();
		await page.getByRole('button', { name: 'BACK TO ARCADE' }).click();
		expect(input.onRetryServerSubmission).toHaveBeenCalledOnce();
		expect(input.onPlayAgain).toHaveBeenCalledOnce();
		expect(input.onBackToArcade).toHaveBeenCalledOnce();

		backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(input.onDismiss).toHaveBeenCalledOnce();
	});

	it('omits timed statistics for Relaxed completions', async () => {
		render(PuzzleCompletionDialog, {
			...timedProps(),
			puzzleName: 'Relaxed Mission',
			timed: false,
			elapsedSeconds: 0,
			bestTime: null,
			isNewBest: false,
			serverSubmissionRetryable: false
		});

		await expect.element(page.getByText('MISSION COMPLETE')).toBeVisible();
		expect(page.getByText('S RANK').query()).toBeNull();
		expect(page.getByText('FINAL TIME').query()).toBeNull();
		expect(page.getByText('PERSONAL BEST').query()).toBeNull();
	});

	it('shows UNSAVED instead of NEW RECORD when the local best write failed', async () => {
		render(PuzzleCompletionDialog, { ...timedProps(), localStatsFailed: true });
		await expect.element(page.getByTestId('new-best-unsaved')).toBeVisible();
		expect(page.getByText('NEW RECORD').query()).toBeNull();
	});
});
