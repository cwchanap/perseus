import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PuzzleCompletionDialog from '../PuzzleCompletionDialog.svelte';

function standardTimedProps() {
	return {
		puzzleName: 'Test Mission',
		resultClass: 'standard_timed' as const,
		elapsedSeconds: 75,
		pieceCount: 12,
		hintsUsed: 0,
		incorrectAttempts: 1,
		rotationEnabled: false,
		rotationUsed: false,
		bestTime: 68,
		isNewBest: false,
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
		const input = standardTimedProps();
		render(PuzzleCompletionDialog, input);

		const backdrop = await page.getByTestId('celebration-modal').element();
		const dialog = backdrop.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.getAttribute('aria-modal')).toBe('true');
		await expect.poll(() => dialog?.contains(document.activeElement)).toBe(true);

		await expect
			.element(page.getByTestId('completion-result-label'))
			.toHaveTextContent('STANDARD TIMED');
		await expect.element(page.getByTestId('completion-final-time')).toHaveTextContent(/^01:15$/);

		await page.getByTestId('retry-server-submission').click();
		await page.getByRole('button', { name: 'PLAY AGAIN' }).click();
		await page.getByRole('button', { name: 'BACK TO ARCADE' }).click();
		expect(input.onRetryServerSubmission).toHaveBeenCalledOnce();
		expect(input.onPlayAgain).toHaveBeenCalledOnce();
		expect(input.onBackToArcade).toHaveBeenCalledOnce();

		backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(input.onDismiss).toHaveBeenCalledOnce();
	});

	it('shows a truthful standard timed summary without a rank', async () => {
		render(PuzzleCompletionDialog, standardTimedProps());

		expect(page.getByText('S RANK').query()).toBeNull();
		await expect
			.element(page.getByTestId('completion-result-label'))
			.toHaveTextContent('STANDARD TIMED');
		await expect.element(page.getByTestId('completion-final-time')).toHaveTextContent(/^01:15$/);
		await expect.element(page.getByTestId('completion-best-time')).toHaveTextContent(/^01:08$/);
		expect(page.getByText('NEW RECORD').query()).toBeNull();
		await expect.element(page.getByTestId('completion-piece-count')).toHaveTextContent(/^12$/);
		await expect.element(page.getByTestId('completion-hints-used')).toHaveTextContent(/^0$/);
		await expect
			.element(page.getByTestId('completion-incorrect-attempts'))
			.toHaveTextContent(/^1$/);
		await expect
			.element(page.getByTestId('completion-rotation'))
			.toHaveTextContent(/^OFF · NOT USED$/);
	});

	it('shows a standard timed new-best verdict', async () => {
		render(PuzzleCompletionDialog, {
			...standardTimedProps(),
			bestTime: 75,
			isNewBest: true
		});

		await expect.element(page.getByTestId('completion-best-time')).toHaveTextContent(/^01:15$/);
		await expect.element(page.getByText('NEW RECORD')).toBeVisible();
	});

	it('falls back to elapsed time when bestTime is null for a new best', async () => {
		render(PuzzleCompletionDialog, {
			...standardTimedProps(),
			bestTime: null,
			isNewBest: true,
			elapsedSeconds: 90
		});

		// FINAL TIME and PERSONAL BEST intentionally format to the same text here;
		// target the dedicated best-value node so the locator is unambiguous.
		await expect.element(page.getByTestId('completion-final-time')).toHaveTextContent(/^01:30$/);
		await expect.element(page.getByTestId('completion-best-time')).toHaveTextContent(/^01:30$/);
		await expect.element(page.getByText('NEW RECORD')).toBeVisible();
	});

	it('shows UNSAVED instead of NEW RECORD when a new-best write fails', async () => {
		render(PuzzleCompletionDialog, {
			...standardTimedProps(),
			bestTime: 75,
			isNewBest: true,
			localStatsFailed: true
		});

		await expect.element(page.getByTestId('new-best-unsaved')).toBeVisible();
		expect(page.getByText('NEW RECORD').query()).toBeNull();
	});

	it(
		'shows rotation timed without a personal-best comparison ' + 'even when a standard best exists',
		async () => {
			render(PuzzleCompletionDialog, {
				...standardTimedProps(),
				resultClass: 'rotation_timed',
				rotationEnabled: true,
				rotationUsed: true
			});

			await expect
				.element(page.getByTestId('completion-result-label'))
				.toHaveTextContent('ROTATION TIMED');
			await expect.element(page.getByTestId('completion-final-time')).toHaveTextContent(/^01:15$/);
			expect(page.getByTestId('completion-best-time').query()).toBeNull();
			await expect
				.element(page.getByTestId('completion-rotation'))
				.toHaveTextContent(/^ON · USED$/);
		}
	);

	it(
		'shows assisted timed counters without a personal-best ' +
			'comparison even when a standard best exists',
		async () => {
			render(PuzzleCompletionDialog, {
				...standardTimedProps(),
				resultClass: 'assisted_timed',
				hintsUsed: 2,
				incorrectAttempts: 3
			});

			await expect
				.element(page.getByTestId('completion-result-label'))
				.toHaveTextContent('ASSISTED TIMED');
			await expect.element(page.getByTestId('completion-hints-used')).toHaveTextContent(/^2$/);
			await expect
				.element(page.getByTestId('completion-incorrect-attempts'))
				.toHaveTextContent(/^3$/);
			expect(page.getByTestId('completion-best-time').query()).toBeNull();
		}
	);

	it('shows Relaxed as a noncompetitive completion', async () => {
		render(PuzzleCompletionDialog, {
			...standardTimedProps(),
			resultClass: 'relaxed',
			elapsedSeconds: null
		});

		await expect.element(page.getByTestId('completion-result-label')).toHaveTextContent('RELAXED');
		expect(page.getByTestId('completion-final-time').query()).toBeNull();
		expect(page.getByTestId('completion-best-time').query()).toBeNull();
		await expect.element(page.getByTestId('completion-piece-count')).toHaveTextContent(/^12$/);
	});

	it('shows progression awards when the server returns them', async () => {
		render(PuzzleCompletionDialog, {
			...standardTimedProps(),
			awards: {
				clearPoints: 200,
				achievements: ['first_clear', 'getting_started'],
				mastery: ['hintless'],
				puzzleRank: 3
			}
		});

		await expect
			.element(page.getByTestId('completion-clear-points'))
			.toHaveTextContent('+200 SCORE');
		await expect
			.element(page.getByTestId('completion-achievements'))
			.toHaveTextContent('First Clear');
		await expect
			.element(page.getByTestId('completion-achievements'))
			.toHaveTextContent('Getting Started');
		await expect.element(page.getByTestId('completion-mastery')).toHaveTextContent('Hintless');
		await expect
			.element(page.getByTestId('completion-puzzle-rank'))
			.toHaveTextContent('FAMILY RANK #3');
	});
});
