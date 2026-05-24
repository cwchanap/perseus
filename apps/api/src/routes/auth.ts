import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import {
	PLAYER_SESSION_DURATION_MS,
	buildGoogleAuthUrl,
	createOAuthState,
	createPkcePair,
	exchangeGoogleCode,
	parseReturnTo,
	resolveAllowedOrigins,
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
} from '../services/player-auth';

const PLAYER_SESSION_COOKIE = 'perseus_player_session';
const OAUTH_STATE_COOKIE = 'perseus_oauth_state';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const PLAYER_SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(PLAYER_SESSION_DURATION_MS / 1000);

interface OAuthEnv {
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	AUTH_REDIRECT_BASE_URL: string;
	ALLOWED_ORIGINS?: string;
	NODE_ENV?: string;
}

type AuthEnv = {
	Variables: {
		oauthEnv: OAuthEnv;
	};
};

const auth = new Hono<AuthEnv>();
type AuthContext = Context<AuthEnv>;

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

function envValue(name: keyof OAuthEnv): string | undefined {
	const value = process.env[name];
	if (!value || value.trim().length === 0) return undefined;
	return value;
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

function isValidAuthRedirectBaseUrl(env: OAuthEnv): boolean {
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

function readOAuthEnv(): OAuthEnv | null {
	const env: OAuthEnv = {
		GOOGLE_CLIENT_ID: envValue('GOOGLE_CLIENT_ID') || '',
		GOOGLE_CLIENT_SECRET: envValue('GOOGLE_CLIENT_SECRET') || '',
		AUTH_REDIRECT_BASE_URL: envValue('AUTH_REDIRECT_BASE_URL') || '',
		ALLOWED_ORIGINS: envValue('ALLOWED_ORIGINS'),
		NODE_ENV: envValue('NODE_ENV')
	};
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
	if (!isValidAuthRedirectBaseUrl(env)) return null;
	return env;
}

function callbackUrl(env: OAuthEnv): string {
	return new URL('/api/auth/google/callback', env.AUTH_REDIRECT_BASE_URL).toString();
}

function cookieOptions(maxAge: number) {
	return {
		httpOnly: true,
		secure: process.env.NODE_ENV !== 'development',
		sameSite: 'Lax' as const,
		path: '/',
		maxAge
	};
}

function setPlayerSessionCookie(c: AuthContext, token: string): void {
	setCookie(c, PLAYER_SESSION_COOKIE, token, cookieOptions(PLAYER_SESSION_COOKIE_MAX_AGE_SECONDS));
}

function clearPlayerSessionCookie(c: AuthContext): void {
	setCookie(c, PLAYER_SESSION_COOKIE, '', cookieOptions(0));
}

function setOAuthStateCookie(c: AuthContext, state: string): void {
	setCookie(c, OAUTH_STATE_COOKIE, state, cookieOptions(OAUTH_STATE_COOKIE_MAX_AGE_SECONDS));
}

function clearOAuthStateCookie(c: AuthContext): void {
	setCookie(c, OAUTH_STATE_COOKIE, '', cookieOptions(0));
}

function redirectToLogin(c: AuthContext, error: string): Response {
	clearOAuthStateCookie(c);
	return withNoStore(c.redirect(`/login?error=${encodeURIComponent(error)}`));
}

auth.use('*', async (c, next) => {
	const env = readOAuthEnv();
	if (!env) {
		return serverMisconfigured();
	}
	c.set('oauthEnv', env);
	await next();
});

auth.get('/google/start', async (c) => {
	const env = c.get('oauthEnv') as OAuthEnv;
	const state = createOAuthState();
	const pkce = await createPkcePair();
	const returnTo = parseReturnTo(
		c.req.query('returnTo'),
		resolveAllowedOrigins(env.ALLOWED_ORIGINS, env.NODE_ENV)
	);

	await storeOAuthState(state, {
		codeVerifier: pkce.verifier,
		returnTo
	});
	setOAuthStateCookie(c, state);

	const url = buildGoogleAuthUrl({
		clientId: env.GOOGLE_CLIENT_ID,
		redirectUri: callbackUrl(env),
		state,
		codeChallenge: pkce.challenge
	});
	return withNoStore(c.redirect(url.toString()));
});

auth.get('/google/callback', async (c) => {
	const env = c.get('oauthEnv') as OAuthEnv;
	const state = c.req.query('state');
	const code = c.req.query('code');
	const cookieState = getCookie(c, OAUTH_STATE_COOKIE);

	if (!state || !code || cookieState !== state) {
		return redirectToLogin(c, 'session_expired');
	}

	const storedState = await consumeOAuthState(state);
	if (!storedState) {
		return redirectToLogin(c, 'session_expired');
	}

	try {
		const tokenResponse = await exchangeGoogleCode({
			code,
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			redirectUri: callbackUrl(env),
			codeVerifier: storedState.codeVerifier
		});
		const claims = await verifyGoogleIdToken(tokenResponse.id_token, env.GOOGLE_CLIENT_ID);
		const allowlistEntry = await getAllowlistEntry(claims.email);
		if (!allowlistEntry) {
			return redirectToLogin(c, 'not_allowed');
		}

		const player = await upsertPlayer(claims);
		const session = await createPlayerSession(player);
		setPlayerSessionCookie(c, session.token);
		clearOAuthStateCookie(c);
		return withNoStore(c.redirect(storedState.returnTo));
	} catch (error) {
		console.error('Player Google auth callback failed:', error);
		return redirectToLogin(c, 'google_error');
	}
});

auth.get('/session', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (!token) {
		return withNoStore(c.json({ authenticated: false }));
	}

	const session = await getPlayerSession(token);
	if (!session) {
		clearPlayerSessionCookie(c);
		return withNoStore(c.json({ authenticated: false }));
	}

	return withNoStore(c.json({ authenticated: true, user: session.user }));
});

auth.post('/logout', async (c) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (token) {
		await revokePlayerSession(token);
	}
	clearPlayerSessionCookie(c);
	return withNoStore(c.json({ success: true }));
});

export default auth;
