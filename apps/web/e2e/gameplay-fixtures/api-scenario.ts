// API outcome simulation + request recording for the completion endpoint.
//
// The puzzle page calls `recordCompletion(puzzleId, request)` which POSTs to
// `/api/puzzles/:id/complete`. The ApiScenarioController installs a route for
// that path under a known fixture id and drives the response from a bounded
// `CompletionScenario` union, so a test can deterministically exercise success,
// deferred success, network failure, and each meaningful HTTP failure status.
//
// Every intercepted request is recorded (url, method, headers, body) so tests
// can assert on the sealed payload the puzzle page sent. Deferred routes stay
// pending until `release()`/`cancel()` is called, and `assertClean()` refuses
// to tear down while any route is still held — surfacing its URL and body so a
// forgotten release is obvious.
//
// HTTP method enforcement: the controller enforces POST for /complete. A
// non-POST request receives a 405 with the harness violation header so a
// client-side method regression cannot pass E2E silently.
//
// The route pattern accepts an optional query string (e.g. `/complete?retry=1`)
// so a future client-side change that appends query parameters does not bypass
// the controller and fall through to the fixture router's 403 default.
import type { Page, Route } from '@playwright/test';
import type { CompletionAwards } from '@perseus/types';
import { FIXTURE_ROUTER_HEADER, HARNESS_VIOLATION_HEADER } from './fixture-router';

/** Provenance value stamped on every scenario-fulfilled completion response. */
export const SCENARIO_SOURCE = 'api-scenario';

function scenarioHeaders(): Record<string, string> {
	return { [FIXTURE_ROUTER_HEADER]: SCENARIO_SOURCE };
}

function violationHeaders(violation: string): Record<string, string> {
	return { [FIXTURE_ROUTER_HEADER]: SCENARIO_SOURCE, [HARNESS_VIOLATION_HEADER]: violation };
}

/**
 * Bounded union of completion outcomes Task 7 can drive. Each kind maps to a
 * concrete route behavior.
 */
export type CompletionScenario =
	| { kind: 'success'; awards?: CompletionAwards }
	| { kind: 'awarded-success-once'; awards: CompletionAwards }
	| { kind: 'deferred-success'; awards?: CompletionAwards }
	| { kind: 'network-abort' }
	| { kind: 'http-failure'; status: 400 | 401 | 404 | 409 | 429 | 500 }
	| {
			kind: 'retry-sequence';
			failureStatus: 400 | 401 | 404 | 409 | 429 | 500;
			awards?: CompletionAwards;
	  };

export interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	bodyText: string | null;
	/** Parsed JSON body when the request body is valid JSON, else `undefined`. */
	bodyJson: unknown;
}

/** Read-only projection of a still-pending deferred route (for teardown reports). */
export interface DeferredRouteInfo {
	url: string;
	method: string;
	bodyText: string | null;
}

export interface DeferredHandle {
	readonly pendingCount: number;
	readonly released: boolean;
	readonly cancelled: boolean;
	/** Fulfill every held deferred route with a 200 success. */
	release(): Promise<void>;
	/** Abort every held deferred route (simulates a cancelled request). */
	cancel(): Promise<void>;
}

