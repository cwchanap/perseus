// Diagnostics declared-image-failure invariants (HPA-1029).
//
// Intentional image failures (a declared 404 or a cancelled image request)
// must be narrowly expected by diagnostics: exact URL, method GET, provenance
// marker, declared status — while every unrelated failure stays fatal. These
// tests run under bun:test with a structural stub of the Playwright Page
// event surface (the same stubbing pattern as fixture-router.test.ts).
import { describe, expect, it } from 'bun:test';
import type { Page } from '@playwright/test';
import {
	createPageDiagnostics,
	type DeclaredImageFailure,
	type PageDiagnostics
} from './diagnostics';
import { FIXTURE_ROUTER_HEADER, FIXTURE_ROUTER_SOURCE } from '../gameplay-fixtures/fixture-router';

const THUMBNAIL_URL =
	'https://perseus.test/api/puzzles/e2e2a000-0000-4000-8000-000000000004/thumbnail';
const OTHER_IMAGE_URL =
	'https://perseus.test/api/puzzles/e2e2a000-0000-4000-8000-000000000004/pieces/2/image';

interface Stub {
	diagnostics: PageDiagnostics;
	emitConsole(msg: {
		type: () => string;
		text: () => string;
		location: () => { url: string };
	}): void;
	emitPageError(err: Error): void;
	emitRequestFailed(req: {
		url: () => string;
		method: () => string;
		failure: () => { errorText: string } | null;
	}): void;
	emitResponse(res: {
		url: () => string;
		status: () => number;
		headers: () => Record<string, string>;
		request: () => { method: () => string };
	}): void;
}

function stub(): Stub {
	const listeners = new Map<string, Array<(arg: never) => void>>();
	const page = {
		on: (event: string, fn: (arg: never) => void) => {
			const list = listeners.get(event) ?? [];
			list.push(fn);
			listeners.set(event, list);
		},
		off: (event: string, fn: (arg: never) => void) => {
			const list = listeners.get(event) ?? [];
			const at = list.indexOf(fn);
			if (at !== -1) list.splice(at, 1);
		}
	} as unknown as Page;
	const diagnostics = createPageDiagnostics(page);
	const emit = (event: string, arg: unknown) => {
		for (const fn of listeners.get(event) ?? []) fn(arg as never);
	};
	return {
		diagnostics,
		emitConsole: (msg) => emit('console', msg),
		emitPageError: (err) => emit('pageerror', err),
		emitRequestFailed: (req) => emit('requestfailed', req),
		emitResponse: (res) => emit('response', res)
	};
}

function consoleError(text: string, url: string): Parameters<Stub['emitConsole']>[0] {
	return { type: () => 'error', text: () => text, location: () => ({ url }) };
}

function failedRequest(url: string, method = 'GET'): Parameters<Stub['emitRequestFailed']>[0] {
	return {
		url: () => url,
		method: () => method,
		failure: () => ({ errorText: 'net::ERR_FAILED' })
	};
}

function imageResponse(
	url: string,
	status: number,
	method = 'GET',
	marker: string | undefined = FIXTURE_ROUTER_SOURCE
): Parameters<Stub['emitResponse']>[0] {
	const headers: Record<string, string> = {};
	if (marker !== undefined && marker !== '') headers[FIXTURE_ROUTER_HEADER] = marker;
	return {
		url: () => url,
		status: () => status,
		headers: () => headers,
		request: () => ({ method: () => method })
	};
}

/** A fixture-image response with NO provenance marker (a real-backend answer). */
function unmarkedImageResponse(
	url: string,
	status: number,
	method = 'GET'
): Parameters<Stub['emitResponse']>[0] {
	return imageResponse(url, status, method, '');
}

/** Hand-built declaration matching the fixture thumbnail URL exactly. */
const DECLARED_404: DeclaredImageFailure = {
	url: new RegExp('/api/puzzles/e2e2a000-0000-4000-8000-000000000004/thumbnail(?:\\?.*)?$', 'i'),
	method: 'GET',
	status: 404,
	outcome: 'status'
};

/** The browser console entry Chromium emits for a 404 resource. */
const CONSOLE_404 =
	'Failed to load resource: the server responded with a status of 404 (Not Found)';
/** The browser console entry Chromium emits for an aborted resource. */
const CONSOLE_ABORT = 'Failed to load resource: net::ERR_FAILED';

