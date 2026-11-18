export type ImageStatusState = 'pending' | 'loaded' | 'error';

export interface ImageStatusParams {
	src: string;
	onStatus?: (state: ImageStatusState) => void;
}

// Shared image load-status action (HPA-1029): observes the native <img>
// load/error lifecycle and reflects it on the element as
// data-image-state="pending|loaded|error" so CSS and tests can key off the
// image itself. An optional callback is notified on every status change —
// including exactly one initial value at mount, which re-synchronizes
// consumers when an {#if} block remounts the image. Status resets only when
// src actually changes, so unrelated rerenders (e.g. a fresh callback
// closure) never restart a loaded state, and a replaced URL recovers from a
// prior failure. Never unmounts or hides anything itself; consumers keep the
// <img> mounted and hide it with opacity so lazy loading and recovery work.
export function imageStatus(node: HTMLImageElement, params: ImageStatusParams) {
	let currentSrc = params.src;
	let currentOnStatus = params.onStatus;
	let state: ImageStatusState;

	const apply = (next: ImageStatusState) => {
		if (next === state) return;
		state = next;
		node.dataset.imageState = next;
		currentOnStatus?.(next);
	};

	// Native events for an empty/unassigned source (mounting <img src="">
	// fires a native error) must not classify the image: an empty source
	// always stays pending, matching classify().
	const srcIsSet = () => Boolean(node.getAttribute('src'));
	const markLoaded = () => {
		if (!srcIsSet()) return;
		apply('loaded');
	};
	const markError = () => {
		if (!srcIsSet()) return;
		apply('error');
	};

	// A complete image fires no further events, so classify it from the
	// decoded result. Checked via the src attribute (not the property):
	// an empty attribute must read as pending, not as a failed image.
	const classify = (): ImageStatusState => {
		if (node.getAttribute('src') && node.complete) {
			return node.naturalWidth > 0 ? 'loaded' : 'error';
		}
		return 'pending';
	};

	node.addEventListener('load', markLoaded);
	node.addEventListener('error', markError);
	state = classify();
	node.dataset.imageState = state;
	currentOnStatus?.(state);

	return {
		update(next: ImageStatusParams) {
			currentOnStatus = next.onStatus;
			if (next.src === currentSrc) return;
			currentSrc = next.src;
			// Reset to pending and let the native load/error events for the new
			// URL drive the outcome — the element's src attribute may not be
			// applied yet when update runs, so classifying from it here would
			// read the previous image. A real attribute change always fires an
			// event, including for warm-cache URLs.
			apply('pending');
		},
		destroy() {
			node.removeEventListener('load', markLoaded);
			node.removeEventListener('error', markError);
		}
	};
}
