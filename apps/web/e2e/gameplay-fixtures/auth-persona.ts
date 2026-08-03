// Auth personas for deterministic gameplay E2E.
//
// The puzzle page resolves auth state by calling `getPlayerSession()` which
// fetches `GET /api/auth/session` (credentials: include). Real player auth
// requires a Google OAuth round-trip we cannot perform in E2E, so a persona
// installs a Playwright route that answers `/api/auth/session` with a fixed
// `PlayerSessionResponse`. The puzzle page trusts that response, so no cookie
// or token seeding is required.
//
// HTTP method enforcement: the persona enforces GET for /api/auth/session. A
// non-GET request receives a 405 with the harness violation header so a
// client-side method regression cannot pass E2E silently.
//
// Four persona kinds (per the HPA-226 design):
//   - anonymous: `{ authenticated: false }` — the default persona.
//   - authenticated: fixed deterministic `PlayerUser`.
//   - deferred-session: holds the request pending until `release()`/`cancel()`.
//   - failed-session: returns a configurable HTTP error status (default 500).
import type { Page, Route } from '@playwright/test';
import type { PlayerSessionResponse, PlayerUser } from '@perseus/types';
import { FIXTURE_ROUTER_HEADER, HARNESS_VIOLATION_HEADER } from './fixture-router';

export type AuthPersonaKind = 'authenticated' | 'anonymous' | 'deferred-session' | 'failed-session';

/**
 * Provenance value stamped on every auth-persona response via the shared
 * `x-perseus-e2e-source` header, so diagnostics can prove the persona (not the
 * real backend) answered `/api/auth/session` and distinguish a persona-driven
 * failure from a real regression.
 */
export const AUTH_PERSONA_SOURCE = 'auth-persona';

const SESSION_PATTERN = /\/api\/auth\/session(?:\?.*)?$/;

/**
 * Deterministic authenticated player. Fixed values so tests can assert the full
 * `PlayerUser` contract without per-run drift.
 */
export const AUTHENTICATED_PLAYER: PlayerUser = {
	id: 'e2e-player-1',
	email: 'e2e-player@example.test',
	name: 'E2E Player',
	createdAt: 1710000000000,
	lastLoginAt: 1710000001000
};

const ANONYMOUS_RESPONSE: PlayerSessionResponse = { authenticated: false };

const AUTHENTICATED_RESPONSE: PlayerSessionResponse = {
	authenticated: true,
	user: AUTHENTICATED_PLAYER
};

/** Handle for a deferred-session persona's held route. */
export interface AuthSessionHandle {
	readonly pendingCount: number;
	readonly released: boolean;
	readonly cancelled: boolean;
	/** Fulfill every held session route with the given (or default anonymous) response. */
	release(response?: PlayerSessionResponse): Promise<void>;
	/** Abort every held session route (simulates a network failure). */
	cancel(): Promise<void>;
}

interface PendingSessionRoute {
	route: Route;
}

export interface AuthPersona {
	readonly kind: AuthPersonaKind;
	/** The `PlayerSessionResponse` the persona answers with, when immediate. */
	readonly sessionResponse: PlayerSessionResponse | undefined;
	/** HTTP status the `failed-session` persona returns (undefined for other kinds). */
	readonly failedStatus: 500 | 502 | 503 | undefined;
	/** Register the `/api/auth/session` intercept on the page. */
	install(page: Page): Promise<AuthSessionHandle | null>;
}

/** Options for `createAuthPersona`. */
export interface AuthPersonaOptions {
	/** HTTP status for the `failed-session` persona. Defaults to 500. */
	failedStatus?: 500 | 502 | 503;
}

function personaHeaders(): Record<string, string> {
	return { [FIXTURE_ROUTER_HEADER]: AUTH_PERSONA_SOURCE };
}

function methodNotAllowedHeaders(): Record<string, string> {
	return {
		[FIXTURE_ROUTER_HEADER]: AUTH_PERSONA_SOURCE,
		[HARNESS_VIOLATION_HEADER]: 'method_not_allowed'
	};
}

export function createAuthPersona(
	kind: AuthPersonaKind,
	options?: AuthPersonaOptions
): AuthPersona {
	const sessionResponse: PlayerSessionResponse | undefined =
		kind === 'authenticated'
			? AUTHENTICATED_RESPONSE
			: kind === 'anonymous'
				? ANONYMOUS_RESPONSE
				: undefined;

	const failedStatus = options?.failedStatus ?? 500;

	return {
		kind,
		sessionResponse,
		failedStatus: kind === 'failed-session' ? failedStatus : undefined,
		async install(page: Page): Promise<AuthSessionHandle | null> {
			if (kind === 'deferred-session') {
				const pending: PendingSessionRoute[] = [];
				let released = false;
				let cancelled = false;

				await page.route(SESSION_PATTERN, async (route: Route) => {
					if (route.request().method() !== 'GET') {
						await route.fulfill({
							status: 405,
							json: { error: 'method_not_allowed', allowed: 'GET' },
							headers: methodNotAllowedHeaders()
						});
						return;
					}
					pending.push({ route });
				});

				const sessionHandle: AuthSessionHandle = {
					get pendingCount() {
						return pending.length;
					},
					get released() {
						return released;
					},
					get cancelled() {
						return cancelled;
					},
					async release(response: PlayerSessionResponse = ANONYMOUS_RESPONSE) {
						released = true;
						const held = pending.splice(0);
						for (const entry of held) {
							await entry.route.fulfill({ json: response, headers: personaHeaders() });
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
				return sessionHandle;
			}

			await page.route(SESSION_PATTERN, async (route: Route) => {
				if (route.request().method() !== 'GET') {
					await route.fulfill({
						status: 405,
						json: { error: 'method_not_allowed', allowed: 'GET' },
						headers: methodNotAllowedHeaders()
					});
					return;
				}
				if (kind === 'failed-session') {
					await route.fulfill({
						status: failedStatus,
						json: { error: 'session_unavailable', status: failedStatus },
						headers: personaHeaders()
					});
					return;
				}
				await route.fulfill({ json: sessionResponse, headers: personaHeaders() });
			});
			return null;
		}
	};
}
