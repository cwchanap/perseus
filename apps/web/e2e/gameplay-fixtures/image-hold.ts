// Image response hold/fail helper (HPA-1029).
//
// ONE tiny reusable helper that holds or fails image responses so artwork
// status can be driven deterministically: a held image keeps its request
// pending (the UI must show its pending state), `release()` answers it with
// the real image, and `cancel()`/fail specs produce deterministic image
// failures (abort / declared HTTP status). Not a request-orchestration
// framework — it registers exact routes for declared image URLs only.
//
// Gameplay fixture images: `installFixtureImages()` registers routes for
// KNOWN fixture image endpoints only (`/api/puzzles/<fixture-id>/pieces/:n/
// image`, `/reference`, `/thumbnail`). Install it AFTER `createFixtureRouter
// ().install()` — Playwright routes run in reverse registration order, so the
// hold route runs first and can defer the request. Requests for any other
// URL never reach these routes and are handled by the fixture router as
// usual (the hold routes themselves never call `route.fallback()`). Released
// responses carry the fixture-router provenance marker, so diagnostics still
// proves who answered; failing responses are NOT stamped as harness
// violations (they are intentional, and must be declared to diagnostics via
// `declaredImageFailures()`).
//
// Other image URLs (the Gallery family thumbnail, which is NOT under the
// fixture namespace): `installImageUrl()` registers one exact route; the
// Gallery spec owns cleanup (`assertClean()` in `finally`/`afterEach`) —
// `gameplayPage.assertSettled()` is a no-op for Gallery-only navigations.
//
// Method enforcement matches the fixture router: a non-GET request to a
// registered image endpoint receives a 405 with the harness-violation marker.
//
// Teardown: `assertClean()` throws (with the held URLs) while any request is
// still held, so a forgotten `release()`/`cancel()` fails the test instead of
// hanging it. `gameplayPage.assertSettled()` calls it for gameplay fixture
// holds; Gallery specs call it directly. A `release()` that finds a request
// the page already aborted names it and rejects: fulfilling it can no longer
// produce a terminal event, so a settle barrier would just time out.
import type { Page, Route } from '@playwright/test';
import type { DeclaredImageFailure } from '../support/diagnostics';
import { getFixture, type GameplayFixture, type GameplayFixtureId } from './catalog';
import { buildPieceSvg, buildReferenceSvg, SVG_CONTENT_TYPE } from './assets';
import {
	FIXTURE_ROUTER_HEADER,
	FIXTURE_ROUTER_SOURCE,
	HARNESS_VIOLATION_HEADER
} from './fixture-router';

/** One gameplay fixture image endpoint to control. */
export type FixtureImageEndpoint =
	{ kind: 'piece'; pieceId: number } | { kind: 'reference' } | { kind: 'thumbnail' };

export interface ImageHoldSpec {
	endpoint: FixtureImageEndpoint;
	/**
	 * 'hold': keep the request pending until `release()`/`cancel()`.
	 * 'fail': fulfill immediately with `status` (default 404).
	 */
	outcome: 'hold' | 'fail';
	/** Failure status for outcome 'fail' (default 404). */
	status?: number;
}

export interface ImageHoldHandle {
	readonly pendingCount: number;
	/** Fulfill every held route with the declared image (fixture SVG / gallery SVG). */
	release(): Promise<void>;
	/** Abort every held route (simulates a cancelled image request). */
	cancel(): Promise<void>;
}

export interface ImageHoldController {
	/**
	 * Register hold/fail routes for known gameplay fixture image endpoints.
	 * Install AFTER the fixture router so the hold runs first; unclaimed
	 * requests fall through to the router.
	 */
	installFixtureImages(
		page: Page,
		fixtureId: GameplayFixtureId,
		specs: ImageHoldSpec[]
	): Promise<ImageHoldHandle>;
	/**
	 * Register one exact image URL route (e.g. a Gallery family thumbnail).
	 * Release fulfills a decodable SVG image; `failStatus` (default 404)
	 * fulfills the declared failure instead.
	 */
	installImageUrl(
		page: Page,
		urlPattern: RegExp,
		options?: { failStatus?: number }
	): Promise<ImageHoldHandle>;
	/** Throw (with details) if any image route is still held. */
	assertClean(): void;
	/** Unregister every route this controller installed. */
	dispose(): Promise<void>;
}

