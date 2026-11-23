// settleRequestAround invariants (HPA-1032).
//
// The request-terminal barrier must reject TIMELY and detach its page
// listeners even while the wrapped action is still pending — the round-1
// regression: the timeout raced nothing until `await action()` returned,
// so a stalled action left the timeout rejection unobserved and the
// listeners armed. These tests run under bun:test with a structural stub
// of the Playwright Page event surface (the same stubbing pattern as
// diagnostics.test.ts / fixture-router.test.ts).
import { describe, expect, it } from 'bun:test';
import type { Page, Request } from '@playwright/test';
import { settleRequestAround } from './settle-request';

const AUTH_URL = 'https://perseus.test/api/auth/session';
const OTHER_URL = 'https://perseus.test/api/puzzle-families';
const AUTH_GET = { url: /\/api\/auth\/session(?:\?.*)?$/, method: 'GET' };

function stubRequest(url: string, method = 'GET'): Request {
	return {
		url: () => url,
		method: () => method
	} as unknown as Request;
}

interface Stub {
	page: Page;
	emit(event: 'requestfinished' | 'requestfailed', req: Request): void;
	listenerCount(event: string): number;
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
		},
		listenerCount: (event: string) => listeners.get(event)?.length ?? 0
	} as unknown as Page;
	return {
		page,
		emit: (event, req) => {
			for (const fn of listeners.get(event) ?? []) fn(req as never);
		},
		listenerCount: (event) => listeners.get(event)?.length ?? 0
	};
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (err) {
		return err;
	}
}

describe('settleRequestAround', () => {
	it('resolves once the matching request finishes inside the action', async () => {
		const { page, emit, listenerCount } = stub();
		await settleRequestAround(
			page,
			AUTH_GET,
			() => Promise.resolve(emit('requestfinished', stubRequest(AUTH_URL))),
			5_000
		);
		expect(listenerCount('requestfinished')).toBe(0);
		expect(listenerCount('requestfailed')).toBe(0);
	});

	it('unblocks on requestfailed — a real failure stays diagnostics-fatal', async () => {
		const { page, emit, listenerCount } = stub();
		await settleRequestAround(
			page,
			AUTH_GET,
			() => Promise.resolve(emit('requestfailed', stubRequest(AUTH_URL))),
			5_000
		);
		expect(listenerCount('requestfinished')).toBe(0);
		expect(listenerCount('requestfailed')).toBe(0);
	});

	it('ignores non-matching requests and settles on the matching one', async () => {
		const { page, emit } = stub();
		const done = settleRequestAround(
			page,
			AUTH_GET,
			() => new Promise((resolve) => setTimeout(resolve, 40)),
			5_000
		);
		emit('requestfinished', stubRequest(OTHER_URL));
		const probe = await Promise.race([
			done.then(() => 'settled' as const),
			new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20))
		]);
		expect(probe).toBe('pending');
		emit('requestfinished', stubRequest(AUTH_URL));
		await done;
	});

	it('rejects timely and detaches listeners while the action stays pending', async () => {
		const { page, listenerCount } = stub();
		const started = Date.now();
		const err = await catchError(
			settleRequestAround(page, AUTH_GET, () => new Promise(() => undefined), 50)
		);
		const elapsed = Date.now() - started;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('GET');
		expect((err as Error).message).toContain('auth');
		expect((err as Error).message).toContain('timed out after 50ms');
		// Rejected via the 50ms timeout — well before any suite/test
		// timeout — not by the action (which never resolves).
		expect(elapsed).toBeLessThan(2_000);
		// The regression itself: listeners must be detached while action()
		// is still pending — before the fix they stayed armed (and the
		// timeout rejection went unobserved) until action() returned.
		expect(listenerCount('requestfinished')).toBe(0);
		expect(listenerCount('requestfailed')).toBe(0);
	});

	it('propagates a synchronous action() throw and still detaches listeners', async () => {
		const { page, listenerCount } = stub();
		const boom = new Error('goto exploded');
		const err = await catchError(
			settleRequestAround(
				page,
				AUTH_GET,
				() => {
					throw boom;
				},
				50
			)
		);
		expect(err).toBe(boom);
		expect(listenerCount('requestfinished')).toBe(0);
		expect(listenerCount('requestfailed')).toBe(0);
	});
});
