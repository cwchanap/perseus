import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import MissionSetupDialog from '../MissionSetupDialog.svelte';
import SessionPauseDialog from '../SessionPauseDialog.svelte';
import DiscardSessionDialog from '../DiscardSessionDialog.svelte';

const setupProps = {
	puzzleName: 'Test Mission',
	pieceCount: 4,
	gridCols: 2,
	gridRows: 2,
	draft: {
		mode: 'timed' as const,
		rotationEnabled: false,
		startImmediately: false
	},
	inputHelp: 'Select a piece, then choose its slot.',
	onDraftChange: vi.fn(),
	onStart: vi.fn(),
	onCancel: vi.fn(),
	onExit: vi.fn()
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe('MissionSetupDialog', () => {
	it('blocks Escape dismissal when mandatory', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		const mandatory = await page.getByRole('dialog', { name: 'Mission Setup' }).element();
		mandatory.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(setupProps.onCancel).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Return to Arcade' }).click();
		expect(setupProps.onExit).toHaveBeenCalledOnce();
	});

	it('hides Cancel in mandatory mode, leaving Start Mission and Return to Arcade', async () => {
		// A mandatory setup cannot be cancelled: dismissing it would leave the
		// session in the 'setup' lifecycle with no way back in (a soft-locked
		// board). Only Start Mission and the Return to Arcade exit remain.
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		await expect.element(page.getByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Start Mission' })).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Return to Arcade' })).toBeVisible();
	});

	it('keeps Cancel available in non-mandatory mode', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: false });
		await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
	});

	it('dismisses on Escape when not mandatory', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: false });
		const dialog = await page.getByRole('dialog', { name: 'Mission Setup' }).element();
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(setupProps.onCancel).toHaveBeenCalledOnce();
		expect(setupProps.onExit).not.toHaveBeenCalled();
	});

	it('moves initial focus to the first focusable control', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		const timedRadio = await page.getByLabelText('Timed').element();
		await expect.poll(() => document.activeElement).toBe(timedRadio);
	});

	it('wraps Tab focus within the dialog', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		const dialog = await page.getByRole('dialog', { name: 'Mission Setup' }).element();
		const focusables = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
			)
		);
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		expect(focusables.length).toBeGreaterThan(1);

		last.focus();
		expect(document.activeElement).toBe(last);
		last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		expect(document.activeElement).toBe(first);

		first.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
		);
		expect(document.activeElement).toBe(last);
	});

	it('fires onDraftChange with relaxed mode when Relaxed is selected', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		await page.getByLabelText('Relaxed').click();
		expect(setupProps.onDraftChange).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 'relaxed' })
		);
	});

	it('fires onDraftChange with timed mode when Timed is selected', async () => {
		const draft = {
			mode: 'relaxed' as const,
			rotationEnabled: false,
			startImmediately: false
		};
		render(MissionSetupDialog, { ...setupProps, draft, mandatory: true });
		await page.getByLabelText('Timed').click();
		expect(setupProps.onDraftChange).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 'timed' })
		);
	});

	it('fires onDraftChange toggling rotationEnabled when Enable rotation is clicked', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		await page.getByLabelText('Enable rotation').click();
		expect(setupProps.onDraftChange).toHaveBeenCalledWith(
			expect.objectContaining({ rotationEnabled: true })
		);
	});

	it('fires onDraftChange toggling startImmediately when Start immediately is clicked', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		await page.getByLabelText('Start immediately next time').click();
		expect(setupProps.onDraftChange).toHaveBeenCalledWith(
			expect.objectContaining({ startImmediately: true })
		);
	});

	it('fires onStart when Start Mission is clicked', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: true });
		await page.getByRole('button', { name: 'Start Mission' }).click();
		expect(setupProps.onStart).toHaveBeenCalledOnce();
	});

	it('fires onCancel when Cancel is clicked in non-mandatory mode', async () => {
		render(MissionSetupDialog, { ...setupProps, mandatory: false });
		await page.getByRole('button', { name: 'Cancel' }).click();
		expect(setupProps.onCancel).toHaveBeenCalledOnce();
	});
});

