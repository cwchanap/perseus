import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Env } from '../worker';
import {
	OAUTH_STATE_TTL_SECONDS,
	PLAYER_SESSION_DURATION_MS,
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	decryptOAuthState,
	encryptOAuthState,
	exchangeGoogleCode,
	parseReturnTo,
	resolveAllowedOrigins,
	verifyGoogleIdToken
} from '../services/player-auth.shared';
import {
	createPlayerSession,
	getAllowlistEntry,
	getPlayerSession,
	revokePlayerSession,
	upsertPlayer
} from '../services/player-auth.worker';
import { oauthRateLimit } from '../middleware/rate-limit.worker';

const PLAYER_SESSION_COOKIE = 'perseus_player_session';
const OAUTH_STATE_COOKIE = 'perseus_oauth_state';
const OAUTH_DATA_COOKIE = 'perseus_oauth_data';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = OAUTH_STATE_TTL_SECONDS;
const PLAYER_SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(PLAYER_SESSION_DURATION_MS / 1000);

const auth = new Hono<{ Bindings: Env }>();
type AuthContext = Context<{ Bindings: Env }>;

function withNoStore(response: Response): Response {
	response.headers.set('Cache-Control', 'no-store');
	return response;
}

function serverMisconfigured(): Response {
	return withNoStore(
		new Response(
			JSON.stringify({
				error: 'server_misconfigured',
				message: 'Server configuration error'
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			}
		)
	);
}

function allowedOriginSet(allowedOrigins: string | undefined): Set<string> {
	const origins = new Set<string>();
	for (const origin of (allowedOrigins || '').split(',')) {
		const trimmed = origin.trim();
		if (!trimmed) continue;
		try {
			origins.add(new URL(trimmed).origin);
		} catch {
			// Invalid configured origins are ignored and will fail redirect origin matching.
		}
	}
	return origins;
}

function isLocalHttpUrl(url: URL): boolean {
	return (
		url.protocol === 'http:' &&
		(url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
	);
}

function isValidAuthRedirectBaseUrl(env: Env): boolean {
	if (!env.AUTH_REDIRECT_BASE_URL) return false;
	try {
		const url = new URL(env.AUTH_REDIRECT_BASE_URL);
		if (env.NODE_ENV === 'development') {
			return url.protocol === 'https:' || isLocalHttpUrl(url);
		}
		return (
			url.protocol === 'https:' &&
			url.username === '' &&
			url.password === '' &&
			allowedOriginSet(env.ALLOWED_ORIGINS).has(url.origin)
		);
	} catch {
		return false;
	}
}

function isValidOAuthEnv(env: Env): boolean {
	return Boolean(
		env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && isValidAuthRedirectBaseUrl(env)
	);
}

function callbackUrl(env: Env): string {
	return new URL('/api/auth/google/callback', env.AUTH_REDIRECT_BASE_URL).toString();
}

function cookieOptions(env: Env, maxAge: number) {
	return {
		httpOnly: true,
		secure: env.NODE_ENV !== 'development',
		sameSite: 'Lax' as const,
		path: '/',
		maxAge
	};
}

function setPlayerSessionCookie(c: AuthContext, token: string): void {
	setCookie(
		c,
		PLAYER_SESSION_COOKIE,
		token,
		cookieOptions(c.env, PLAYER_SESSION_COOKIE_MAX_AGE_SECONDS)
	);
}

function clearPlayerSessionCookie(c: AuthContext): void {
	setCookie(c, PLAYER_SESSION_COOKIE, '', cookieOptions(c.env, 0));
}

function setOAuthStateCookie(c: AuthContext, state: string): void {
	setCookie(c, OAUTH_STATE_COOKIE, state, cookieOptions(c.env, OAUTH_STATE_COOKIE_MAX_AGE_SECONDS));
}

function setOAuthDataCookie(c: AuthContext, encrypted: string): void {
	setCookie(
		c,
		OAUTH_DATA_COOKIE,
		encrypted,
		cookieOptions(c.env, OAUTH_STATE_COOKIE_MAX_AGE_SECONDS)
	);
}

function clearOAuthCookies(c: AuthContext): void {
	setCookie(c, OAUTH_STATE_COOKIE, '', cookieOptions(c.env, 0));
	setCookie(c, OAUTH_DATA_COOKIE, '', cookieOptions(c.env, 0));
}

function extractWebOrigin(returnTo: string): string | undefined {
	try {
		return new URL(returnTo).origin;
	} catch {
		return undefined;
	}
}

function redirectToLogin(c: AuthContext, error: string, webOrigin?: string): Response {
	clearOAuthCookies(c);
	const loginUrl = webOrigin
		? `${webOrigin}/login?error=${encodeURIComponent(error)}`
		: `/login?error=${encodeURIComponent(error)}`;
	return withNoStore(c.redirect(loginUrl));
}

auth.use('*', async (c, next) => {
	if (!isValidOAuthEnv(c.env)) {
		return serverMisconfigured();
	}
	await next();
});

auth.use('/google/start', oauthRateLimit);
auth.use('/google/callback', oauthRateLimit);

auth.get('/google/start', async (c) => {
	const state = createOAuthState();
	const pkce = await createPkcePair();
	const returnTo = parseReturnTo(
		c.req.query('returnTo'),
		resolveAllowedOrigins(c.env.ALLOWED_ORIGINS, c.env.NODE_ENV)
	);

	const stateData = {
		codeVerifier: pkce.verifier,
		returnTo,
		createdAt: Date.now()
	};
	const encrypted = await encryptOAuthState(c.env.JWT_SECRET, stateData);
	setOAuthStateCookie(c, state);
	setOAuthDataCookie(c, encrypted);

	const url = buildGoogleAuthUrl({
		clientId: c.env.GOOGLE_CLIENT_ID,
		redirectUri: callbackUrl(c.env),
		state,
		codeChallenge: pkce.challenge
	});
	return withNoStore(c.redirect(url.toString()));
});

auth.get('/google/callback', async (c) => {
	const state = c.req.query('state');
	const code = c.req.query('code');
	const error = c.req.query('error');
	const cookieState = getCookie(c, OAUTH_STATE_COOKIE);

	if (error) {
		let webOrigin: string | undefined;
		if (state && cookieState === state) {
			const encryptedData = getCookie(c, OAUTH_DATA_COOKIE);
			if (encryptedData) {
				const stored = await decryptOAuthState(c.env.JWT_SECRET, encryptedData);
				if (stored) {
					webOrigin = extractWebOrigin(stored.returnTo);
				}
			}
		}
		return redirectToLogin(c, 'access_denied', webOrigin);
	}

	if (!state || !code || cookieState !== state) {
		return redirectToLogin(c, 'session_expired');
	}

	const encryptedData = getCookie(c, OAUTH_DATA_COOKIE);
	if (!encryptedData) {
		return redirectToLogin(c, 'session_expired');
	}

	const storedState = await decryptOAuthState(c.env.JWT_SECRET, encryptedData);
	if (!storedState || storedState.createdAt + OAUTH_STATE_TTL_SECONDS * 1000 <= Date.now()) {
		return redirectToLogin(c, 'session_expired');
	}

	const webOrigin = extractWebOrigin(storedState.returnTo);

	try {
		const tokenResponse = await exchangeGoogleCode({
			code,
			clientId: c.env.GOOGLE_CLIENT_ID,
			clientSecret: c.env.GOOGLE_CLIENT_SECRET,
			redirectUri: callbackUrl(c.env),
			codeVerifier: storedState.codeVerifier
		});
		const claims = await verifyGoogleIdToken(tokenResponse.id_token, c.env.GOOGLE_CLIENT_ID);
		const allowlistEntry = await getAllowlistEntry(c.env.PUZZLE_METADATA, claims.email);
		if (!allowlistEntry) {
			return redirectToLogin(c, 'not_allowed', webOrigin);
		}

		const player = await upsertPlayer(c.env.PUZZLE_METADATA, claims);
		const session = await createPlayerSession(c.env.PUZZLE_METADATA, player);
		setPlayerSessionCookie(c, session.token);
		clearOAuthCookies(c);
		return withNoStore(c.redirect(storedState.returnTo));
	} catch (error) {
		console.error('Player Google auth callback failed:', error);
		return redirectToLogin(c, 'google_error', webOrigin);
	}
});

auth.get('/session', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (!token) {
		return withNoStore(c.json({ authenticated: false }));
	}

	const session = await getPlayerSession(c.env.PUZZLE_METADATA, token);
	if (!session) {
		// Don't clear the cookie on a KV miss — the session may have been just
		// created and KV eventual consistency hasn't propagated yet. The cookie
		// expires naturally via its maxAge, and /logout explicitly clears it.
		return withNoStore(c.json({ authenticated: false }));
	}

	return withNoStore(c.json({ authenticated: true, user: session.user }));
});

auth.post('/logout', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (token) {
		await revokePlayerSession(c.env.PUZZLE_METADATA, token);
	}
	clearPlayerSessionCookie(c);
	return withNoStore(c.json({ success: true }));
});

export default auth;
