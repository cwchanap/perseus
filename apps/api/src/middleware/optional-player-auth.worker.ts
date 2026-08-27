import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../worker';
import { getPlayerSession, type PlayerSessionRecord } from '../services/player-auth.worker';
import { PLAYER_SESSION_COOKIE } from './player-auth.worker';

type OptionalPlayerAuthEnv = {
	Bindings: Env;
	Variables: {
		playerSession?: PlayerSessionRecord;
	};
};

export const optionalPlayerAuth = createMiddleware<OptionalPlayerAuthEnv>(async (c, next) => {
	const token = getCookie(c, PLAYER_SESSION_COOKIE);
	if (token) {
		const session = await getPlayerSession(c.env.PUZZLE_METADATA, token);
		if (session) c.set('playerSession', session);
	}
	await next();
});
