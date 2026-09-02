import { createMiddleware } from 'hono/factory';
import type { Env } from '../worker';
import { type PlayerSessionRecord } from '../services/player-auth.worker';
import { resolvePlayerSession } from './player-auth.worker';

type OptionalPlayerAuthEnv = {
	Bindings: Env;
	Variables: {
		playerSession?: PlayerSessionRecord;
	};
};

export const optionalPlayerAuth = createMiddleware<OptionalPlayerAuthEnv>(async (c, next) => {
	const session = await resolvePlayerSession(c);
	if (session) c.set('playerSession', session);
	await next();
});
