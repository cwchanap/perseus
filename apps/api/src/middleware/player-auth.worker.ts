import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { Env } from '../worker';
import { getPlayerSession, type PlayerSessionRecord } from '../services/player-auth.worker';

export const PLAYER_SESSION_COOKIE = 'perseus_player_session';

export type PlayerAuthContext = Context;

export function playerSessionTokenFromRequest(c: PlayerAuthContext): string | null {
	const authorization = c.req.header('Authorization');
	if (authorization !== undefined) {
		const match = /^Bearer ([^\s]+)$/.exec(authorization);
		return match?.[1] ?? null;
	}
	return getCookie(c, PLAYER_SESSION_COOKIE) ?? null;
}

export async function resolvePlayerSession(
	c: PlayerAuthContext
): Promise<PlayerSessionRecord | null> {
	const token = playerSessionTokenFromRequest(c);
	return token ? getPlayerSession((c.env as Env).PUZZLE_METADATA, token) : null;
}

type PlayerAuthEnv = {
	Bindings: Env;
	Variables: {
		playerSession: PlayerSessionRecord;
	};
};

export const requirePlayerAuth = createMiddleware<PlayerAuthEnv>(async (c, next) => {
	const token = playerSessionTokenFromRequest(c);

	if (!token) {
		return c.json({ error: 'unauthorized', message: 'Player authentication required' }, 401);
	}

	const session = await resolvePlayerSession(c);

	if (!session) {
		return c.json({ error: 'unauthorized', message: 'Invalid or expired player session' }, 401);
	}

	c.set('playerSession', session);
	await next();
});
