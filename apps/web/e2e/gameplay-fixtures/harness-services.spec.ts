// Service-level tests for the deterministic gameplay harness.
//
// These tests prove the four harness services that Task 7's gotoFixture() will
// compose: FixtureRouter (total e2e-* interception), AuthPersona (auth state),
// ApiScenarioController (completion outcomes + request recording), and
// PersistedStateController (validated/raw localStorage seeding). They drive the
// services directly via the page's fetch — not the puzzle UI — so they stay
// fast and decoupled from rendering.
//
// Run: bun run --cwd apps/web test:e2e -- e2e/gameplay-fixtures/harness-services.spec.ts \
//      --project=chromium-desktop --retries=0
import { expect, test, type Page } from '@playwright/test';
import { validatePuzzleMetadata, type PlayerSessionResponse } from '@perseus/types';
import { getFixture } from './catalog';
import {
	createFixtureRouter,
	fixtureToMetadata,
	FIXTURE_ROUTER_HEADER,
	HARNESS_VIOLATION_HEADER
} from './fixture-router';
import { createAuthPersona, AUTHENTICATED_PLAYER, AUTH_PERSONA_SOURCE } from './auth-persona';
import {
	createApiScenarioController,
	SCENARIO_SOURCE,
	type CompletionScenario,
	type RecordedRequest
} from './api-scenario';
import { buildMinimalSeed, createPersistedStateController, progressKey } from './persisted-state';
import { createPageDiagnostics, type PageDiagnostics } from '../support/diagnostics';

const API_ORIGIN = process.env.PUBLIC_API_BASE ?? 'http://localhost:3999';
const FIXTURE_ID = 'e2e-square-4' as const;

/**
 * Navigate the page to the API host's public gallery endpoint so the page origin
 * is the API host and subsequent same-origin relative fetches resolve. This
 * endpoint is unauthenticated and always 200; it is NOT an e2e path, so the
 * FixtureRouter never intercepts it.
 */
async function gotoApiOrigin(page: Page): Promise<void> {
	await page.goto(`${API_ORIGIN}/api/puzzles`);
}

/** Same-origin fetch (page is already on API_ORIGIN) returning a plain record. */
async function fetchApi(
	page: Page,
	path: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; ok: boolean; headers: Record<string, string>; body: string }> {
	return page.evaluate(
		async ({ path, init }) => {
			const response = await fetch(path, init);
			const body = await response.text();
			return {
				status: response.status,
				ok: response.ok,
				headers: Object.fromEntries(response.headers.entries()),
				body
			};
		},
		{ path, init }
	);
}

// --- FixtureRouter -----------------------------------------------------------

