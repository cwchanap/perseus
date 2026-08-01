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
import { createFixtureRouter, fixtureToMetadata, FIXTURE_ROUTER_HEADER } from './fixture-router';
import { createAuthPersona } from './auth-persona';
import {
	createApiScenarioController,
	type CompletionScenario,
	type RecordedRequest
} from './api-scenario';
import { buildMinimalSeed, createPersistedStateController, progressKey } from './persisted-state';

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

test.describe('FixtureRouter', () => {
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
		expect(JSON.parse(res.body).error).toBeTruthy();
	});

	test('lets ordinary (non-e2e) traffic fall through to the backend untouched', async ({
		page
	}) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		// The gallery list path has no e2e id, so the router must not match it.
		const res = await fetchApi(page, `/api/puzzles`);

		// Whatever the real backend answered, the router did NOT fulfill it.
		expect(res.headers[FIXTURE_ROUTER_HEADER]).toBeUndefined();
	});
});

// --- AuthPersona -------------------------------------------------------------

test.describe('AuthPersona', () => {
	test('authenticated persona reports an authenticated PlayerSessionResponse contract', async ({
		page
	}) => {
		const persona = createAuthPersona('authenticated');
		await persona.install(page);
		await gotoApiOrigin(page);

		const res = await fetchApi(page, `/api/auth/session`);
		expect(res.status).toBe(200);
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
		const session = JSON.parse(res.body) as PlayerSessionResponse;
		expect(session.authenticated).toBe(false);
		expect(session.user).toBeUndefined();
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

async function postCompletion(page: Page): Promise<{ status: number; ok: boolean; body: string }> {
	return fetchApi(page, `/api/puzzles/${FIXTURE_ID}/complete`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(COMPLETION_BODY)
	});
}

test.describe('ApiScenarioController', () => {
	test('records the completion request body (url, method, headers, body)', async ({ page }) => {
		const router = createFixtureRouter();
		await router.install(page);
		await gotoApiOrigin(page);

		const controller = createApiScenarioController();
		await controller.install(page, FIXTURE_ID, { kind: 'success' });

		const res = await postCompletion(page);

		expect(res.status).toBe(200);
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
});

// --- PersistedStateController -----------------------------------------------

test.describe('PersistedStateController', () => {
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