/** Full-URL regex matching exactly the declared fixture image endpoint. */
export function fixtureImagePathPattern(fixtureId: string, endpoint: FixtureImageEndpoint): RegExp {
	const base = `/api/puzzles/${fixtureId}`;
	switch (endpoint.kind) {
		case 'piece':
			return new RegExp(`${base}/pieces/${endpoint.pieceId}/image(?:\\?.*)?$`, 'i');
		case 'reference':
			return new RegExp(`${base}/reference(?:\\?.*)?$`, 'i');
		case 'thumbnail':
			return new RegExp(`${base}/thumbnail(?:\\?.*)?$`, 'i');
	}
}

/**
 * The diagnostics declaration for every fail spec — built from the same URL
 * pattern helper the route registration uses, so the declared URL and the
 * registered route cannot drift apart. Abort outcomes (a `cancel()` on a held
 * spec) are declared by the cancelling test on top of these.
 */
export function declaredImageFailures(
	fixtureId: string,
	specs: ImageHoldSpec[]
): DeclaredImageFailure[] {
	return specs
		.filter((spec) => spec.outcome === 'fail')
		.map((spec) => ({
			url: fixtureImagePathPattern(fixtureId, spec.endpoint),
			method: 'GET',
			status: spec.status ?? 404,
			outcome: 'status' as const
		}));
}

/** A minimal standalone SVG image body (explicit size → decodable, naturalWidth > 0). */
const GALLERY_IMAGE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
	'<rect width="64" height="64" fill="#385" /></svg>';

interface HeldRoute {
	url: string;
	method: string;
	route: Route;
	respond: () => Promise<void>;
}

interface InstalledRoute {
	page: Page;
	pattern: RegExp;
	handler: (route: Route) => Promise<void>;
}

function markerHeaders(): Record<string, string> {
	return { [FIXTURE_ROUTER_HEADER]: FIXTURE_ROUTER_SOURCE };
}

