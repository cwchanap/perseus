const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function modalFocus(node: HTMLElement, focusKey: unknown = true) {
	const previousFocus =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;
	let activeKey = focusKey;
	let focusTimer: ReturnType<typeof setTimeout> | null = null;

	const focusable = () =>
		Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
			(element) => element.offsetParent !== null
		);

	const focusFirst = () => {
		if (focusTimer !== null) clearTimeout(focusTimer);
		// preventScroll: focusing the first control must not scroll it into
		// view on open — for dialogs taller than the viewport (the completion
		// results on phones) that jump pushes the dialog's header out of view
		// the moment it opens. Keyboard traversal still scrolls normally.
		focusTimer = setTimeout(() => focusable()[0]?.focus({ preventScroll: true }), 0);
	};

	const trap = (event: KeyboardEvent) => {
		if (event.key !== 'Tab') return;
		const elements = focusable();
		if (elements.length === 0) return;
		const first = elements[0];
		const last = elements[elements.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	document.addEventListener('keydown', trap);
	focusFirst();

	return {
		update(nextKey: unknown) {
			if (nextKey === activeKey) return;
			activeKey = nextKey;
			focusFirst();
		},
		destroy() {
			if (focusTimer !== null) clearTimeout(focusTimer);
			document.removeEventListener('keydown', trap);
			setTimeout(() => previousFocus?.focus(), 0);
		}
	};
}