test.describe('FixtureRouter @smoke', () => {
	test('fulfills known fixture metadata with a valid ReadyPuzzle and a marker header', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);
		const fixture = getFixture(FIXTURE_ID);

		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}`);

		expect(res.status).toBe(200);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe('fixture-router');
		const meta = JSON.parse(res.body);
		expect(meta).toEqual(fixtureToMetadata(fixture));
		expect(validatePuzzleMetadata(meta)).toBe(true);
		expect(meta.status).toBe('ready');
		expect(meta.id).toBe(FIXTURE_ID);
	});

	test('serves padded piece SVGs and the reference image for a known fixture', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const piece = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/pieces/0/image`);
		expect(piece.status).toBe(200);
		expect(piece.headers['content-type']).toContain('image/svg+xml');
		expect(piece.headers[FIXTURE_ROUTER_HEADER]).toBe('fixture-router');
		expect(piece.body).toContain('<svg');
		expect(piece.body).toContain('piece=0');

		const reference = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/reference`);
		expect(reference.status).toBe(200);
		expect(reference.headers['content-type']).toContain('image/svg+xml');
		expect(reference.body).toContain('<svg');
	});

	test('fails unknown e2e-* ids immediately without calling fallback (no real-backend hit)', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/puzzles/e2e-does-not-exist`);

		expect(res.status).toBe(404);
		// The router fulfilled it (marker present) — it never reached fallback.
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe('fixture-router');
		// An unknown fixture id is a harness misconfiguration: the violation
		// header makes diagnostics fail teardown so a typo'd id cannot pass.
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('unknown_e2e_fixture');
		expect(JSON.parse(res.body).error).toBeTruthy();
	});

	test('fulfills (never falls back) for unknown sub-paths under a known fixture', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		// A path the router does not recognize, but which carries a KNOWN fixture
		// id. The total-interception invariant requires the router to answer it
		// (marker present) rather than silently fall through to the backend.
		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/unknown-endpoint`);

		expect(res.status).toBe(404);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe('fixture-router');
		// An unregistered e2e sub-path is a hard harness failure: the violation
		// header makes diagnostics fail teardown so a silent 404 the app swallows
		// cannot pass E2E.
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('unknown_fixture_path');
		expect(JSON.parse(res.body).error).toBeTruthy();
	});

	test('fails unknown piece ids under a known fixture with a violation marker', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		// A piece id not in the fixture. The router 404s (marker present) and
		// stamps the violation header so diagnostics fails teardown — the app
		// must never request a non-existent piece.
		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/pieces/999/image`);

		expect(res.status).toBe(404);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe('fixture-router');
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('unknown_piece');
		expect(JSON.parse(res.body).error).toBe('unknown_piece');
	});

	test('lets ordinary (non-e2e) traffic fall through to the backend untouched', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		// The gallery list path has no e2e id, so the router must not match it.
		const res = await fetchApi(page, `/api/puzzles`);

		// Whatever the real backend answered, the router did NOT fulfill it —
		// and the backend must have answered, not errored.
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBeUndefined();
		expect(res.status).toBe(200);
	});

	test('intercepts POST /complete with a 403 undeclared_completion when no scenario controller is installed (no backend hit)', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		// POST /complete with ONLY the fixture router installed — no
		// ApiScenarioController. The total-interception invariant requires the
		// router to answer this itself so the request can never reach the real
		// backend and perform a real side effect. An undeclared completion is a
		// harness violation: the router returns 403 (not 200) and stamps the
		// violation header so diagnostics flags it at teardown.
		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: 'test-run-id' })
		});

		expect(res.status).toBe(403);
		// The marker header proves the fixture router answered, not the backend.
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe('fixture-router');
		// The violation header lets diagnostics flag this as an undeclared write.
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('undeclared_completion');
		expect(JSON.parse(res.body)).toEqual({
			error: 'undeclared_completion',
			fixtureId: FIXTURE_ID
		});
	});

	// --- HTTP method enforcement (Finding 3) ---------------------------------

	test('GET /complete returns 405 method_not_allowed', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete`, { method: 'GET' });
		expect(res.status).toBe(405);
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
		expect(JSON.parse(res.body).error).toBe('method_not_allowed');
	});

	test('POST /metadata returns 405 method_not_allowed', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}`, { method: 'POST' });
		expect(res.status).toBe(405);
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
	});

	test('POST /pieces/:id/image returns 405 method_not_allowed', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/pieces/0/image`, {
			method: 'POST'
		});
		expect(res.status).toBe(405);
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
	});

	test('POST /reference returns 405 method_not_allowed', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/reference`, { method: 'POST' });
		expect(res.status).toBe(405);
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
	});
});

// --- AuthPersona -------------------------------------------------------------