describe('diagnostics declared image failures', () => {
	it('expects a declared image failure: exact URL, GET, router provenance, declared status', () => {
		const { diagnostics, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		emitResponse(imageResponse(THUMBNAIL_URL, 404));

		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();
	});

	it('flags a declared image URL that answers with a different status', () => {
		const { diagnostics, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		emitResponse(imageResponse(THUMBNAIL_URL, 500));

		expect(diagnostics.unexpectedResponses).toHaveLength(1);
		expect(() => diagnostics.assertNoUnexpectedErrors()).toThrow(/unexpected responses/);
	});

	it('flags a declared image URL answered without the fixture-router provenance marker', () => {
		const { diagnostics, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		// No marker: the real backend answered the fixture image path.
		emitResponse(unmarkedImageResponse(THUMBNAIL_URL, 404, 'GET'));

		expect(diagnostics.leakedFixtureRequests).toHaveLength(1);
	});

	it('flags a declared image URL requested with the wrong method', () => {
		const { diagnostics, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		emitResponse(imageResponse(THUMBNAIL_URL, 404, 'POST'));

		expect(diagnostics.unexpectedResponses).toHaveLength(1);
	});

	it('allows an aborted declared image request and flags any response arriving for it', () => {
		const { diagnostics, emitRequestFailed, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([{ ...DECLARED_404, status: 404, outcome: 'abort' }]);

		emitRequestFailed(failedRequest(THUMBNAIL_URL));
		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();

		// An abort outcome must never produce a response — one arriving means
		// the abort did not happen (regression or impersonating route).
		emitResponse(imageResponse(THUMBNAIL_URL, 404));
		expect(diagnostics.unexpectedResponses).toHaveLength(1);
	});

	it('keeps an undeclared image 404 fatal', () => {
		const { diagnostics, emitResponse } = stub();

		emitResponse(imageResponse(OTHER_IMAGE_URL, 404));

		expect(diagnostics.unexpectedResponses).toHaveLength(1);
	});

	it('narrowly allows the browser failed-resource console entry attributable to the declared image', () => {
		const { diagnostics, emitConsole, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		// The declared failure actually happened on the network...
		emitResponse(imageResponse(THUMBNAIL_URL, 404));
		// ...so its failed-resource console entry (attributed by the console
		// location URL) is expected.
		emitConsole(consoleError(CONSOLE_404, THUMBNAIL_URL));

		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();
	});

	it('keeps a failed-resource console entry for a different URL fatal', () => {
		const { diagnostics, emitConsole, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		emitResponse(imageResponse(THUMBNAIL_URL, 404));
		// A different image URL failed — not the declared one.
		emitConsole(consoleError(CONSOLE_404, OTHER_IMAGE_URL));

		expect(diagnostics.consoleErrors).toHaveLength(1);
	});

	it('keeps a failed-resource console entry fatal when no image failure is declared', () => {
		const { diagnostics, emitConsole } = stub();

		emitConsole(consoleError(CONSOLE_404, THUMBNAIL_URL));

		expect(diagnostics.consoleErrors).toHaveLength(1);
	});

	it('keeps an unrelated failed request fatal while an image failure is declared', () => {
		const { diagnostics, emitRequestFailed } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		emitRequestFailed(failedRequest('https://perseus.test/api/puzzles/other-piece/image'));

		expect(diagnostics.failedRequests).toHaveLength(1);
	});

	it('keeps a non-failed-resource console error fatal even for the declared URL', () => {
		const { diagnostics, emitConsole, emitResponse } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		emitResponse(imageResponse(THUMBNAIL_URL, 404));
		// An application error is never allowlisted by the image declaration.
		emitConsole(consoleError('TypeError: cannot read properties of undefined', THUMBNAIL_URL));

		expect(diagnostics.consoleErrors).toHaveLength(1);
	});

	it('allows an aborted declared image request console entry by location URL', () => {
		const { diagnostics, emitConsole, emitRequestFailed } = stub();
		diagnostics.setDeclaredImageFailures([{ ...DECLARED_404, status: 404, outcome: 'abort' }]);

		emitRequestFailed(failedRequest(THUMBNAIL_URL));
		emitConsole(consoleError(CONSOLE_ABORT, THUMBNAIL_URL));

		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();
	});

	it('keeps an unrelated page error fatal while an image failure is declared', () => {
		const { diagnostics, emitPageError } = stub();
		diagnostics.setDeclaredImageFailures([DECLARED_404]);

		emitPageError(new Error('uncaught application error'));

		expect(diagnostics.pageErrors).toHaveLength(1);
		expect(() => diagnostics.assertNoUnexpectedErrors()).toThrow(/page errors/);
	});

	it('dispose removes the page listeners', () => {
		const listeners = new Map<string, Array<(arg: never) => void>>();
		const page = {
			on: (event: string, fn: (arg: never) => void) => {
				const list = listeners.get(event) ?? [];
				list.push(fn);
				listeners.set(event, list);
			},
			off: (event: string, fn: (arg: never) => void) => {
				const list = listeners.get(event) ?? [];
				const at = list.indexOf(fn);
				if (at !== -1) list.splice(at, 1);
			}
		} as unknown as Page;
		const diagnostics = createPageDiagnostics(page);
		diagnostics.dispose();

		expect([...listeners.values()].every((list) => list.length === 0)).toBe(true);
	});
});
