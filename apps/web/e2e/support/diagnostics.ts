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
// `/complete` path, by the ApiScenarioController. Any `e2e-*` response that
// reaches the real backend (no marker, not a completion path) is a leak and
// fails teardown.
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';
import type { CompletionScenario } from '../gameplay-fixtures/api-scenario';
import { FIXTURE_ROUTER_HEADER } from '../gameplay-fixtures/fixture-router';

const E2E_PATH = /\/api\/puzzles\/e2e-[a-z0-9-]+/;
const COMPLETION_PATH = /\/api\/puzzles\/e2e-[a-z0-9-]+\/complete(?:\?.*)?$/;

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

	function onRequestFailed(request: Request): void {
		const url = request.url();
		// A deliberately aborted completion submission is expected.
		if (
			expectedCompletion?.scenario.kind === 'network-abort' &&
			COMPLETION_PATH.test(url) &&
			request.method() === 'POST'
		) {
			return;
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

		const isE2E = E2E_PATH.test(pathname);
		const isCompletion = COMPLETION_PATH.test(pathname);
		const status = response.status();
		const marker = response.headers()[FIXTURE_ROUTER_HEADER];

		if (isCompletion) {
			// The completion path is owned by the ApiScenarioController when a
			// scenario is installed. Without one, any completion response leaked
			// to the real backend (a real side effect) — flag it.
			if (!expectedCompletion) {
				leakedFixtureRequests.push({ url: response.url(), method, status });
				return;
			}
			// A scenario is installed: its outcome is expected. Only a status
			// inconsistent with the driven scenario is unexpected.
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
