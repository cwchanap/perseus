const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function modalFocus(node: HTMLElement, focusKey: unknown = true) {
	const previousFocus =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;
	let activeKey = focusKey;
	let focusTimer: ReturnType<typeof setTimeout> | null = null;

	// The container takes programmatic focus on open; most dialogs declare
	// tabindex="-1" in markup, this guards the ones that don't.
	if (!node.hasAttribute('tabindex')) node.tabIndex = -1;

	const focusable = () =>
		Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
			(element) => element.offsetParent !== null
		);

	const focusDialog = () => {
		if (focusTimer !== null) clearTimeout(focusTimer);
		// Focus the container, not its first control: in a dialog taller
		// than the viewport (the completion results on phones) the first
		// control sits below the fold — focusing it scrolls the header out
		// of view, while preventScroll left an unseen control armed for
		// Enter. Container focus keeps the header in view, announces the
		// dialog label, and lets the first Tab reach the first control.
		focusTimer = setTimeout(() => node.focus({ preventScroll: true }), 0);
	};

	const trap = (event: KeyboardEvent) => {
		if (event.key !== 'Tab') return;
		const elements = focusable();
		const first = elements[0];
		const last = elements[elements.length - 1];
		const active = document.activeElement;
		// The container can hold focus on open: Shift+Tab from it would
		// escape the dialog, so wrap to the last control. Forward Tab falls
		// through to the first control natively. With no focusable children
		// at all, both directions stay pinned to the container.
		if (event.shiftKey) {
			if (active === first || active === node) {
				event.preventDefault();
				last?.focus();
			}
		} else if (active === last || (active === node && elements.length === 0)) {
			event.preventDefault();
			first?.focus();
		}
	};

	document.addEventListener('keydown', trap);
	focusDialog();

	return {
		update(nextKey: unknown) {
			if (nextKey === activeKey) return;
			activeKey = nextKey;
			focusDialog();
		},
		destroy() {
			if (focusTimer !== null) clearTimeout(focusTimer);
			document.removeEventListener('keydown', trap);
			setTimeout(() => previousFocus?.focus(), 0);
		}
	};
}
