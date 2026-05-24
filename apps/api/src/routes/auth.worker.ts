import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Env } from '../worker';
import {
	PLAYER_SESSION_DURATION_MS,
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	exchangeGoogleCode,
	parseReturnTo,
	verifyGoogleIdToken
} from '../services/player-auth.shared';
import {
	consumeOAuthState,
	createPlayerSession,
	getAllowlistEntry,
	getPlayerSession,
	revokePlayerSession,
	storeOAuthState,
	upsertPlayer
} from '../services/player-auth.worker';

const PLAYER_SESSION_COOKIE = 'perseus_player_session';
const OAUTH_STATE_COOKIE = 'perseus_oauth_state';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const PLAYER_SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(PLAYER_SESSION_DURATION_MS / 1000);

const auth = new Hono<{ Bindings: Env }>();
type AuthContext = Context<{ Bindings: Env }>;

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

function redirectToLogin(error: string): Response {
	return new Response(null, {
		status: 302,
		headers: { Location: `/login?error=${encodeURIComponent(error)}` }
	});
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

function clearOAuthStateCookie(c: AuthContext): void {
	setCookie(c, OAUTH_STATE_COOKIE, '', cookieOptions(c.env, 0));
}

auth.get('/google/start', async (c) => {
	const state = createOAuthState();
	const pkce = await createPkcePair();
	const returnTo = parseReturnTo(c.req.query('returnTo'));

	await storeOAuthState(c.env.PUZZLE_METADATA, state, {
		codeVerifier: pkce.verifier,
		returnTo
	});
	setOAuthStateCookie(c, state);

	const url = buildGoogleAuthUrl({
		clientId: c.env.GOOGLE_CLIENT_ID,
		redirectUri: callbackUrl(c.env),
		state,
		codeChallenge: pkce.challenge
	});
	return c.redirect(url.toString());
});

auth.get('/google/callback', async (c) => {
	const state = c.req.query('state');
	const code = c.req.query('code');
	const cookieState = getCookie(c, OAUTH_STATE_COOKIE);

	if (!state || !code || cookieState !== state) {
		return redirectToLogin('session_expired');
	}

	const storedState = await consumeOAuthState(c.env.PUZZLE_METADATA, state);
	if (!storedState) {
		return redirectToLogin('session_expired');
	}

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
			return redirectToLogin('not_allowed');
		}

		const player = await upsertPlayer(c.env.PUZZLE_METADATA, claims);
		const session = await createPlayerSession(c.env.PUZZLE_METADATA, player);
		setPlayerSessionCookie(c, session.token);
		clearOAuthStateCookie(c);
		return c.redirect(storedState.returnTo);
	} catch (error) {
		console.error('Player Google auth callback failed:', error);
		return redirectToLogin('google_error');
	}
});

auth.get('/session', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (!token) {
		return c.json({ authenticated: false });
	}

	const session = await getPlayerSession(c.env.PUZZLE_METADATA, token);
	if (!session) {
		clearPlayerSessionCookie(c);
		return c.json({ authenticated: false });
	}

	return c.json({ authenticated: true, user: session.user });
});

auth.post('/logout', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (token) {
		await revokePlayerSession(c.env.PUZZLE_METADATA, token);
	}
	clearPlayerSessionCookie(c);
	return c.json({ success: true });
});

export default auth;
