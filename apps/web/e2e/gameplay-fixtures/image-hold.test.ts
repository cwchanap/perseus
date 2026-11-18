// Image hold/fail helper invariants.
//
// The helper holds or fails KNOWN gameplay fixture image endpoints (piece,
// reference, thumbnail) and arbitrary gallery image URLs so artwork-status
// E2E can drive pending → loaded and failure states deterministically. These
// tests run under bun:test with a structural stub of the Playwright Route —
// the helper only reads `request().url()`/`request().method()` and calls
// `fulfill`/`abort`/`fallback` (the same stubbing pattern as
// fixture-router.test.ts).
import { describe, expect, it } from 'bun:test';
import type { Page, Request, Route } from '@playwright/test';
import {
	FIXTURE_ROUTER_HEADER,
	FIXTURE_ROUTER_SOURCE,
	HARNESS_VIOLATION_HEADER
} from './fixture-router';
import { createImageHoldController } from './image-hold';

const KNOWN_ID = 'e2e2a000-0000-4000-8000-000000000004';

interface FulfillCall {
	status?: number;
	json?: unknown;
	body?: string;
	contentType?: string;
	headers?: Record<string, string>;
}

interface AbortedCall {
	text?: string;
}

interface StubRoute {
	route: Route;
	fulfilled: FulfillCall[];
	aborted: AbortedCall[];
	fallbacks: number;
}

function stubRoute(url: string, method = 'GET'): StubRoute {
	const stub: StubRoute = {
		fulfilled: [],
		aborted: [],
		fallbacks: 0,
		route: {
			request: () =>
				({
					url: () => url,
					method: () => method
				}) as unknown as Request,
			fulfill: async (init: FulfillCall) => {
				// Record the effective status: Playwright defaults an omitted
				// status to 200, so the stub must mirror that for assertions.
				stub.fulfilled.push({ ...init, status: init.status ?? 200 });
			},
			abort: async (text?: string) => {
				stub.aborted.push({ text });
			},
			fallback: async () => {
				stub.fallbacks += 1;
			}
		} as unknown as Route
	};
	return stub;
}

interface StubPage {
	page: Page;
	handlers: Array<{ pattern: unknown; handler: (route: Route) => Promise<void> }>;
	unrouted: Array<{ pattern: unknown; handler?: (route: Route) => Promise<void> }>;
}

function stubPage(): StubPage {
	const recorded: StubPage = {
		handlers: [],
		unrouted: [],
		page: {
			route: async (pattern: unknown, handler: (route: Route) => Promise<void>) => {
				recorded.handlers.push({ pattern, handler });
			},
			unroute: async (pattern: unknown, handler?: (route: Route) => Promise<void>) => {
				recorded.unrouted.push({ pattern, handler });
				// Playwright semantics: the handler pair is removed, so later
				// dispatches no longer reach it.
				const at = recorded.handlers.findIndex(
					(entry) => entry.pattern === pattern && entry.handler === handler
				);
				if (at !== -1) recorded.handlers.splice(at, 1);
			}
		} as unknown as Page
	};
	return recorded;
}

/**
 * Dispatch a URL like Playwright does: reverse registration order, and a
 * handler is invoked only when its pattern matches the URL. An unmatched URL
 * reaches no handler (it would continue to earlier routes / the network).
 */
async function dispatch(stub: StubPage, url: string, method = 'GET'): Promise<StubRoute> {
	const route = stubRoute(url, method);
	for (const entry of [...stub.handlers].reverse()) {
		const pattern = entry.pattern as RegExp;
		if (pattern instanceof RegExp && !pattern.test(url)) continue;
		await entry.handler(route.route);
	}
	return route;
}

const api = (path: string) => `https://perseus.test${path}`;