test.describe('AuthPersona @smoke', () => {
	test('authenticated persona reports an authenticated PlayerSessionResponse contract', async ({
		page
	}) => {
		const persona = createAuthPersona('authenticated');
		await persona.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/auth/session`);
		expect(res.status).toBe(200);
		// Provenance: the persona answered, not the real backend.
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(AUTH_PERSONA_SOURCE);
		const session = JSON.parse(res.body) as PlayerSessionResponse;
		expect(session.authenticated).toBe(true);
		expect(session.user).toBeDefined();
		expect(typeof session.user!.id).toBe('string');
		expect(typeof session.user!.email).toBe('string');
		expect(typeof session.user!.createdAt).toBe('number');
		expect(typeof session.user!.lastLoginAt).toBe('number');
	});

	test('anonymous persona reports the unauthenticated contract', async ({ page }) => {
		const persona = createAuthPersona('anonymous');
		await persona.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/auth/session`);
		expect(res.status).toBe(200);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(AUTH_PERSONA_SOURCE);
		const session = JSON.parse(res.body) as PlayerSessionResponse;
		expect(session.authenticated).toBe(false);
		expect(session.user).toBeUndefined();
	});

	// --- HTTP method enforcement (Finding 3) ---------------------------------

	test('POST /api/auth/session returns 405 method_not_allowed', async ({ page }) => {
		const persona = createAuthPersona('anonymous');
		await persona.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/auth/session`, { method: 'POST' });
		expect(res.status).toBe(405);
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
	});

	// --- New personas (Finding 4) --------------------------------------------

	test('failed-session persona returns 500 by default', async ({ page }) => {
		const persona = createAuthPersona('failed-session');
		await persona.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/auth/session`);
		expect(res.status).toBe(500);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(AUTH_PERSONA_SOURCE);
		expect(JSON.parse(res.body).error).toBe('session_unavailable');
	});

	test('failed-session persona with custom status returns 503', async ({ page }) => {
		const persona = createAuthPersona('failed-session', { failedStatus: 503 });
		await persona.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/auth/session`);
		expect(res.status).toBe(503);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(AUTH_PERSONA_SOURCE);
	});

	test('deferred-session persona holds the request; release() resolves it', async ({ page }) => {
		const persona = createAuthPersona('deferred-session');
		const handle = await persona.install(page);
		expect(handle).not.toBeNull();
		await gotoApiOrigin(page);

		// Fire the GET without awaiting — it must stall until release().
		const pending = fetchApi(page, `/api/auth/session`);
		await expect.poll(() => handle!.pendingCount).toBe(1);

		await handle!.release({ authenticated: true, user: AUTHENTICATED_PLAYER });
		const res = await pending;
		expect(res.status).toBe(200);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(AUTH_PERSONA_SOURCE);
		const session = JSON.parse(res.body) as PlayerSessionResponse;
		expect(session.authenticated).toBe(true);
		expect(handle!.pendingCount).toBe(0);
	});

	test('deferred-session persona cancel() aborts the held request', async ({ page }) => {
		const persona = createAuthPersona('deferred-session');
		const handle = await persona.install(page);
		await gotoApiOrigin(page);

		const pending = fetchApi(page, `/api/auth/session`).catch(() => ({
			status: 0,
			ok: false,
			headers: {},
			body: ''
		}));
		await expect.poll(() => handle!.pendingCount).toBe(1);

		await handle!.cancel();
		const res = await pending;
		expect(res.status).toBe(0);
		expect(handle!.pendingCount).toBe(0);
		expect(handle!.cancelled).toBe(true);
	});
});

// --- ApiScenarioController ---------------------------------------------------

const COMPLETION_BODY = {
	version: 1 as const,
	runId: '00000000-0000-4000-8000-000000000001',
	resultClass: 'standard_timed' as const,
	timingQuality: 'known' as const,
	elapsedActiveSeconds: 5
};

async function postCompletion(
	page: Page
): Promise<{ status: number; ok: boolean; headers: Record<string, string>; body: string }> {
	return fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(COMPLETION_BODY)
	});
}

test.describe('ApiScenarioController @smoke', () => {
	test('records the completion request body (url, method, headers, body)', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const controller = createApiScenarioController();
		await controller.install(page, FIXTURE_ID, { kind: 'success' });

		const res = await postCompletion(page);

		expect(res.status).toBe(200);
		// The scenario controller stamps its own provenance header so tests
		// can distinguish a scenario-fulfilled completion from the router's
		// default or a real-backend leak.
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(SCENARIO_SOURCE);
		expect(controller.recordedRequests).toHaveLength(1);
		const recorded: RecordedRequest = controller.recordedRequests[0]!;
		expect(recorded.method).toBe('POST');
		expect(recorded.url).toContain(`/api/puzzles/${FIXTURE_ID}/complete`);
		expect(recorded.headers['content-type']).toContain('application/json');
		expect(recorded.bodyJson).toEqual(COMPLETION_BODY);
	});

	test.describe('each CompletionScenario installs the expected route behavior', () => {
		const cases: Array<{
			name: string;
			scenario: CompletionScenario;
			expectStatus: number | 'reject';
		}> = [
			{ name: 'success → 200', scenario: { kind: 'success' }, expectStatus: 200 },
			{
				name: 'http-failure 409 → 409',
				scenario: { kind: 'http-failure', status: 409 },
				expectStatus: 409
			},
			{
				name: 'http-failure 500 → 500',
				scenario: { kind: 'http-failure', status: 500 },
				expectStatus: 500
			},
			{
				name: 'http-failure 401 → 401',
				scenario: { kind: 'http-failure', status: 401 },
				expectStatus: 401
			},
			{
				name: 'network-abort → rejects',
				scenario: { kind: 'network-abort' },
				expectStatus: 'reject'
			}
		];

		for (const { name, scenario, expectStatus } of cases) {
			test(name, async ({ page }) => {
				const router = createFixtureRouter();
				await router.install(page);
				await gotoApiOrigin(page);

				const controller = createApiScenarioController();
				await controller.install(page, FIXTURE_ID, scenario);

				if (expectStatus === 'reject') {
					await expect(postCompletion(page)).rejects.toBeTruthy();
				} else {
					const res = await postCompletion(page);
					expect(res.status).toBe(expectStatus);
				}
				controller.assertClean();
			});
		}
	});

	test('deferred-success holds the request; release() resolves it with 200', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const controller = createApiScenarioController();
		const handle = await controller.install(page, FIXTURE_ID, { kind: 'deferred-success' });

		// Fire the POST without awaiting — it must stall until release().
		const pending = postCompletion(page);
		await expect.poll(() => handle.pendingCount).toBe(1);
		expect(controller.pendingDeferred()).toHaveLength(1);

		await handle.release();
		const res = await pending;
		expect(res.status).toBe(200);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(SCENARIO_SOURCE);

		expect(handle.pendingCount).toBe(0);
		controller.assertClean();
	});

	test('deferred teardown fails until the deferred route is released or cancelled', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const controller = createApiScenarioController();
		const handle = await controller.install(page, FIXTURE_ID, { kind: 'deferred-success' });

		postCompletion(page).catch(() => {
			/* cancelled deferred rejects; swallow for the teardown assertion */
		});
		await expect.poll(() => handle.pendingCount).toBe(1);

		// Teardown must refuse while a route is still held.
		expect(() => controller.assertClean()).toThrow();

		await handle.cancel();
		expect(handle.pendingCount).toBe(0);
		expect(() => controller.assertClean()).not.toThrow();
	});

	// --- Finding 1: query-string acceptance + method enforcement -------------

	test('controller intercepts /complete?retry=1 (query string does not bypass the controller)', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const controller = createApiScenarioController();
		await controller.install(page, FIXTURE_ID, { kind: 'success' });

		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete?retry=1`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(COMPLETION_BODY)
		});

		// The controller handled it (api-scenario marker), not the router's
		// 403 default.
		expect(res.status).toBe(200);
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBe(SCENARIO_SOURCE);
		expect(controller.recordedRequests).toHaveLength(1);
	});

	test('GET /complete with controller returns 405 method_not_allowed', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const controller = createApiScenarioController();
		await controller.install(page, FIXTURE_ID, { kind: 'success' });

		const res = await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete`, {
			method: 'GET'
		});
		expect(res.status).toBe(405);
		expect(res.headers[HARNESS_VIOLATION_HEADER]).toBe('method_not_allowed');
		// The controller did NOT record the wrong-method request.
		expect(controller.recordedRequests).toHaveLength(0);
	});
});

// --- PersistedStateController -----------------------------------------------

test.describe('PersistedStateController @smoke', () => {
	test('seedValid writes a deterministic localStorage payload that round-trips through the production codec', async ({
		page
	}) => {
		const state = createPersistedStateController();
		await page.goto('/'); // web origin, where the app reads localStorage

		const snapshot = buildMinimalSeed(FIXTURE_ID);
		const written = await state.seedValid(page, FIXTURE_ID, snapshot);

		// Deterministic: the same snapshot seeds byte-identical content every time.
		const snapshot2 = buildMinimalSeed(FIXTURE_ID);
		const written2 = await state.seedValid(page, FIXTURE_ID, snapshot2);
		expect(written2).toBe(written);

		// The on-disk key follows the production convention.
		const readBack = await page.evaluate(
			(key) => localStorage.getItem(key),
			progressKey(FIXTURE_ID)
		);
		expect(readBack).toBe(written);
		// The seeded payload is canonical JSON of the snapshot.
		expect(JSON.parse(readBack!).puzzleId).toBe(FIXTURE_ID);
	});

	test('seedValid rejects an invalid snapshot (production validator) and writes nothing', async ({
		page
	}) => {
		const state = createPersistedStateController();
		await page.goto('/');

		const bad = buildMinimalSeed(FIXTURE_ID);
		// Corrupt a field the production codec rejects (bad resultClass for a timed standard run).
		(bad as unknown as Record<string, unknown>).resultClass = 'relaxed';

		await expect(state.seedValid(page, FIXTURE_ID, bad)).rejects.toBeTruthy();
		const readBack = await page.evaluate((k) => localStorage.getItem(k), progressKey(FIXTURE_ID));
		expect(readBack).toBeNull();
	});

	test('seedRaw bypasses validation, writing arbitrary bytes for migration/corruption tests', async ({
		page
	}) => {
		const state = createPersistedStateController();
		await page.goto('/');

		const garbage = '{"not-a-valid-session":true}';
		await state.seedRaw(page, FIXTURE_ID, garbage);

		const readBack = await page.evaluate((k) => localStorage.getItem(k), progressKey(FIXTURE_ID));
		expect(readBack).toBe(garbage);
	});
});

// --- PageDiagnostics contract (Findings 1 & 2) --------------------------------
//
// These tests prove the diagnostics layer flags the false-green conditions
// the review identified: undeclared completions, wrong provenance, wrong
// fixture ID, wrong method, broad network-abort suppression, unknown e2e
// paths, and auth-persona provenance leaks.

test.describe('PageDiagnostics @smoke', () => {
	/** Set up router + diagnostics, navigate to API origin, return diagnostics. */
	async function setup(
		page: Page,
		opts?: { completion?: { fixtureId: string; scenario: CompletionScenario } }
	): Promise<PageDiagnostics> {
		const diagnostics = createPageDiagnostics(page);
		const router = createFixtureRouter();
		await router.install(page);
		if (opts?.completion) {
			const controller = createApiScenarioController();
			await controller.install(page, opts.completion.fixtureId, opts.completion.scenario);
			diagnostics.setCompletion(opts.completion.fixtureId, opts.completion.scenario);
		}
		await gotoApiOrigin(page);
		return diagnostics;
	}

	/** Wait for diagnostics to observe at least `n` responses, then assert. */
	async function waitForResponses(diagnostics: PageDiagnostics, n: number): Promise<void> {
		await expect
			.poll(() => diagnostics.unexpectedResponses.length + diagnostics.harnessViolations.length)
			.toBeGreaterThanOrEqual(n);
	}

	test('Finding 2: undeclared completion (router 403) is flagged as a harness violation', async ({
		page
	}) => {
		const diagnostics = await setup(page);

		await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(COMPLETION_BODY)
		});
		await waitForResponses(diagnostics, 1);

		expect(diagnostics.harnessViolations).toHaveLength(1);
		expect(diagnostics.harnessViolations[0]!.violation).toBe('undeclared_completion');
		expect(() => diagnostics.assertNoUnexpectedErrors()).toThrow();
		diagnostics.dispose();
	});

	test('Finding 1: scenario-declared completion with api-scenario marker passes clean', async ({
		page
	}) => {
		const diagnostics = await setup(page, {
			completion: { fixtureId: FIXTURE_ID, scenario: { kind: 'success' } }
		});

		// Track when the completion response event has been processed by
		// diagnostics. The diagnostics listener is registered first (in
		// createPageDiagnostics), so by the time this test listener fires,
		// diagnostics has already processed the response.
		let completionSeen = false;
		page.on('response', (res) => {
			if (res.url().includes('/complete')) completionSeen = true;
		});

		await postCompletion(page);
		await expect.poll(() => completionSeen).toBe(true);

		expect(diagnostics.unexpectedResponses).toHaveLength(0);
		expect(diagnostics.harnessViolations).toHaveLength(0);
		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();
		diagnostics.dispose();
	});

	test('Finding 1: scenario-declared completion WITHOUT api-scenario marker is flagged (router 403 fallback)', async ({
		page
	}) => {
		// Install the router but NOT the controller — simulate the controller
		// missing (e.g. URL shape mismatch). The router returns 403 with the
		// violation header. Diagnostics should flag it.
		const diagnostics = createPageDiagnostics(page);
		const router = createFixtureRouter();
		await router.install(page);
		diagnostics.setCompletion(FIXTURE_ID, { kind: 'success' });
		await gotoApiOrigin(page);

		await postCompletion(page);
		await waitForResponses(diagnostics, 1);

		// The router's 403 carries the violation header → harness violation.
		expect(diagnostics.harnessViolations).toHaveLength(1);
		expect(diagnostics.harnessViolations[0]!.violation).toBe('undeclared_completion');
		diagnostics.dispose();
	});

	test('Finding 3: wrong-method completion (GET) is flagged as a harness violation', async ({
		page
	}) => {
		const diagnostics = await setup(page);

		await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete`, { method: 'GET' });
		await waitForResponses(diagnostics, 1);

		expect(diagnostics.harnessViolations).toHaveLength(1);
		expect(diagnostics.harnessViolations[0]!.violation).toBe('method_not_allowed');
		diagnostics.dispose();
	});

	test('Finding 1: network-abort suppression is narrow to the configured fixture', async ({
		page
	}) => {
		// Declare network-abort for e2e-square-4. A failed POST to a DIFFERENT
		// e2e fixture's /complete must NOT be suppressed.
		const diagnostics = createPageDiagnostics(page);
		const router = createFixtureRouter();
		await router.install(page);
		diagnostics.setCompletion(FIXTURE_ID, { kind: 'network-abort' });
		await gotoApiOrigin(page);

		// Simulate a failed request to a different fixture's completion URL.
		// The router returns 403 for this (undeclared), which is a violation.
		await fetchApi(page, `/api/puzzles/e2e-landscape-12/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(COMPLETION_BODY)
		});
		await waitForResponses(diagnostics, 1);

		// The other fixture's completion is a harness violation (undeclared),
		// NOT suppressed by the network-abort allowlist for e2e-square-4.
		expect(diagnostics.harnessViolations).toHaveLength(1);
		expect(diagnostics.harnessViolations[0]!.violation).toBe('undeclared_completion');
		diagnostics.dispose();
	});

	// --- P2: unknown e2e paths are hard harness failures ---------------------

	test('P2: unknown sub-path under a known fixture is a harness violation that fails teardown', async ({
		page
	}) => {
		const diagnostics = await setup(page);

		await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/unknown-endpoint`);
		await waitForResponses(diagnostics, 1);

		expect(diagnostics.harnessViolations).toHaveLength(1);
		expect(diagnostics.harnessViolations[0]!.violation).toBe('unknown_fixture_path');
		expect(() => diagnostics.assertNoUnexpectedErrors()).toThrow();
		diagnostics.dispose();
	});

	test('P2: unknown e2e fixture id is a harness violation that fails teardown', async ({
		page
	}) => {
		const diagnostics = await setup(page);

		await fetchApi(page, `/api/puzzles/e2e-does-not-exist`);
		await waitForResponses(diagnostics, 1);

		expect(diagnostics.harnessViolations).toHaveLength(1);
		expect(diagnostics.harnessViolations[0]!.violation).toBe('unknown_e2e_fixture');
		expect(() => diagnostics.assertNoUnexpectedErrors()).toThrow();
		diagnostics.dispose();
	});

	test('P2: unknown piece id is a harness violation that fails teardown', async ({ page }) => {
		const diagnostics = await setup(page);

		await fetchApi(page, `/api/puzzles/${FIXTURE_ID}/pieces/999/image`);
		await waitForResponses(diagnostics, 1);

		expect(diagnostics.harnessViolations).toHaveLength(1);
		expect(diagnostics.harnessViolations[0]!.violation).toBe('unknown_piece');
		expect(() => diagnostics.assertNoUnexpectedErrors()).toThrow();
		diagnostics.dispose();
	});

	// --- P1#2: auth-persona provenance ---------------------------------------

	/** Set up diagnostics + router + an auth persona, return the diagnostics. */
	async function setupAuth(
		page: Page,
		kind: Parameters<typeof createAuthPersona>[0]
	): Promise<PageDiagnostics> {
		const diagnostics = createPageDiagnostics(page);
		const router = createFixtureRouter();
		await router.install(page);
		const persona = createAuthPersona(kind);
		await persona.install(page);
		diagnostics.setAuthPersona(kind, persona.failedStatus ?? undefined);
		await gotoApiOrigin(page);
		return diagnostics;
	}

	test('P1#2: anonymous persona 200 with auth-persona marker passes clean', async ({ page }) => {
		const diagnostics = await setupAuth(page, 'anonymous');

		// Track when the auth response has been processed by diagnostics. The
		// diagnostics listener is registered first (in createPageDiagnostics),
		// so by the time this test listener fires, diagnostics has already
		// processed the response.
		let authSeen = false;
		page.on('response', (res) => {
			if (res.url().includes('/api/auth/session')) authSeen = true;
		});

		await fetchApi(page, `/api/auth/session`);
		await expect.poll(() => authSeen).toBe(true);

		expect(diagnostics.unexpectedResponses).toHaveLength(0);
		expect(diagnostics.harnessViolations).toHaveLength(0);
		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();
		diagnostics.dispose();
	});

	test('P1#2: failed-session 500 with auth-persona marker is allowed (not unexpected)', async ({
		page
	}) => {
		const diagnostics = await setupAuth(page, 'failed-session');

		let authSeen = false;
		page.on('response', (res) => {
			if (res.url().includes('/api/auth/session')) authSeen = true;
		});

		await fetchApi(page, `/api/auth/session`);
		await expect.poll(() => authSeen).toBe(true);

		// The configured 500 is allowed (not unexpected); the auth-failure
		// console errors are allowlisted by setAuthPersona.
		expect(diagnostics.unexpectedResponses).toHaveLength(0);
		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();
		diagnostics.dispose();
	});

	test('P1#2: /api/auth/session WITHOUT the auth-persona marker is flagged (real-backend leak)', async ({
		page
	}) => {
		// Simulate the persona route missing and the real backend answering
		// 200 (no provenance marker). Diagnostics must flag it — otherwise a
		// real-backend 200 could masquerade as the intended persona response.
		const diagnostics = createPageDiagnostics(page);
		await page.route(/\/api\/auth\/session(?:\?.*)?$/, async (route) => {
			await route.fulfill({ status: 200, json: { authenticated: false } });
		});
		diagnostics.setAuthPersona('anonymous');
		await gotoApiOrigin(page);

		await fetchApi(page, `/api/auth/session`);
		await waitForResponses(diagnostics, 1);

		expect(diagnostics.unexpectedResponses).toHaveLength(1);
		expect(() => diagnostics.assertNoUnexpectedErrors()).toThrow();
		diagnostics.dispose();
	});

	test('P1#2: deferred-session cancel() abort is tolerated (not a failed request)', async ({
		page
	}) => {
		const diagnostics = createPageDiagnostics(page);
		const persona = createAuthPersona('deferred-session');
		const handle = await persona.install(page);
		diagnostics.setAuthPersona('deferred-session');
		await gotoApiOrigin(page);

		// Fire the GET without awaiting; it stalls on the held route.
		const pending = fetchApi(page, `/api/auth/session`).catch(() => ({
			status: 0,
			ok: false,
			headers: {},
			body: ''
		}));
		await expect.poll(() => handle!.pendingCount).toBe(1);

		await handle!.cancel();
		await pending;

		// The abort is the configured outcome, not a regression: no failed
		// request is recorded and teardown stays clean.
		expect(diagnostics.failedRequests).toHaveLength(0);
		expect(() => diagnostics.assertNoUnexpectedErrors()).not.toThrow();
		diagnostics.dispose();
	});
});
