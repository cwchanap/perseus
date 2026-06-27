import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import { recordCompletion } from '@perseus/shared';
import { requirePlayerAuth } from '../middleware/player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

const router = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

router.post('/:id/complete', requirePlayerAuth, async (c) => {
	const puzzleId = c.req.param('id');
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
	}
	const timeSeconds =
		body && typeof body === 'object' && 'timeSeconds' in body
			? (body as { timeSeconds: unknown }).timeSeconds
			: undefined;
	if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds) || timeSeconds < 0) {
		return c.json(
			{ error: 'bad_request', message: 'timeSeconds must be a non-negative number' },
			400
		);
	}
	const session = c.get('playerSession');
	await recordCompletion(getWorkerDb(c.env), session.user.id, puzzleId, Math.floor(timeSeconds));
	return c.json({ ok: true });
});

export default router;
