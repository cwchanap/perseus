import { describe, it, expect, afterEach, vi } from 'vitest';
import { imageStatus } from './imageStatus';
import type { ImageStatusState } from './imageStatus';

// Vitest runs these specs in a real browser with no image stubs, so the
// action is exercised against the native <img> lifecycle it must observe.
// Each test gets a fresh blob URL: data: URLs can be served synchronously
// from Chromium's memory cache, which would make mount nondeterministic.
const PNG_BYTES = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0v8AAAAASUVORK5CYII='
	),
	(char) => char.charCodeAt(0)
);
const createdUrls: string[] = [];

function validUrl(): string {
	const url = URL.createObjectURL(new Blob([PNG_BYTES], { type: 'image/png' }));
	createdUrls.push(url);
	return url;
}

function brokenUrl(): string {
	const url = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
	createdUrls.push(url);
	return url;
}

function zeroSizeSvgUrl(): string {
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" viewBox="0 0 64 64"><rect width="64" height="64" fill="#385" /></svg>';
	const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
	createdUrls.push(url);
	return url;
}

function createImage(src?: string): HTMLImageElement {
	const img = document.createElement('img');
	if (src !== undefined) img.src = src;
	document.body.appendChild(img);
	return img;
}

function collectStates(): {
	states: ImageStatusState[];
	onStatus: (state: ImageStatusState) => void;
} {
	const states: ImageStatusState[] = [];
	return { states, onStatus: (state) => states.push(state) };
}

afterEach(() => {
	document.body.innerHTML = '';
	for (const url of createdUrls) URL.revokeObjectURL(url);
	createdUrls.length = 0;
});

