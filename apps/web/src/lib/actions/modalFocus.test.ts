import { describe, it, expect, afterEach, vi } from 'vitest';
import { modalFocus } from './modalFocus';

// modalFocus is a Svelte action. It can be invoked directly with a DOM node
// and returns an action controller ({ update, destroy }). These tests
// exercise the action's branches that the dialog component tests do not
// reach (empty focusable lists, mid-list Tab, no-op updates, non-HTMLElement
// activeElement, and destroy before timer fires).

function createDialogWithButtons(count: number): HTMLElement {
	const dialog = document.createElement('div');
	dialog.setAttribute('role', 'dialog');
	document.body.appendChild(dialog);
	for (let i = 0; i < count; i++) {
		const btn = document.createElement('button');
		btn.textContent = `Button ${i}`;
		dialog.appendChild(btn);
	}
	return dialog;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('modalFocus action', () => {
	it('does nothing on Tab when the dialog has no focusable elements', () => {
		const dialog = createDialogWithButtons(0);
		const controller = modalFocus(dialog);

		// Tab on the empty dialog must not throw and must not preventDefault.
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
		dialog.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);

		controller.destroy();
	});

	it('does not wrap Tab when the active element is neither first nor last', () => {
		const dialog = createDialogWithButtons(3);
		const controller = modalFocus(dialog);

		const buttons = Array.from(dialog.querySelectorAll('button'));
		// Focus the middle button — Tab should pass through normally.
		buttons[1].focus();
		expect(document.activeElement).toBe(buttons[1]);

		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
		dialog.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);

		controller.destroy();
	});

	it('ignores non-Tab keys entirely', () => {
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog);

		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
		dialog.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);

		controller.destroy();
	});

	it('does not refocus when update receives the same key', () => {
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog, 'my-key');

		const firstButton = dialog.querySelectorAll('button')[0];
		// Move focus away from the first button so a refocus would be visible.
		firstButton.blur();
		expect(document.activeElement).not.toBe(firstButton);

		controller.update('my-key');
		// Same key → no refocus → focus stays where it is.
		expect(document.activeElement).not.toBe(firstButton);

		controller.destroy();
	});

	it('refocuses the first element when update receives a different key', async () => {
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog, 'key-a');

		const firstButton = dialog.querySelectorAll('button')[0];
		firstButton.blur();

		controller.update('key-b');
		// The refocus runs inside setTimeout(0).
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(firstButton);
		});

		controller.destroy();
	});

	it('handles non-HTMLElement activeElement without throwing on destroy', () => {
		// When the previously focused element is not an HTMLElement (e.g. the
		// document itself), destroy must not attempt to call .focus() on it.
		const original = Object.getOwnPropertyDescriptor(document, 'activeElement');
		try {
			Object.defineProperty(document, 'activeElement', {
				configurable: true,
				get: () => null
			});
			const dialog = createDialogWithButtons(1);
			const controller = modalFocus(dialog);
			expect(() => controller.destroy()).not.toThrow();
		} finally {
			if (original) {
				Object.defineProperty(document, 'activeElement', original);
			}
		}
	});

	it('clears a pending focus timer on destroy without throwing', () => {
		// Destroy immediately after setup: the setTimeout(0) from focusFirst
		// has not fired yet, so destroy must clear it. This exercises the
		// focusTimer !== null guard in destroy.
		const dialog = createDialogWithButtons(1);
		const controller = modalFocus(dialog);
		expect(() => controller.destroy()).not.toThrow();
	});

	it('does not call clearTimeout in destroy when focusTimer was never set', () => {
		// If setTimeout returns null (e.g. in a mocked environment),
		// focusTimer stays null and destroy must skip clearTimeout without
		// throwing. This covers the focusTimer === null false branch.
		const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(
			() => null as unknown as ReturnType<typeof setTimeout>
		);
		try {
			const dialog = createDialogWithButtons(1);
			const controller = modalFocus(dialog);
			controller.destroy();
			expect(clearSpy).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});
});
