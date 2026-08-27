// Total-interception fixture router for deterministic gameplay E2E.
//
// The router intercepts EVERY request whose path carries an `e2e-*` fixture id
// BEFORE either backend sees it:
//
//   - known fixture id  → fulfill immediately (metadata JSON, padded piece SVG,
//     reference/thumbnail SVG). The completion POST is fulfilled with a 403
//     `undeclared_completion` so it NEVER reaches the real backend, even when
//     no ApiScenarioController is installed. An undeclared completion is a
//     harness violation — only the ApiScenarioController produces a successful
//     completion. When a controller IS installed (registered after the
//     router), Playwright's reverse-registration-order precedence means the
//     controller route runs first and owns the outcome; the router's 403 is
//     only reached when no controller intercepts. Any OTHER sub-path under a
//     known id (e.g. a future API endpoint) is fulfilled with a 404, never
//     passed through.
//   - unknown `e2e-*` id → fulfill 404 immediately. It NEVER calls `fallback()`,
//     so a typo'd fixture id can never leak to the real API.
//   - any other path → `route.fallback()` so ordinary traffic (gallery list,
//     auth session, real puzzle ids) reaches the backend untouched.
//
// Every router-fulfilled response carries the `x-perseus-e2e-source:
// fixture-router` header so tests can prove who answered a request. Harness
// violations (undeclared completion, wrong HTTP method) additionally carry
// `x-perseus-e2e-violation` so the diagnostics layer can flag them as test
// failures regardless of HTTP status.
//
// HTTP method enforcement: the router enforces the production contract —
// POST for /complete, GET for metadata, piece, reference, and thumbnail
// endpoints. A wrong-method request receives a 405 with the violation header
// so a client-side method regression cannot pass E2E silently.
//
// Playwright route precedence: routes run in REVERSE registration order, and
// `route.fallback()` passes control to earlier-registered handlers. The router
// is installed before the ApiScenarioController, so the controller (registered
// later) runs first on `/complete` and owns the outcome when a scenario is
// installed. The router's 403 completion default is the safety net that
// guarantees total interception when no controller is present.
import type { Page, Route } from '@playwright/test';
import type { ReadyPuzzle } from '@perseus/types';
import { FIXTURE_IDS, getFixture, type GameplayFixtureId } from './catalog';
import { buildPieceSvg, buildReferenceSvg, SVG_CONTENT_TYPE } from './assets';

export const FIXTURE_ROUTER_HEADER = 'x-perseus-e2e-source';
export const FIXTURE_ROUTER_SOURCE = 'fixture-router';
export const HARNESS_VIOLATION_HEADER = 'x-perseus-e2e-violation';

/** Path matcher for page.route: any `/api/puzzles/e2e-<id>` request. */
const FIXTURE_PATH_PATTERN = /\/api\/puzzles\/e2e-[a-z0-9-]+/;
const KNOWN_FIXTURE_IDS: ReadonlySet<string> = new Set(FIXTURE_IDS);
const PIECE_IMAGE_PATH = /^\/api\/puzzles\/e2e-[a-z0-9-]+\/pieces\/(\d+)\/image$/;

function markerHeaders(): Record<string, string> {
	return { [FIXTURE_ROUTER_HEADER]: FIXTURE_ROUTER_SOURCE };
}

function violationHeaders(violation: string): Record<string, string> {
	return { [FIXTURE_ROUTER_HEADER]: FIXTURE_ROUTER_SOURCE, [HARNESS_VIOLATION_HEADER]: violation };
}

/** Fulfill a 405 Method Not Allowed with the harness violation marker. */
async function methodNotAllowed(route: Route, allowed: string): Promise<void> {
	await route.fulfill({
		status: 405,
		json: { error: 'method_not_allowed', allowed },
		headers: violationHeaders('method_not_allowed')
	});
}

/**
 * Project a deterministic gameplay fixture onto the `ReadyPuzzle` variant of
 * `PuzzleMetadata` — the exact shape `GET /api/puzzles/:id` returns. Pieces are
 * cloned (the frozen fixture is never serialized by reference).
 */
export function fixtureToMetadata(
	fixture: ReturnType<typeof getFixture>
): ReadyPuzzle & { hasReference: boolean } {
	return {
		id: fixture.fixtureId,
		familyId: fixture.familyId,
		difficulty: fixture.difficulty,
		name: fixture.name,
		aspectRatio: fixture.aspectRatio,
		pieceCount: fixture.pieceCount,
		gridCols: fixture.cols,
		gridRows: fixture.rows,
		imageWidth: fixture.imageWidth,
		imageHeight: fixture.imageHeight,
		createdAt: fixture.createdAt,
		version: 1,
		status: 'ready',
		pieces: fixture.pieces.map((piece) => ({ ...piece, edges: { ...piece.edges } })),
		// The real API derives hasReference from R2 presence; the harness
		// fixtures all declare it explicitly. Advertise it so the page's
		// `hasReference === true` gating renders the Reference button exactly
		// as it does against the real backend.
		hasReference: fixture.hasReference
	};
}