describe('imageStatus action', () => {
	it('starts pending and reports loaded when the image finishes loading', async () => {
		const url = validUrl();
		const img = createImage(url);
		const { states, onStatus } = collectStates();
		const controller = imageStatus(img, { src: url, onStatus });

		expect(img.dataset.imageState).toBe('pending');

		await vi.waitFor(() => expect(img.dataset.imageState).toBe('loaded'));
		expect(states).toEqual(['pending', 'loaded']);

		controller.destroy();
	});

	it('reports error when the image fails to load', async () => {
		const url = brokenUrl();
		const img = createImage(url);
		const { states, onStatus } = collectStates();
		imageStatus(img, { src: url, onStatus });

		await vi.waitFor(() => expect(img.dataset.imageState).toBe('error'));
		expect(states).toEqual(['pending', 'error']);
	});

	it('recovers to loaded when a failed src changes to a working URL', async () => {
		const failedUrl = brokenUrl();
		const img = createImage(failedUrl);
		const { states, onStatus } = collectStates();
		const controller = imageStatus(img, { src: failedUrl, onStatus });
		await vi.waitFor(() => expect(img.dataset.imageState).toBe('error'));

		const workingUrl = validUrl();
		// The component owns the src attribute; mirror it alongside the update
		// the way a Svelte src binding does.
		img.src = workingUrl;
		controller.update({ src: workingUrl, onStatus });

		// The element stays mounted: the reset happens synchronously so the
		// next URL is not locked out by the prior failure.
		expect(img.dataset.imageState).toBe('pending');
		await vi.waitFor(() => expect(img.dataset.imageState).toBe('loaded'));
		expect(states).toEqual(['pending', 'error', 'pending', 'loaded']);

		controller.destroy();
	});

	it('treats an already-complete warm-cache image as loaded without waiting for another event', async () => {
		const url = validUrl();
		const img = createImage(url);
		await new Promise((resolve) => img.addEventListener('load', resolve, { once: true }));

		const { states, onStatus } = collectStates();
		imageStatus(img, { src: url, onStatus });

		// Classified synchronously at mount: a cached image fires no further
		// events, so waiting for one would never leave pending.
		expect(img.dataset.imageState).toBe('loaded');
		expect(states).toEqual(['loaded']);
	});

	it('classifies a zero-intrinsic-width SVG identically on fresh load and cached mount', async () => {
		const url = zeroSizeSvgUrl();
		const fresh = createImage(url);
		const freshStates = collectStates();
		const freshController = imageStatus(fresh, { src: url, onStatus: freshStates.onStatus });

		await vi.waitFor(() => expect(fresh.complete).toBe(true));
		expect(fresh.naturalWidth).toBe(0);
		expect(fresh.dataset.imageState).toBe('error');
		expect(freshStates.states).toEqual(['pending', 'error']);

		// Reusing the same already-loaded URL (warm cache / second mount) must
		// classify identically instead of diverging between load and classify().
		const cached = createImage(url);
		await vi.waitFor(() => expect(cached.complete).toBe(true));
		const cachedStates = collectStates();
		const cachedController = imageStatus(cached, { src: url, onStatus: cachedStates.onStatus });

		expect(cached.naturalWidth).toBe(0);
		expect(cached.dataset.imageState).toBe('error');
		expect(cachedStates.states).toEqual(['error']);

		freshController.destroy();
		cachedController.destroy();
	});

	it('does not restart the status when an unrelated update arrives', async () => {
		const url = validUrl();
		const img = createImage(url);
		const { onStatus } = collectStates();
		const controller = imageStatus(img, { src: url, onStatus });
		await vi.waitFor(() => expect(img.dataset.imageState).toBe('loaded'));

		const replacement = vi.fn();
		controller.update({ src: url, onStatus: replacement });

		// Same src: a new params object or fresh callback closure must not
		// reset a loaded image back to pending.
		expect(img.dataset.imageState).toBe('loaded');
		expect(replacement).not.toHaveBeenCalled();

		controller.destroy();
	});

	it('routes later notifications to a replacement callback', async () => {
		const firstUrl = validUrl();
		const img = createImage(firstUrl);
		const first = collectStates();
		const controller = imageStatus(img, { src: firstUrl, onStatus: first.onStatus });
		await vi.waitFor(() => expect(img.dataset.imageState).toBe('loaded'));

		const second = collectStates();
		const failedUrl = brokenUrl();
		img.src = failedUrl;
		controller.update({ src: failedUrl, onStatus: second.onStatus });
		await vi.waitFor(() => expect(img.dataset.imageState).toBe('error'));

		expect(second.states).toEqual(['pending', 'error']);
		expect(first.states).toEqual(['pending', 'loaded']);

		controller.destroy();
	});

	it('stops reporting after destroy', async () => {
		const url = validUrl();
		const img = createImage(url);
		const { states, onStatus } = collectStates();
		const controller = imageStatus(img, { src: url, onStatus });
		await vi.waitFor(() => expect(img.dataset.imageState).toBe('loaded'));

		controller.destroy();
		img.src = brokenUrl();
		// Wait until the browser has actually attempted (and failed) the new
		// load so the assertion cannot pass merely because the error has not
		// happened yet.
		await vi.waitFor(() => expect(img.complete && img.naturalWidth === 0).toBe(true));

		expect(img.dataset.imageState).toBe('loaded');
		expect(states).toEqual(['pending', 'loaded']);
	});

	it('keeps an empty source pending instead of reporting a failed image', () => {
		const img = createImage();
		const { states, onStatus } = collectStates();
		imageStatus(img, { src: '', onStatus });

		expect(img.dataset.imageState).toBe('pending');
		expect(states).toEqual(['pending']);
	});

	it('keeps an explicitly empty src="" attribute pending when mounting fires a native error', async () => {
		// Chromium fires a native error for a mounted <img src=""> (broken
		// image): the attribute is present but empty, unlike the attribute-
		// absent case above. The action must not classify it as failed.
		const img = createImage('');
		const nativeError = vi.fn();
		img.addEventListener('error', nativeError);
		const { states, onStatus } = collectStates();
		imageStatus(img, { src: '', onStatus });

		await vi.waitFor(() => expect(nativeError).toHaveBeenCalled());

		expect(img.dataset.imageState).toBe('pending');
		expect(states).toEqual(['pending']);
	});

	it('stays pending when a mounted image changes its src to an empty string', async () => {
		const url = validUrl();
		const img = createImage(url);
		const { states, onStatus } = collectStates();
		const controller = imageStatus(img, { src: url, onStatus });
		await vi.waitFor(() => expect(img.dataset.imageState).toBe('loaded'));

		const nativeError = vi.fn();
		img.addEventListener('error', nativeError);
		img.src = '';
		controller.update({ src: '', onStatus });

		// The empty source resets to pending and the native error the browser
		// fires for src="" must not flip it to failed.
		await vi.waitFor(() => expect(nativeError).toHaveBeenCalled());

		expect(img.dataset.imageState).toBe('pending');
		expect(states).toEqual(['pending', 'loaded', 'pending']);

		controller.destroy();
	});
});
