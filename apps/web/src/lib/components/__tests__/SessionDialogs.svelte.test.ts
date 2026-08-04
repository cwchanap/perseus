import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import MissionSetupDialog from '../MissionSetupDialog.svelte';
import SessionPauseDialog from '../SessionPauseDialog.svelte';
import ExitSessionDialog from '../ExitSessionDialog.svelte';

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
			onExit: vi.fn()
		});
		await view.rerender({
			presentation: 'paused',
			mode: 'timed',
			confirmingRestart: true,
			onResume: vi.fn(),
			onRequestRestart: vi.fn(),
			onConfirmRestart: vi.fn(),
			onCancelRestart: vi.fn(),
			onExit: vi.fn()
		});
		await expect.element(page.getByText('Restart this mission?')).toBeVisible();
		expect(await page.getByRole('dialog').all()).toHaveLength(1);
	});
});

describe('ExitSessionDialog', () => {
	it('fires the discard callback once when Discard is clicked', async () => {
		const onDiscard = vi.fn();
		render(ExitSessionDialog, { onSave: vi.fn(), onDiscard, onCancel: vi.fn() });
		await page.getByRole('button', { name: 'Discard' }).click();
		expect(onDiscard).toHaveBeenCalledOnce();
	});
});