describe('SessionPauseDialog', () => {
	it('switches to inline restart confirmation on rerender', async () => {
		const view = render(SessionPauseDialog, {
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: false,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn(),
			onDiscard: vi.fn()
		});
		await view.rerender({
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: true,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn(),
			onDiscard: vi.fn()
		});
		await expect.element(page.getByText('Restart this mission?')).toBeVisible();
		expect(await page.getByRole('dialog').all()).toHaveLength(1);
	});

	it('shows Relaxed mission label for a relaxed-mode pause', async () => {
		render(SessionPauseDialog, {
			presentation: 'paused',
			mode: 'relaxed',
			confirmingRestart: false,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn(),
			onDiscard: vi.fn()
		});
		await expect.element(page.getByText('Relaxed mission')).toBeVisible();
	});

	it('shows Timed mission label for a timed-mode pause', async () => {
		render(SessionPauseDialog, {
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: false,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn(),
			onDiscard: vi.fn()
		});
		await expect.element(page.getByText('Timed mission')).toBeVisible();
	});

	it('fires onResume, onRequestRestart, and onExit from the pause surface', async () => {
		const onResume = vi.fn();
		const onRequestRestart = vi.fn();
		const onExit = vi.fn();
		render(SessionPauseDialog, {
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: false,
			onResume,
			onRequestRestart,
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit,
			onDiscard: vi.fn()
		});
		await page.getByRole('button', { name: 'Exit' }).click();
		expect(onExit).toHaveBeenCalledOnce();
		await page.getByRole('button', { name: 'Restart' }).click();
		expect(onRequestRestart).toHaveBeenCalledOnce();
		await page.getByRole('button', { name: 'Resume' }).click();
		expect(onResume).toHaveBeenCalledOnce();
	});

	it('forwards Discard from the pause surface', async () => {
		const onDiscard = vi.fn();
		render(SessionPauseDialog, {
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: false,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn(),
			onDiscard
		});

		await page.getByRole('button', { name: 'Discard' }).click();
		expect(onDiscard).toHaveBeenCalledOnce();
	});

	it('fires onConfirmRestart and onCancelRestart from the confirmation surface', async () => {
		const onConfirmRestart = vi.fn();
		const onCancelRestart = vi.fn();
		render(SessionPauseDialog, {
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: true,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart,
			onCancelRestart,
			onExit: vi.fn(),
			onDiscard: vi.fn()
		});
		await page.getByRole('button', { name: 'Cancel' }).click();
		expect(onCancelRestart).toHaveBeenCalledOnce();
		await page.getByRole('button', { name: 'Confirm restart' }).click();
		expect(onConfirmRestart).toHaveBeenCalledOnce();
	});

	it('labels the dialog Resume Mission for the resume presentation', async () => {
		render(SessionPauseDialog, {
			presentation: 'resume',
			mode: 'timed',
			confirmingRestart: false,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn(),
			onDiscard: vi.fn()
		});
		await expect.element(page.getByRole('dialog', { name: 'Resume Mission' })).toBeVisible();
	});
});

describe('DiscardSessionDialog', () => {
	it('keeps the full-screen shell and confirms discard', async () => {
		const onConfirm = vi.fn();
		render(DiscardSessionDialog, {
			puzzleName: 'Test Mission',
			onConfirm,
			onCancel: vi.fn()
		});

		const dialog = await page.getByRole('dialog', { name: 'Discard saved progress' }).element();
		expect(dialog.parentElement?.className).toContain('fixed');
		expect(dialog.parentElement?.className).toContain('inset-0');

		await page.getByRole('button', { name: 'Discard' }).click();
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('cancels discard on Escape', async () => {
		const onCancel = vi.fn();
		render(DiscardSessionDialog, {
			puzzleName: 'Test Mission',
			onConfirm: vi.fn(),
			onCancel
		});

		const dialog = await page.getByRole('dialog', { name: 'Discard saved progress' }).element();
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onCancel).toHaveBeenCalledOnce();
	});
});
