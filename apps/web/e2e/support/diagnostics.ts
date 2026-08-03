// Page diagnostics for deterministic gameplay E2E.
//
// Attached once per GameplayPage, BEFORE navigation, so it captures the full
// lifecycle: console errors, uncaught page errors, failed requests, and
// unexpected responses. Expected failures (a driven completion http-failure,
// an aborted submission) are suppressed via narrow scenario allowlists so a
// deliberate failure does not look like a regression.
//
// Fixture-request leak detection: every `e2e-*` response must be answered by
// the fixture router (it stamps the `x-perseus-e2e-source` marker) or, for the
// `/complete` path, by the ApiScenarioController (marker `api-scenario`). Any
// `e2e-*` response that reaches the real backend (no marker, not a completion
// path) is a leak and fails teardown.
//
// Harness violation detection: responses carrying `x-perseus-e2e-violation`
// (undeclared completion, wrong HTTP method) are recorded as harness violations
// and fail teardown regardless of HTTP status — so a regression that bypasses
// the scenario controller or uses the wrong method cannot pass E2E silently.
//
// Completion provenance: when a completion scenario is declared, diagnostics
// requires the response marker to equal `api-scenario` (the controller's
// provenance), validates the fixture ID matches the declared scenario, and
// confirms the method is POST. A response from the fixture router's 403
// default (or a real-backend response with the expected status) is flagged as
// unexpected — proving the configured scenario actually handled the response.
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';
import type { CompletionScenario } from '../gameplay-fixtures/api-scenario';
import { SCENARIO_SOURCE } from '../gameplay-fixtures/api-scenario';
import {
	FIXTURE_ROUTER_HEADER,
	HARNESS_VIOLATION_HEADER
} from '../gameplay-fixtures/fixture-router';

const E2E_PATH = /\/api\/puzzles\/e2e-[a-z0-9-]+/;
const COMPLETION_PATH = /\/api\/puzzles\/e2e-[a-z0-9-]+\/complete(?:\?.*)?$/;
/** Extracts the fixture id from an e2e-* completion URL. */
const FIXTURE_ID_FROM_URL = /\/api\/puzzles\/(e2e-[a-z0-9-]+)\/complete/;

export interface ConsoleErrorRecord {
	text: string;
}

export interface PageErrorRecord {
	message: string;
}

export interface FailedRequestRecord {
	url: string;
	method: string;
	failure: string;
}

export interface UnexpectedResponseRecord {
	url: string;
	method: string;
	status: number;
}

export interface LeakedFixtureRequestRecord {
	url: string;
	method: string;
	status: number;
}

export interface HarnessViolationRecord {
	url: string;
	method: string;
	status: number;
	violation: string;
}

export interface PageDiagnostics {
	/** Declare the active completion scenario so its outcome is expected. */
	setCompletion(fixtureId: string | undefined, scenario: CompletionScenario | undefined): void;
	/** Allowlist a console-error message substring as expected. */
	expectConsoleError(messageSubstring: string): void;
	readonly consoleErrors: readonly ConsoleErrorRecord[];
	readonly pageErrors: readonly PageErrorRecord[];
	readonly failedRequests: readonly FailedRequestRecord[];
	readonly unexpectedResponses: readonly UnexpectedResponseRecord[];
	readonly leakedFixtureRequests: readonly LeakedFixtureRequestRecord[];
	readonly harnessViolations: readonly HarnessViolationRecord[];
	/** Throw if any non-allowlisted console/page/failed/unexpected error occurred. */
	assertNoUnexpectedErrors(): void;
	/** Throw if any e2e-* request leaked past the router to the real backend. */
	assertNoUnexpectedFixtureRequests(): void;
	dispose(): void;
}

interface ExpectedCompletion {
	fixtureId: string;
	scenario: CompletionScenario;
}