export function createImageHoldController(): ImageHoldController {
	const held: HeldRoute[] = [];
	const installed: InstalledRoute[] = [];

	async function methodViolation(route: Route): Promise<void> {
		await route.fulfill({
			status: 405,
			json: { error: 'method_not_allowed', allowed: 'GET' },
			headers: {
				[FIXTURE_ROUTER_HEADER]: FIXTURE_ROUTER_SOURCE,
				[HARNESS_VIOLATION_HEADER]: 'method_not_allowed'
			}
		});
	}

	async function installRoute(options: {
		page: Page;
		pattern: RegExp;
		/** Fulfill init for a released route (headers are stamped here). */
		released: () => { contentType: string; body: string };
		/** Declared failure status, or undefined for a hold-only route. */
		failStatus?: number;
	}): Promise<ImageHoldHandle> {
		const pending: HeldRoute[] = [];

		const handler = async (route: Route): Promise<void> => {
			const method = route.request().method();
			if (method !== 'GET') {
				await methodViolation(route);
				return;
			}
			if (options.failStatus !== undefined) {
				// Declared intentional failure: fixture-served provenance, no
				// violation marker — the test declares it to diagnostics.
				await route.fulfill({
					status: options.failStatus,
					json: { error: 'image_unavailable' },
					headers: markerHeaders()
				});
				return;
			}
			const url = route.request().url();
			const entry: HeldRoute = {
				url,
				method,
				route,
				respond: async () => {
					const { contentType, body } = options.released();
					await route.fulfill({ contentType, body, headers: markerHeaders() });
				}
			};
			pending.push(entry);
			held.push(entry);
		};

		await options.page.route(options.pattern, handler);
		installed.push({ page: options.page, pattern: options.pattern, handler });

		async function drain(
			answer: (entry: HeldRoute) => Promise<void>,
			options?: { reportAborted?: boolean }
		): Promise<void> {
			const done = pending.splice(0);
			const aborted: string[] = [];
			for (const entry of done) {
				try {
					// A page-driven abort (a reload that cancelled the request)
					// already produced its terminal event before this drain
					// started, so fulfilling it cannot produce another one.
					const failure = options?.reportAborted ? entry.route.request().failure() : null;
					if (failure) {
						aborted.push(`${entry.method} ${entry.url} (${failure.errorText})`);
						continue;
					}
					await answer(entry);
				} catch {
					// A route may already be closed/cancelled (e.g. by a page reload);
					// keep draining so later held entries are never left hanging.
				} finally {
					const at = held.indexOf(entry);
					if (at !== -1) held.splice(at, 1);
				}
			}
			if (aborted.length > 0) {
				throw new Error(
					`ImageHold release: ${aborted.length} held request(s) were already aborted before release — no terminal event will follow:\n` +
						aborted.map((line) => `  - ${line}`).join('\n')
				);
			}
		}

		return {
			get pendingCount() {
				return pending.length;
			},
			release() {
				return drain((entry) => entry.respond(), { reportAborted: true });
			},
			cancel() {
				return drain((entry) => entry.route.abort('failed'));
			}
		};
	}

	return {
		async installFixtureImages(page, fixtureId, specs) {
			const fixture = getFixture(fixtureId) as GameplayFixture | undefined;
			if (!fixture) {
				throw new Error(
					`image-hold: unknown fixture id ${fixtureId} — refusing to register routes no request can hit`
				);
			}

			const handles: ImageHoldHandle[] = [];
			for (const spec of specs) {
				if (spec.endpoint.kind === 'piece') {
					const pieceId = spec.endpoint.pieceId;
					if (!fixture.pieces.some((piece) => piece.id === pieceId)) {
						throw new Error(
							`image-hold: fixture ${fixtureId} has no piece ${pieceId} — refusing to register a route no request can hit`
						);
					}
				}
				const released = () => {
					const body =
						spec.endpoint.kind === 'piece'
							? buildPieceSvg(fixture, spec.endpoint.pieceId)
							: buildReferenceSvg(fixture);
					return { contentType: SVG_CONTENT_TYPE, body };
				};
				handles.push(
					await installRoute({
						page,
						pattern: fixtureImagePathPattern(fixtureId, spec.endpoint),
						released,
						failStatus: spec.outcome === 'fail' ? (spec.status ?? 404) : undefined
					})
				);
			}

			// One aggregate handle: pendingCount spans the specs; release/cancel
			// fan out to every held route across them. A spec that rejects (a
			// page-aborted request) must not starve the later specs — drain all,
			// then propagate, matching drain()'s own keep-draining rule.
			async function drainAll(action: (handle: ImageHoldHandle) => Promise<void>): Promise<void> {
				const failures: string[] = [];
				for (const handle of handles) {
					try {
						await action(handle);
					} catch (error) {
						failures.push(error instanceof Error ? error.message : String(error));
					}
				}
				if (failures.length > 0) throw new Error(failures.join('\n'));
			}

			return {
				get pendingCount() {
					return handles.reduce((sum, handle) => sum + handle.pendingCount, 0);
				},
				release() {
					return drainAll((handle) => handle.release());
				},
				cancel() {
					return drainAll((handle) => handle.cancel());
				}
			};
		},
		installImageUrl(page, urlPattern, options) {
			return installRoute({
				page,
				pattern: urlPattern,
				released: () => ({ contentType: SVG_CONTENT_TYPE, body: GALLERY_IMAGE_SVG }),
				failStatus: options?.failStatus
			});
		},
		assertClean() {
			if (held.length === 0) return;
			const details = held.map((entry) => `  - ${entry.method} ${entry.url}`).join('\n');
			throw new Error(
				`ImageHold teardown: ${held.length} image route(s) still pending — call release() or cancel() on the hold handle:\n${details}`
			);
		},
		async dispose() {
			const routes = installed.splice(0);
			for (const entry of routes) {
				await entry.page.unroute(entry.pattern, entry.handler);
			}
		}
	};
}
