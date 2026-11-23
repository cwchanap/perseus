// settleRequestAround / settleNetworkQuiet invariants (HPA-1032).
//
// The request-terminal barrier must reject TIMELY and detach its page
// listeners even while the wrapped action is still pending — the round-1
// regression: the timeout raced nothing until `await action()` returned,
// so a stalled action left the timeout rejection unobserved and the
// listeners armed. settleNetworkQuiet must hold for requests it observed
// and let their terminal events push the quiet window out — a stale
// 'networkidle' reuse is exactly what it replaces. These tests run under
// bun:test with a structural stub of the Playwright Page event surface
// (the same stubbing pattern as diagnostics.test.ts / fixture-router.test.ts).
import { describe, expect, it, jest } from 'bun:test';
import type { Page, Request } from '@playwright/test';
import { settleNetworkQuiet, settleRequestAround } from './settle-request';

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
	emit(event: 'request' | 'requestfinished' | 'requestfailed', req: Request): void;
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Yield the microtask queue so fake-clock timer continuations run. */
const flushMicrotasks = async (n = 10): Promise<void> => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

/**
 * Deterministic clock for quiet-window assertions. jest.useFakeTimers is
 * not portable across the bun versions this repo runs: 1.3.x fires the
 * timers but snaps Date.now back to real time on advance, so a fake-time
 * deadline met a real-time now. Spying on Date.now + setTimeout keeps
 * the two coherent on every version and removes the scheduler entirely.
 */
function spyClock(): { advance(ms: number): Promise<void>; restore(): void } {
	let now = 1_000;
	const pending: Array<{ at: number; fire: () => void }> = [];
	const spyNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
	const spyTimeout = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
		fn: () => void,
		ms = 0
	) => {
		pending.push({ at: now + ms, fire: fn });
		return 0;
	}) as never);
	return {
		advance: async (ms) => {
			const until = now + ms;
			for (;;) {
				pending.sort((a, b) => a.at - b.at);
				const next = pending[0];
				if (!next || next.at > until) break;
				pending.shift();
				now = next.at;
				next.fire();
				await flushMicrotasks();
			}
			now = until;
			await flushMicrotasks();
		},
		restore: () => {
			spyNow.mockRestore();
			spyTimeout.mockRestore();
		}
	};
}

/** 'settled' once `done` resolves, else 'pending' after `ms`. */
async function probe(done: Promise<unknown>, ms = 20): Promise<'settled' | 'pending'> {
	return Promise.race([
		done.then(() => 'settled' as const),
		sleep(ms).then(() => 'pending' as const)
	]);
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
		let resolveAction!: () => void;
		const action = new Promise<void>((resolve) => {
			resolveAction = resolve;
		});
		const done = settleRequestAround(page, AUTH_GET, () => action, 5_000);
		// Complete the action FIRST so any later 'pending' can only mean
		// the terminal events did not match — not that the action is still
		// running.
		resolveAction();
		emit('requestfinished', stubRequest(OTHER_URL)); // URL mismatch
		emit('requestfinished', stubRequest(AUTH_URL, 'POST')); // method mismatch
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

	it('keeps the deadline armed when the request settles while the action stays pending', async () => {
		const { page, emit, listenerCount } = stub();
		const started = Date.now();
		const err = await catchError(
			settleRequestAround(
				page,
				AUTH_GET,
				// The terminal event fires (listeners are already
				// registered) but the action never resolves — e.g. auth
				// finished while goto() is still blocked elsewhere. The
				// 50ms deadline must still reject; the terminal event
				// must not disarm it.
				() =>
					new Promise(() => {
						emit('requestfinished', stubRequest(AUTH_URL));
					}),
				50
			)
		);
		const elapsed = Date.now() - started;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('timed out after 50ms');
		// Rejected via the still-armed 50ms deadline, not by the
		// action and not by this test's own timeout.
		expect(elapsed).toBeLessThan(2_000);
		expect(listenerCount('requestfinished')).toBe(0);
		expect(listenerCount('requestfailed')).toBe(0);
	}, 3_000);

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

describe('settleNetworkQuiet', () => {
	it('holds while an observed request is in flight and lets its terminal restart the quiet window', async () => {
		const { page, emit, listenerCount } = stub();
		const started = Date.now();
		const done = settleNetworkQuiet(page, 100, 5_000);
		const req = stubRequest(AUTH_URL);
		emit('request', req);

		// Past the quiet window with the request still in flight: the
		// barrier must not resolve — unlike a stale 'networkidle'.
		await sleep(150);
		expect(await probe(done)).toBe('pending');

		// The terminal restarts the window: still pending immediately
		// after it, resolving only once another full window passes.
		emit('requestfinished', req);
		expect(await probe(done)).toBe('pending');
		await done;
		expect(Date.now() - started).toBeGreaterThanOrEqual(200);
		expect(listenerCount('request')).toBe(0);
		expect(listenerCount('requestfinished')).toBe(0);
		expect(listenerCount('requestfailed')).toBe(0);
	}, 10_000);

	it('lets a terminal event for a request it never saw start push the quiet window out', async () => {
		const clock = spyClock();
		try {
			const { page, emit } = stub();
			const done = settleNetworkQuiet(page, 600, 5_000);
			let settled = false;
			void done.then(() => {
				settled = true;
			});
			// A request in flight before this call is invisible until it
			// terminates — its terminal event must still bump the window so
			// the drain does not end ahead of a just-finished late request.
			// Emit 150ms into the window (t=1150): an unbumped barrier would
			// exit at t=1600, the bump pushes expiry to t=1750. The clock is
			// exact — no scheduler stall can delay the emit past the window
			// edge or a poll past an assertion, so a missed bump cannot be
			// masked and a correct drain cannot be flunked.
			await clock.advance(150);
			emit('requestfinished', stubRequest(AUTH_URL));
			await clock.advance(475); // t=1625: past the unbumped expiry
			expect(settled).toBe(false);
			await clock.advance(200); // t=1825: past the bumped expiry
			await done;
			expect(settled).toBe(true);
		} finally {
			clock.restore();
		}
	}, 10_000);

	it('rejects timely and detaches listeners while a request never terminates', async () => {
		const { page, emit, listenerCount } = stub();
		const started = Date.now();
		const err = await catchError(
			(async () => {
				const done = settleNetworkQuiet(page, 100, 80);
				emit('request', stubRequest(AUTH_URL));
				await done;
			})()
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('timed out after 80ms');
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(listenerCount('request')).toBe(0);
		expect(listenerCount('requestfinished')).toBe(0);
		expect(listenerCount('requestfailed')).toBe(0);
	});
});
