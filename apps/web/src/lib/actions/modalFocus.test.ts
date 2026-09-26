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
	it('leaves Tab to the browser while focus has not yet reached the dialog', () => {
		const dialog = createDialogWithButtons(0);
		const controller = modalFocus(dialog);

		// Focus is still on body (the container focus is zero-delay), so the
		// trap has nothing to pin and must not intercept the key.
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
		dialog.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);

		controller.destroy();
	});

	it('pins Tab in both directions when the empty dialog holds focus', async () => {
		const dialog = createDialogWithButtons(0);
		const controller = modalFocus(dialog);
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(dialog);
		});

		// With no focusable children, focus rests on the container; native Tab
		// would escape to the page behind the dialog, so the trap pins both
		// directions (preventDefault, no focus move).
		for (const shiftKey of [false, true]) {
			const event = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey,
				bubbles: true,
				cancelable: true
			});
			dialog.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(dialog);
		}

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

	it('makes the container focusable and focuses it on mount', async () => {
		// The container takes initial focus rather than its first control: in
		// a dialog taller than the viewport, the first control can sit below
		// the fold and be armed for Enter without ever being seen.
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog);
		expect(dialog.tabIndex).toBe(-1);

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(dialog);
		});

		controller.destroy();
	});

	it('does not overwrite a tabindex the host already declared', () => {
		// Most dialogs declare tabindex="-1" in markup; the action only fills
		// it in when absent, so an explicit value must be preserved.
		const dialog = createDialogWithButtons(1);
		dialog.setAttribute('tabindex', '0');
		const controller = modalFocus(dialog);
		expect(dialog.tabIndex).toBe(0);
		controller.destroy();
	});

	it('wraps Shift+Tab from the container to the last control', async () => {
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog);
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(dialog);
		});

		const buttons = Array.from(dialog.querySelectorAll('button'));
		const event = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey: true,
			bubbles: true,
			cancelable: true
		});
		dialog.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(buttons[buttons.length - 1]);

		controller.destroy();
	});

	it('wraps Shift+Tab from the first control to the last control', () => {
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog);
		const buttons = Array.from(dialog.querySelectorAll('button'));
		buttons[0].focus();

		const event = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey: true,
			bubbles: true,
			cancelable: true
		});
		dialog.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(buttons[buttons.length - 1]);

		controller.destroy();
	});

	it('lets forward Tab from the container pass through to the first control', async () => {
		// Synthetic keydown events do not trigger native Tab navigation, so
		// this asserts non-prevention: the browser moves focus to the first
		// control itself.
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog);
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(dialog);
		});

		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		dialog.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);

		controller.destroy();
	});

	it('pins focus to the container when the dialog has no focusable elements', async () => {
		const dialog = createDialogWithButtons(0);
		const controller = modalFocus(dialog);
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(dialog);
		});

		for (const shiftKey of [false, true]) {
			const event = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey,
				bubbles: true,
				cancelable: true
			});
			dialog.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(dialog);
		}

		controller.destroy();
	});

	it('refocuses the container when update receives a different key', async () => {
		const dialog = createDialogWithButtons(2);
		const controller = modalFocus(dialog, 'key-a');

		// Move focus into the dialog so the refocus to the container is visible.
		dialog.querySelectorAll('button')[0].focus();

		controller.update('key-b');
		// The refocus runs inside setTimeout(0).
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(dialog);
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
