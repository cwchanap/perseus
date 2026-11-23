// Bounded request-terminal barrier for E2E synchronization (HPA-1032).
//
// `route.fulfill()` resolves before the page has finished the request, and
// 'load'/'domcontentloaded' do not wait for fire-and-forget fetches — so a
// `page.reload()` issued while such a request is still in flight aborts it
// and page diagnostics records `net::ERR_ABORTED` as an unexpected failure.
// `settleRequestAround` runs `action` (a navigation or an image-hold
// release) and resolves only once the next matching request reaches a
// terminal state — `requestfinished` or `requestfailed`, whichever comes
// first.
//
// Timing/cleanup contract: listeners are registered BEFORE the action so a
// request that terminates before the action resolves is still captured, and
// they are always removed again — on settle, on timeout, or on an action()
// rejection (which propagates to the caller). The timeout races the
// COMBINED action+terminal promise from the start, so an action() that
// stalls still rejects promptly at `timeoutMs` instead of leaving the
// timeout unobserved with listeners armed. A request that fails still
// unblocks the caller — the failure stays fatal via the diagnostics
// listener; a request that never terminates fails the test with a labeled
// timeout instead of hanging.
import type { Page, Request } from '@playwright/test';

/** The request this barrier waits on: exact URL regex + HTTP method. */
export interface SettledRequest {
	url: RegExp;
	method: string;
}

export async function settleRequestAround(
	page: Page,
	request: SettledRequest,
	action: () => Promise<unknown>,
	timeoutMs = 15_000
): Promise<void> {
	const matches = (req: Request) => request.url.test(req.url()) && req.method() === request.method;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveTerminal: () => void = () => undefined;
	const terminal = new Promise<void>((resolve) => {
		resolveTerminal = resolve;
	});
	function finish(): void {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		page.off('requestfinished', onFinished);
		page.off('requestfailed', onFailed);
		resolveTerminal();
	}
	const onFinished = (req: Request) => {
		if (matches(req)) finish();
	};
	const onFailed = (req: Request) => {
		if (matches(req)) finish();
	};
	page.on('requestfinished', onFinished);
	page.on('requestfailed', onFailed);
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`settleRequestAround: timed out after ${timeoutMs}ms waiting for ${request.method} ${request.url} (action still pending or request never terminated)`
					)
				),
			timeoutMs
		);
	});
	try {
		// The timeout races the COMBINED action+terminal promise from the
		// start — a stalled action() must still reject promptly instead of
		// leaving the timeout unobserved and the listeners armed. Promise.race
		// attaches handlers to every branch, so the combined promise's
		// eventual settle (resolve or reject) is always observed, and a
		// synchronous action() throw propagates through this try.
		await Promise.race([Promise.all([action(), terminal]), timeout]);
	} finally {
		// Always disarm the timer and detach the listeners. `terminal`
		// never rejects and `timeout` is disarmed before it can fire, so no
		// losing branch can produce an unhandled rejection — now or later.
		finish();
	}
}
