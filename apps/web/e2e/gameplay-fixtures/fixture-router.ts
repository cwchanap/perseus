// Total-interception fixture router for deterministic gameplay E2E.
//
// The router intercepts EVERY request whose path carries an `e2e-*` fixture id
// BEFORE either backend sees it:
//
//   - known fixture id  → fulfill immediately (metadata JSON, padded piece SVG,
//     reference/thumbnail SVG). The completion POST is the one exception: it
//     calls `route.fallback()` so the ApiScenarioController (registered
//     separately for `/complete`) owns the outcome. Any OTHER sub-path under a
//     known id (e.g. a future API endpoint) is fulfilled with a 404, never
//     passed through.
//   - unknown `e2e-*` id → fulfill 404 immediately. It NEVER calls `fallback()`,
//     so a typo'd fixture id can never leak to the real API.
//   - any other path → `route.fallback()` so ordinary traffic (gallery list,
//     auth session, real puzzle ids) reaches the backend untouched.
//
// Every router-fulfilled response carries the `x-perseus-e2e-source:
// fixture-router` header so tests can prove who answered a request.
//
// Playwright route precedence: routes run in REVERSE registration order, and
// `route.fallback()` passes control to earlier-registered handlers. Because the
// router falls back on the known-fixture `/complete` path, the
// ApiScenarioController handles completion regardless of install order.
import type { Page, Route } from '@playwright/test';
import type { ReadyPuzzle } from '@perseus/types';
import { FIXTURE_IDS, getFixture, type GameplayFixtureId } from './catalog';
import { buildPieceSvg, buildReferenceSvg, SVG_CONTENT_TYPE } from './assets';

export const FIXTURE_ROUTER_HEADER = 'x-perseus-e2e-source';
export const FIXTURE_ROUTER_SOURCE = 'fixture-router';

/** Path matcher for page.route: any `/api/puzzles/e2e-<id>` request. */
const FIXTURE_PATH_PATTERN = /\/api\/puzzles\/e2e-[a-z0-9-]+/;
const KNOWN_FIXTURE_IDS: ReadonlySet<string> = new Set(FIXTURE_IDS);
const PIECE_IMAGE_PATH = /^\/api\/puzzles\/e2e-[a-z0-9-]+\/pieces\/(\d+)\/image$/;

function markerHeaders(): Record<string, string> {
	return { [FIXTURE_ROUTER_HEADER]: FIXTURE_ROUTER_SOURCE };
}

/**
 * Project a deterministic gameplay fixture onto the `ReadyPuzzle` variant of
 * `PuzzleMetadata` — the exact shape `GET /api/puzzles/:id` returns. Pieces are
 * cloned (the frozen fixture is never serialized by reference).
 */
export function fixtureToMetadata(fixture: ReturnType<typeof getFixture>): ReadyPuzzle {
	return {
		id: fixture.fixtureId,
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
		pieces: fixture.pieces.map((piece) => ({ ...piece, edges: { ...piece.edges } }))
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
			// Unknown e2e-* id: fail immediately, never reach the backend.
			await route.fulfill({
				status: 404,
				json: { error: 'unknown_e2e_fixture', fixtureId: id },
				headers: markerHeaders()
			});
			return;
		}

		const fixture = getFixture(id as GameplayFixtureId);

		// The completion POST is owned by the ApiScenarioController.
		if (pathname === `/api/puzzles/${id}/complete`) {
			await route.fallback();
			return;
		}

		// Exact metadata: GET /api/puzzles/<id>.
		if (pathname === `/api/puzzles/${id}`) {
			await route.fulfill({ json: fixtureToMetadata(fixture), headers: markerHeaders() });
			return;
		}

		const pieceMatch = pathname.match(PIECE_IMAGE_PATH);
		if (pieceMatch) {
			const pieceId = Number(pieceMatch[1]);
			// Match by id, not array index: sparse or non-contiguous piece id
			// sets must 404 just like any other unknown piece.
			if (!fixture.pieces.some((piece) => piece.id === pieceId)) {
				await route.fulfill({
					status: 404,
					json: { error: 'unknown_piece', fixtureId: id, pieceId },
					headers: markerHeaders()
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
			await route.fulfill({
				contentType: SVG_CONTENT_TYPE,
				body: buildReferenceSvg(fixture),
				headers: markerHeaders()
			});
			return;
		}

		if (pathname === `/api/puzzles/${id}/thumbnail`) {
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
		// loudly here instead of silently reaching the real backend.
		await route.fulfill({
			status: 404,
			json: { error: 'unknown_fixture_path', fixtureId: id, path: pathname },
			headers: markerHeaders()
		});
	}

	return {
		async install(page: Page): Promise<void> {
			await page.route(FIXTURE_PATH_PATTERN, (route) => handle(route));
		}
	};
}