describe('image-hold controller', () => {
	it('throws when a hold spec names a piece the fixture does not have', async () => {
		const images = createImageHoldController();
		expect(
			images.installFixtureImages(stubPage().page, KNOWN_ID, [
				{ endpoint: { kind: 'piece', pieceId: 999 }, outcome: 'hold' }
			])
		).rejects.toThrow(/has no piece 999/i);
	});

	it('throws for an unknown fixture id instead of registering silent routes', async () => {
		const images = createImageHoldController();
		expect(
			images.installFixtureImages(stubPage().page, 'e2e2d000-0000-4000-8000-000000000099', [
				{ endpoint: { kind: 'thumbnail' }, outcome: 'hold' }
			])
		).rejects.toThrow();
	});

	it('holds a piece image request pending until release fulfills the fixture image', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		const handle = await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'piece', pieceId: 2 }, outcome: 'hold' }
		]);

		const route = await dispatch(stub, api(`/api/puzzles/${KNOWN_ID}/pieces/2/image`));
		expect(route.fulfilled).toHaveLength(0);
		expect(route.fallbacks).toBe(0);
		expect(handle.pendingCount).toBe(1);

		await handle.release();

		expect(route.fulfilled).toHaveLength(1);
		const fulfill = route.fulfilled[0]!;
		expect(fulfill.contentType).toBe('image/svg+xml');
		expect(fulfill.body).toContain('<svg');
		// Provenance: the released response must carry the fixture-router
		// source marker (diagnostics requires it on e2e image paths) and no
		// violation marker (a released image is not a harness violation).
		expect(fulfill.headers?.[FIXTURE_ROUTER_HEADER]).toBe(FIXTURE_ROUTER_SOURCE);
		expect(fulfill.headers?.[HARNESS_VIOLATION_HEADER]).toBeUndefined();
		expect(handle.pendingCount).toBe(0);
	});

	it('cancel aborts the held image request instead of fulfilling it', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		const handle = await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'thumbnail' }, outcome: 'hold' }
		]);

		const route = await dispatch(stub, api(`/api/puzzles/${KNOWN_ID}/thumbnail`));
		expect(handle.pendingCount).toBe(1);

		await handle.cancel();

		expect(route.aborted).toHaveLength(1);
		expect(route.fulfilled).toHaveLength(0);
		expect(handle.pendingCount).toBe(0);
	});

	it('fulfills a fail spec immediately with the declared status, marked as fixture-served and not a violation', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'reference' }, outcome: 'fail', status: 404 }
		]);

		const route = await dispatch(stub, api(`/api/puzzles/${KNOWN_ID}/reference`));
		expect(route.fulfilled).toHaveLength(1);
		expect(route.fulfilled[0]!.status).toBe(404);
		expect(route.fulfilled[0]!.headers?.[FIXTURE_ROUTER_HEADER]).toBe(FIXTURE_ROUTER_SOURCE);
		expect(route.fulfilled[0]!.headers?.[HARNESS_VIOLATION_HEADER]).toBeUndefined();
	});

	it('answers a non-GET request to a held image endpoint with a 405 harness violation', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'piece', pieceId: 0 }, outcome: 'hold' }
		]);

		const route = await dispatch(stub, api(`/api/puzzles/${KNOWN_ID}/pieces/0/image`), 'POST');
		expect(route.fulfilled[0]!.status).toBe(405);
		expect(route.fulfilled[0]!.headers?.[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
	});

	it('does not claim image URLs outside the declared endpoint', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'piece', pieceId: 1 }, outcome: 'hold' }
		]);

		// A different piece's image must be left for the fixture router: the
		// hold route never runs (Playwright pattern matching), so nothing is
		// fulfilled and nothing is held.
		const other = await dispatch(stub, api(`/api/puzzles/${KNOWN_ID}/pieces/0/image`));
		expect(other.fulfilled).toHaveLength(0);
		expect(other.fallbacks).toBe(0);

		// Non-image paths under the fixture id must be left for the router too.
		const metadata = await dispatch(stub, api(`/api/puzzles/${KNOWN_ID}`));
		expect(metadata.fulfilled).toHaveLength(0);
	});

	it('claims an uppercase fixture image URL like the router does', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		const handle = await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'thumbnail' }, outcome: 'hold' }
		]);

		const route = await dispatch(stub, api(`/api/puzzles/${KNOWN_ID.toUpperCase()}/thumbnail`));
		expect(route.fallbacks).toBe(0);
		expect(handle.pendingCount).toBe(1);
	});

	it('assertClean throws while a route is held and passes after release', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		const handle = await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'piece', pieceId: 0 }, outcome: 'hold' }
		]);
		await dispatch(stub, api(`/api/puzzles/${KNOWN_ID}/pieces/0/image`));

		expect(() => images.assertClean()).toThrow(/still pending/i);

		await handle.release();
		expect(() => images.assertClean()).not.toThrow();
	});

	it('installImageUrl holds a gallery thumbnail and releases a decodable image', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		const handle = await images.installImageUrl(
			stub.page,
			/\/api\/puzzle-families\/fam-1\/thumbnail(?:\?.*)?$/
		);

		const held = await dispatch(stub, api('/api/puzzle-families/fam-1/thumbnail'));
		expect(held.fulfilled).toHaveLength(0);
		expect(handle.pendingCount).toBe(1);
		expect(held.fallbacks).toBe(0);

		await handle.release();

		expect(held.fulfilled).toHaveLength(1);
		expect(held.fulfilled[0]!.status).toBe(200);
		expect(held.fulfilled[0]!.contentType).toBe('image/svg+xml');
		// A decodable image: explicit SVG width/height so naturalWidth > 0.
		expect(held.fulfilled[0]!.body).toMatch(/<svg[^>]+width=/);
	});

	it('installImageUrl fulfills a fail spec with the declared failure status', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		await images.installImageUrl(stub.page, /\/api\/puzzle-families\/fam-1\/thumbnail(?:\?.*)?$/, {
			failStatus: 404
		});

		const route = await dispatch(stub, api('/api/puzzle-families/fam-1/thumbnail'));
		expect(route.fulfilled[0]!.status).toBe(404);
		expect(route.aborted).toHaveLength(0);
	});

	it('installImageUrl answers a non-GET request with a 405 harness violation', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		await images.installImageUrl(stub.page, /\/api\/puzzle-families\/fam-1\/thumbnail(?:\?.*)?$/);

		const route = await dispatch(stub, api('/api/puzzle-families/fam-1/thumbnail'), 'POST');
		expect(route.fulfilled[0]!.status).toBe(405);
		expect(route.fulfilled[0]!.headers?.[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
	});

	it('installImageUrl does not claim unrelated URLs', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		await images.installImageUrl(stub.page, /\/api\/puzzle-families\/fam-1\/thumbnail(?:\?.*)?$/);

		const route = await dispatch(stub, api('/api/puzzle-families/fam-other/thumbnail'));
		expect(route.fulfilled).toHaveLength(0);
		expect(route.aborted).toHaveLength(0);
	});

	it('dispose unroutes every installed pattern', async () => {
		const stub = stubPage();
		const images = createImageHoldController();
		await images.installFixtureImages(stub.page, KNOWN_ID, [
			{ endpoint: { kind: 'piece', pieceId: 0 }, outcome: 'fail', status: 404 },
			{ endpoint: { kind: 'reference' }, outcome: 'hold' }
		]);
		await images.installImageUrl(stub.page, /\/api\/puzzle-families\/fam-1\/thumbnail(?:\?.*)?$/);

		expect(stub.handlers).toHaveLength(3);
		await images.dispose();

		expect(stub.unrouted).toHaveLength(3);
		// After dispose a previously-held request falls through: the handler
		// must no longer be registered on the page.
		expect(stub.handlers).toHaveLength(0);
	});
});
