import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { getPlayerSession, type PlayerSessionRecord } from '../services/player-auth';

export const PLAYER_SESSION_COOKIE = 'perseus_player_session';

type PlayerAuthEnv = {
	Variables: {
		playerSession: PlayerSessionRecord;
	};
};

export const requirePlayerAuth = createMiddleware<PlayerAuthEnv>(async (c, next) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);

	if (!token) {
		return c.json({ error: 'unauthorized', message: 'Player authentication required' }, 401);
	}

	const session = await getPlayerSession(token);

	if (!session) {
		return c.json({ error: 'unauthorized', message: 'Invalid or expired player session' }, 401);
	}

	c.set('playerSession', session);
	await next();
});