interface PendingRoute {
	url: string;
	method: string;
	bodyText: string | null;
	route: Route;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex matching a known fixture's completion URL, with an optional query
 * string (e.g. `/complete?retry=1`). Shared with diagnostics so the
 * controller's `page.route` pattern and diagnostics' expected-path check
 * cannot drift apart.
 */
export function completionUrlPattern(fixtureId: string): RegExp {
	return new RegExp(`/api/puzzles/${escapeRegExp(fixtureId)}/complete(?:\\?.*)?$`);
}

export interface ApiScenarioController {
	/**
	 * Register the completion route for `fixtureId`. Returns the deferred handle
	 * (functional for `deferred-success`; a no-op handle for the other scenarios).
	 */
	install(page: Page, fixtureId: string, scenario: CompletionScenario): Promise<DeferredHandle>;
	/** All recorded completion requests, in arrival order. */
	readonly recordedRequests: ReadonlyArray<RecordedRequest>;
	/** Details of every deferred route still pending release/cancel. */
	pendingDeferred(): DeferredRouteInfo[];
	/** Throw (with details) if any deferred route is still held. */
	assertClean(): void;
	dispose(): void;
}

export function createApiScenarioController(): ApiScenarioController {
	const recorded: RecordedRequest[] = [];
	const pending: PendingRoute[] = [];
	let released = false;
	let cancelled = false;

	function record(route: Route): void {
		const request = route.request();
		const bodyText = request.postData();
		let bodyJson: unknown;
		try {
			bodyJson = bodyText === null ? undefined : JSON.parse(bodyText);
		} catch {
			bodyJson = undefined;
		}
		recorded.push({
			url: request.url(),
			method: request.method(),
			headers: request.headers(),
			bodyText,
			bodyJson
		});
	}

	const handle: DeferredHandle = {
		get pendingCount() {
			return pending.length;
		},
		get released() {
			return released;
		},
		get cancelled() {
			return cancelled;
		},
		async release() {
			released = true;
			const held = pending.splice(0);
			for (const entry of held) {
				await entry.route.fulfill({
					status: 200,
					json: { ok: true },
					headers: scenarioHeaders()
				});
			}
		},
		async cancel() {
			cancelled = true;
			const held = pending.splice(0);
			for (const entry of held) {
				await entry.route.abort('failed');
			}
		}
	};

	async function applyScenario(
		route: Route,
		scenario: CompletionScenario,
		attempt: number
	): Promise<void> {
		switch (scenario.kind) {
			case 'success': {
				const json =
					scenario.awards !== undefined ? { ok: true, awards: scenario.awards } : { ok: true };
				await route.fulfill({ status: 200, json, headers: scenarioHeaders() });
				return;
			}
			case 'awarded-success-once': {
				const json = attempt === 1 ? { ok: true, awards: scenario.awards } : { ok: true };
				await route.fulfill({ status: 200, json, headers: scenarioHeaders() });
				return;
			}
			case 'http-failure': {
				const status = scenario.status;
				await route.fulfill({
					status,
					json: { error: 'http_failure', status },
					headers: scenarioHeaders()
				});
				return;
			}
			case 'retry-sequence': {
				// Controller-owned failure-then-success sequence: the first
				// attempt fulfills with `failureStatus`, every subsequent
				// attempt fulfills with 200. The controller records every
				// request, so a test can assert on both the failed and the
				// retried sealed payloads. Both responses carry the api-scenario
				// provenance marker, so diagnostics can prove the controller
				// (not a custom route) handled each attempt.
				const failed = attempt === 1;
				const status = failed ? scenario.failureStatus : 200;
				const json = failed
					? { error: 'http_failure', status }
					: scenario.awards !== undefined
						? { ok: true, awards: scenario.awards }
						: { ok: true };
				await route.fulfill({
					status,
					json,
					headers: scenarioHeaders()
				});
				return;
			}
			case 'network-abort': {
				await route.abort('failed');
				return;
			}
			case 'deferred-success': {
				// Hold the route: do NOT fulfill/abort. release()/cancel() resolves it.
				const request = route.request();
				pending.push({
					url: request.url(),
					method: request.method(),
					bodyText: request.postData(),
					route
				});
				return;
			}
			default: {
				// Exhaustiveness guard.
				const exhaustive: never = scenario;
				throw new Error(`applyScenario: unhandled scenario ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	function assertClean() {
		if (pending.length > 0) {
			const details = pending
				.map(
					(p, i) => `  [#${i + 1}] ${p.method} ${p.url}` + (p.bodyText ? ` body=${p.bodyText}` : '')
				)
				.join('\n');
			throw new Error(
				`ApiScenarioController teardown: ${pending.length} deferred route(s) still pending:\n${details}`
			);
		}
	}

	return {
		async install(page: Page, fixtureId: string, scenario: CompletionScenario) {
			// Accept an optional query string (e.g. `/complete?retry=1`) so a
			// future client-side change that appends query parameters does not
			// bypass the controller and fall through to the fixture router's
			// 403 default.
			const pattern = completionUrlPattern(fixtureId);
			// Per-install attempt counter so stateful scenarios (retry-sequence)
			// can vary their response by attempt without leaking state across
			// installs. Stateless scenarios ignore it.
			let attempts = 0;
			await page.route(pattern, async (route) => {
				const method = route.request().method();
				if (method !== 'POST') {
					await route.fulfill({
						status: 405,
						json: { error: 'method_not_allowed', allowed: 'POST' },
						headers: violationHeaders('method_not_allowed')
					});
					return;
				}
				record(route);
				attempts += 1;
				await applyScenario(route, scenario, attempts);
			});
			return handle;
		},
		get recordedRequests() {
			return recorded;
		},
		pendingDeferred(): DeferredRouteInfo[] {
			return pending.map(({ url, method, bodyText }) => ({ url, method, bodyText }));
		},
		assertClean() {
			assertClean();
		},
		// Call the local function rather than this.assertClean(): dispose() is
		// typically destructured off the controller before the call, which would
		// make `this` undefined and crash before the pending-route check runs.
		dispose() {
			assertClean();
		}
	};
}
