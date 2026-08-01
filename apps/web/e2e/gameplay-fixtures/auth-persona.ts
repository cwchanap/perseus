// Auth personas for deterministic gameplay E2E.
//
// The puzzle page resolves auth state by calling `getPlayerSession()` which
// fetches `GET /api/auth/session` (credentials: include). Real player auth
// requires a Google OAuth round-trip we cannot perform in E2E, so a persona
// installs a Playwright route that answers `/api/auth/session` with a fixed
// `PlayerSessionResponse`. The puzzle page trusts that response, so no cookie
// or token seeding is required.
import type { Page } from '@playwright/test';
import type { PlayerSessionResponse, PlayerUser } from '@perseus/types';

export type AuthPersonaKind = 'authenticated' | 'anonymous';

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

export interface AuthPersona {
	readonly kind: AuthPersonaKind;
	/** The exact `PlayerSessionResponse` the persona answers with. */
	readonly sessionResponse: PlayerSessionResponse;
	/** Register the `/api/auth/session` intercept on the page. */
	install(page: Page): Promise<void>;
}

export function createAuthPersona(kind: AuthPersonaKind): AuthPersona {
	const sessionResponse: PlayerSessionResponse =
		kind === 'authenticated'
			? { authenticated: true, user: AUTHENTICATED_PLAYER }
			: { authenticated: false };

	return {
		kind,
		sessionResponse,
		async install(page: Page): Promise<void> {
			await page.route(SESSION_PATTERN, (route) => route.fulfill({ json: sessionResponse }));
		}
	};
}
