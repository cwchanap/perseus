// Fixture-router interception invariants.
//
// The router owns the boundary between fixture traffic and ordinary traffic:
// signature-shaped ids are claimed (or hard-fail with a violation marker when
// unregistered), everything else falls through to the real backend. These
// tests run under bun:test with a structural stub of the Playwright Route —
// `handle` only reads `request().url()`/`request().method()` and calls
// `fulfill`/`fallback`.
import { describe, expect, it } from 'bun:test';
import type { Page, Request, Route } from '@playwright/test';
import { createFixtureRouter } from './fixture-router';

const KNOWN_ID = 'e2e2a000-0000-4000-8000-000000000004';
/** Signature-shaped but unregistered — a typo'd fixture id must not leak. */
const UNREGISTERED_ID = 'e2e2d000-0000-4000-8000-000000000001';
/** A real UUIDv4 that merely shares the `e2e` prefix — ordinary traffic. */
const REAL_ID_WITH_E2E_PREFIX = 'e2e11234-1234-4123-8123-123456789abc';

interface FulfillCall {
	status?: number;
	json?: unknown;
	body?: string;
	contentType?: string;
	headers?: Record<string, string>;
}

interface StubRoute {
	route: Route;
	fulfilled: FulfillCall[];
	fallbacks: number;
}

function stubRoute(url: string, method = 'GET'): StubRoute {
	const stub: StubRoute = {
		fulfilled: [],
		fallbacks: 0,
		route: {
			request: () =>
				({
					url: () => url,
					method: () => method
				}) as unknown as Request,
			fulfill: async (init: FulfillCall) => {
				stub.fulfilled.push(init);
			},
			fallback: async () => {
				stub.fallbacks += 1;
			}
		} as unknown as Route
	};
	return stub;
}

async function installHandler(): Promise<{
	handle: (route: Route) => Promise<void>;
	pattern: unknown;
}> {
	let handler: ((route: Route) => Promise<void>) | undefined;
	let pattern: unknown;
	const page = {
		route: async (p: unknown, h: (route: Route) => Promise<void>) => {
			pattern = p;
			handler = h;
		}
	} as unknown as Page;
	await createFixtureRouter().install(page);
	if (!handler) throw new Error('router did not register a handler');
	return { handle: handler, pattern };
}

const api = (path: string) => `https://perseus.test${path}`;

describe('fixture-router interception', () => {
	it('lets a real UUID that merely shares the e2e prefix reach the backend', async () => {
		const { handle, pattern } = await installHandler();
		for (const path of [
			`/api/puzzles/${REAL_ID_WITH_E2E_PREFIX}`,
			`/api/puzzles/${REAL_ID_WITH_E2E_PREFIX}/complete`,
			`/api/puzzles/${REAL_ID_WITH_E2E_PREFIX}/pieces/0/image`
		]) {
			// The route pattern is the first gate: a real id must not even
			// enter the fixture handler.
			expect((pattern as RegExp).test(api(path))).toBe(false);
			const stub = stubRoute(api(path), path.endsWith('/complete') ? 'POST' : 'GET');
			await handle(stub.route);
			expect(stub.fallbacks).toBe(1);
			expect(stub.fulfilled).toHaveLength(0);
		}
	});

	it('404s an unregistered signature-shaped id instead of leaking it', async () => {
		const { handle } = await installHandler();
		const stub = stubRoute(api(`/api/puzzles/${UNREGISTERED_ID}`));
		await handle(stub.route);
		expect(stub.fallbacks).toBe(0);
		expect(stub.fulfilled).toHaveLength(1);
		expect(stub.fulfilled[0]?.status).toBe(404);
		expect(stub.fulfilled[0]?.headers?.['x-perseus-e2e-violation']).toBe('unknown_e2e_fixture');
	});

	it('serves metadata for a known fixture id with the router marker', async () => {
		const { handle } = await installHandler();
		const stub = stubRoute(api(`/api/puzzles/${KNOWN_ID}`));
		await handle(stub.route);
		expect(stub.fulfilled).toHaveLength(1);
		expect(stub.fulfilled[0]?.headers?.['x-perseus-e2e-source']).toBe('fixture-router');
		const body = stub.fulfilled[0]?.json as { id: string };
		expect(body.id).toBe(KNOWN_ID);
	});

	it('claims uppercase fixture requests and normalizes the id', async () => {
		const { handle } = await installHandler();
		const stub = stubRoute(api(`/api/puzzles/${KNOWN_ID.toUpperCase()}`));
		await handle(stub.route);
		expect(stub.fallbacks).toBe(0);
		expect(stub.fulfilled).toHaveLength(1);
		expect(stub.fulfilled[0]?.headers?.['x-perseus-e2e-source']).toBe('fixture-router');
	});

	it('blocks an uppercase undeclared completion POST', async () => {
		const { handle } = await installHandler();
		const stub = stubRoute(api(`/api/puzzles/${KNOWN_ID.toUpperCase()}/complete`), 'POST');
		await handle(stub.route);
		expect(stub.fallbacks).toBe(0);
		expect(stub.fulfilled).toHaveLength(1);
		expect(stub.fulfilled[0]?.status).toBe(403);
		expect(stub.fulfilled[0]?.headers?.['x-perseus-e2e-violation']).toBe('undeclared_completion');
	});

	it('serves a piece image for an uppercase fixture path', async () => {
		const { handle } = await installHandler();
		const stub = stubRoute(api(`/api/puzzles/${KNOWN_ID.toUpperCase()}/pieces/0/image`));
		await handle(stub.route);
		expect(stub.fallbacks).toBe(0);
		expect(stub.fulfilled).toHaveLength(1);
		expect(stub.fulfilled[0]?.contentType).toContain('svg');
	});
});
