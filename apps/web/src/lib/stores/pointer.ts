import { readable, type Readable } from 'svelte/store';

// Coarse-pointer (touch/mobile) detection. Native HTML5 drag-and-drop is the
// desktop interaction path; on coarse pointers the app uses tap-to-place, so
// PuzzlePiece disables its `draggable` binding via this store. The CSS rule
// `-webkit-user-drag: none` in routes/layout.css covers WebKit/Blink only —
// Firefox honors the HTML `draggable` attribute, so the binding must reflect
// coarse-pointer state too. Lazy: `matchMedia` is only touched on first
// subscription (during client render), keeping this SSR-safe.
function createCoarsePointerStore(): Readable<boolean> {
	return readable<boolean>(false, (set) => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			return;
		}
		const query = window.matchMedia('(pointer: coarse)');
		set(query.matches);
		const handler = (event: MediaQueryListEvent) => set(event.matches);
		query.addEventListener('change', handler);
		return () => query.removeEventListener('change', handler);
	});
}

export const coarsePointer = createCoarsePointerStore();
