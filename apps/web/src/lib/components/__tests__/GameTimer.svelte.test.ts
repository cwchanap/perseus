import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import GameTimer from '../GameTimer.svelte';
import type { TimerState } from '$lib/stores/timer';

describe('GameTimer', () => {
	it('renders the timer with correct formatted time', async () => {
		const timerState: TimerState = { elapsed: 125, running: true };
		render(GameTimer, { timerState, bestTime: null });

		const timer = page.getByTestId('game-timer');
		await expect.element(timer).toBeVisible();
		await expect.element(timer).toHaveTextContent('02:05');
	});

	it('does not render best-time element when bestTime is null', async () => {
		const timerState: TimerState = { elapsed: 60, running: true };
		render(GameTimer, { timerState, bestTime: null });

		const bestTime = page.getByTestId('best-time');
		await expect.element(bestTime).not.toBeInTheDocument();
	});

	it('renders best-time element with correct formatted time when bestTime is provided', async () => {
		const timerState: TimerState = { elapsed: 60, running: true };
		render(GameTimer, { timerState, bestTime: 90 });

		const bestTime = page.getByTestId('best-time');
		await expect.element(bestTime).toBeVisible();
		await expect.element(bestTime).toHaveTextContent('01:30');
	});

	it('aria-label includes the formatted time', async () => {
		const timerState: TimerState = { elapsed: 125, running: true };
		render(GameTimer, { timerState, bestTime: null });

		const timer = page.getByTestId('game-timer');
		await expect.element(timer).toHaveAttribute('aria-label', 'Timer: 02:05');
	});
});