export function createPageDiagnostics(page: Page): PageDiagnostics {
	const consoleErrors: ConsoleErrorRecord[] = [];
	const pageErrors: PageErrorRecord[] = [];
	const failedRequests: FailedRequestRecord[] = [];
	const unexpectedResponses: UnexpectedResponseRecord[] = [];
	const leakedFixtureRequests: LeakedFixtureRequestRecord[] = [];
	const harnessViolations: HarnessViolationRecord[] = [];
	const expectedConsoleSubstrings: string[] = [];
	let expectedCompletion: ExpectedCompletion | undefined;

	function isExpectedConsole(text: string): boolean {
		return expectedConsoleSubstrings.some((sub) => text.includes(sub));
	}

	function onConsole(msg: ConsoleMessage): void {
		if (msg.type() !== 'error') return;
		const text = msg.text();
		if (isExpectedConsole(text)) return;
		consoleErrors.push({ text });
	}

	function onPageError(err: Error): void {
		pageErrors.push({ message: err.message });
	}

	/** Build a regex matching only the declared fixture's completion URL. */
	function expectedCompletionPath(): RegExp | null {
		if (!expectedCompletion) return null;
		const escaped = expectedCompletion.fixtureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`/api/puzzles/${escaped}/complete(?:\\?.*)?$`);
	}

	function onRequestFailed(request: Request): void {
		const url = request.url();
		// A deliberately aborted completion submission is expected — but only
		// for the configured fixture's completion URL, not any e2e-* completion.
		if (expectedCompletion?.scenario.kind === 'network-abort') {
			const path = expectedCompletionPath();
			if (path && path.test(url) && request.method() === 'POST') {
				return;
			}
		}
		failedRequests.push({
			url,
			method: request.method(),
			failure: request.failure()?.errorText ?? 'unknown'
		});
	}

	function onResponse(response: Response): void {
		const request = response.request();
		const method = request.method();
		let pathname: string;
		try {
			pathname = new URL(response.url()).pathname;
		} catch {
			return;
		}

		const status = response.status();
		const headers = response.headers();
		const marker = headers[FIXTURE_ROUTER_HEADER];

		// Harness violations (undeclared completion, wrong method) are flagged
		// first, regardless of path or status. The violation header is only set
		// by the harness, so its presence proves the response is a harness-level
		// contract violation that should fail the test.
		const violation = headers[HARNESS_VIOLATION_HEADER];
		if (violation) {
			harnessViolations.push({ url: response.url(), method, status, violation });
			return;
		}

		const isE2E = E2E_PATH.test(pathname);
		const isCompletion = COMPLETION_PATH.test(pathname);

		if (isCompletion) {
			if (!expectedCompletion) {
				// No scenario declared: any completion response is an undeclared
				// write. The fixture router returns 403 with the violation header
				// (caught above), but a real-backend response or any other
				// unmarked completion is also a violation.
				unexpectedResponses.push({ url: response.url(), method, status });
				return;
			}
			// A scenario is installed: prove the controller handled it.
			// 1. The marker must be `api-scenario` — the controller's provenance.
			//    A `fixture-router` marker means the controller missed (e.g. a
			//    URL shape it did not match) and the router's 403 default ran
			//    instead; a missing marker means the real backend answered.
			if (marker !== SCENARIO_SOURCE) {
				unexpectedResponses.push({ url: response.url(), method, status });
				return;
			}
			// 2. The fixture ID must match the declared scenario's fixture.
			const fixtureMatch = response.url().match(FIXTURE_ID_FROM_URL);
			const urlFixtureId = fixtureMatch?.[1];
			if (urlFixtureId !== expectedCompletion.fixtureId) {
				unexpectedResponses.push({ url: response.url(), method, status });
				return;
			}
			// 3. The method must be POST — the production completion contract.
			if (method !== 'POST') {
				unexpectedResponses.push({ url: response.url(), method, status });
				return;
			}
			// 4. The status must be consistent with the driven scenario.
			const expected = completionStatus(expectedCompletion.scenario);
			if (expected !== null && status !== expected) {
				unexpectedResponses.push({ url: response.url(), method, status });
			}
			return;
		}

		if (isE2E) {
			// Non-completion e2e paths must be answered by the fixture router.
			if (marker !== 'fixture-router') {
				leakedFixtureRequests.push({ url: response.url(), method, status });
			}
			return;
		}

		// Non-e2e traffic reaching the real backend: a >=400 is a real error.
		if (status >= 400) {
			unexpectedResponses.push({ url: response.url(), method, status });
		}
	}

	const offConsole = (msg: ConsoleMessage) => onConsole(msg);
	const offPageError = (err: Error) => onPageError(err);
	const offRequestFailed = (req: Request) => onRequestFailed(req);
	const offResponse = (res: Response) => onResponse(res);

	page.on('console', offConsole);
	page.on('pageerror', offPageError);
	page.on('requestfailed', offRequestFailed);
	page.on('response', offResponse);

	return {
		setCompletion(fixtureId, scenario) {
			if (fixtureId && scenario) {
				expectedCompletion = { fixtureId, scenario };
				// http-failure and network-abort both make the puzzle page log a
				// console.error on the failed server submission. Allowlist it so
				// the driven failure is not mistaken for a regression.
				if (scenario.kind === 'http-failure' || scenario.kind === 'network-abort') {
					expectedConsoleSubstrings.push('Failed to submit completion to server');
				}
			} else {
				expectedCompletion = undefined;
			}
		},
		expectConsoleError(messageSubstring) {
			expectedConsoleSubstrings.push(messageSubstring);
		},
		get consoleErrors() {
			return consoleErrors;
		},
		get pageErrors() {
			return pageErrors;
		},
		get failedRequests() {
			return failedRequests;
		},
		get unexpectedResponses() {
			return unexpectedResponses;
		},
		get leakedFixtureRequests() {
			return leakedFixtureRequests;
		},
		get harnessViolations() {
			return harnessViolations;
		},
		assertNoUnexpectedErrors() {
			const parts: string[] = [];
			if (consoleErrors.length > 0) {
				parts.push(`console errors:\n${consoleErrors.map((e) => `  - ${e.text}`).join('\n')}`);
			}
			if (pageErrors.length > 0) {
				parts.push(`page errors:\n${pageErrors.map((e) => `  - ${e.message}`).join('\n')}`);
			}
			if (failedRequests.length > 0) {
				parts.push(
					`failed requests:\n${failedRequests.map((r) => `  - ${r.method} ${r.url} (${r.failure})`).join('\n')}`
				);
			}
			if (unexpectedResponses.length > 0) {
				parts.push(
					`unexpected responses:\n${unexpectedResponses.map((r) => `  - ${r.method} ${r.url} -> ${r.status}`).join('\n')}`
				);
			}
			if (harnessViolations.length > 0) {
				parts.push(
					`harness violations:\n${harnessViolations.map((r) => `  - ${r.method} ${r.url} -> ${r.status} (${r.violation})`).join('\n')}`
				);
			}
			if (parts.length > 0) {
				throw new Error(`Page diagnostics detected unexpected errors:\n${parts.join('\n')}`);
			}
		},
		assertNoUnexpectedFixtureRequests() {
			if (leakedFixtureRequests.length > 0) {
				const details = leakedFixtureRequests
					.map((r) => `  - ${r.method} ${r.url} -> ${r.status}`)
					.join('\n');
				throw new Error(`e2e-* fixture request(s) leaked to the real backend:\n${details}`);
			}
		},
		dispose() {
			page.off('console', offConsole);
			page.off('pageerror', offPageError);
			page.off('requestfailed', offRequestFailed);
			page.off('response', offResponse);
		}
	};
}

/** The HTTP status a scenario produces on the completion response, or null. */
function completionStatus(scenario: CompletionScenario): number | null {
	switch (scenario.kind) {
		case 'success':
			return 200;
		case 'http-failure':
			return scenario.status;
		case 'deferred-success':
			return 200;
		case 'network-abort':
			// No response (aborted); any status is tolerated here.
			return null;
		default: {
			const exhaustive: never = scenario;
			throw new Error(`completionStatus: unhandled ${JSON.stringify(exhaustive)}`);
		}
	}
}