export interface FixtureRouter {
	/** Register the total-interception route on the page. */
	install(page: Page): Promise<void>;
}

export function createFixtureRouter(): FixtureRouter {
	async function handle(route: Route): Promise<void> {
		const url = route.request().url();
		let pathname: string;
		try {
			pathname = new URL(url).pathname;
		} catch {
			await route.fallback();
			return;
		}

		const idMatch = pathname.match(/\/api\/puzzles\/(e2e-[a-z0-9-]+)/);
		if (!idMatch) {
			// Not a fixture request at all — let ordinary traffic through.
			await route.fallback();
			return;
		}
		const id = idMatch[1] as string;

		if (!KNOWN_FIXTURE_IDS.has(id)) {
			// Unknown e2e-* id: fail immediately, never reach the backend. This
			// is a harness misconfiguration (a typo'd fixture id), so it stamps
			// the violation header — diagnostics fails teardown so a typo cannot
			// pass E2E silently.
			await route.fulfill({
				status: 404,
				json: { error: 'unknown_e2e_fixture', fixtureId: id },
				headers: violationHeaders('unknown_e2e_fixture')
			});
			return;
		}

		const fixture = getFixture(id as GameplayFixtureId);
		const method = route.request().method();

		// The completion POST: fulfill with a 403 `undeclared_completion` so it
		// NEVER reaches the real backend, even when no ApiScenarioController is
		// installed. An undeclared completion is a harness violation — only the
		// ApiScenarioController produces a successful completion. When a
		// controller IS installed (registered after the router), Playwright's
		// reverse-registration-order precedence means the controller route
		// runs first and owns the outcome; this 403 is only reached when no
		// controller intercepts. This preserves the total-interception
		// invariant: no e2e-* request can ever leak to the real backend.
		if (pathname === `/api/puzzles/${id}/complete`) {
			if (method !== 'POST') {
				await methodNotAllowed(route, 'POST');
				return;
			}
			await route.fulfill({
				status: 403,
				json: { error: 'undeclared_completion', fixtureId: id },
				headers: violationHeaders('undeclared_completion')
			});
			return;
		}

		// Exact metadata: GET /api/puzzles/<id>.
		if (pathname === `/api/puzzles/${id}`) {
			if (method !== 'GET') {
				await methodNotAllowed(route, 'GET');
				return;
			}
			await route.fulfill({ json: fixtureToMetadata(fixture), headers: markerHeaders() });
			return;
		}

		const pieceMatch = pathname.match(PIECE_IMAGE_PATH);
		if (pieceMatch) {
			if (method !== 'GET') {
				await methodNotAllowed(route, 'GET');
				return;
			}
			const pieceId = Number(pieceMatch[1]);
			// Match by id, not array index: sparse or non-contiguous piece id
			// sets must 404 just like any other unknown piece.
			if (!fixture.pieces.some((piece) => piece.id === pieceId)) {
				await route.fulfill({
					status: 404,
					json: { error: 'unknown_piece', fixtureId: id, pieceId },
					headers: violationHeaders('unknown_piece')
				});
				return;
			}
			await route.fulfill({
				contentType: SVG_CONTENT_TYPE,
				body: buildPieceSvg(fixture, pieceId),
				headers: markerHeaders()
			});
			return;
		}

		if (pathname === `/api/puzzles/${id}/reference`) {
			if (method !== 'GET') {
				await methodNotAllowed(route, 'GET');
				return;
			}
			await route.fulfill({
				contentType: SVG_CONTENT_TYPE,
				body: buildReferenceSvg(fixture),
				headers: markerHeaders()
			});
			return;
		}

		if (pathname === `/api/puzzles/${id}/thumbnail`) {
			if (method !== 'GET') {
				await methodNotAllowed(route, 'GET');
				return;
			}
			await route.fulfill({
				contentType: SVG_CONTENT_TYPE,
				body: buildReferenceSvg(fixture),
				headers: markerHeaders()
			});
			return;
		}

		// Any other sub-path under a known fixture id: fail immediately. The
		// total-interception invariant forbids fallback once a fixture id is
		// present, so a future API path added under /api/puzzles/:id/… fails
		// loudly here instead of silently reaching the real backend. It stamps
		// the violation header so diagnostics fails teardown — an unregistered
		// e2e request is a hard harness failure, not a silent 404 the app can
		// swallow.
		await route.fulfill({
			status: 404,
			json: { error: 'unknown_fixture_path', fixtureId: id, path: pathname },
			headers: violationHeaders('unknown_fixture_path')
		});
	}

	return {
		async install(page: Page): Promise<void> {
			await page.route(FIXTURE_PATH_PATTERN, (route) => handle(route));
		}
	};
}
