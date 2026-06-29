import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import { recordCompletion } from '@perseus/shared';
import { isPuzzleId } from '@perseus/types';
import { getPuzzle } from '../services/storage.worker';
import { requirePlayerAuth } from '../middleware/player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';

const router = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

// Sanity ceiling for reported solve times. The client timer only counts
// visible active time (it pauses on tab-hide), so any real solve is far below
// this; values above are garbage / abuse and rejected before hitting the DB.
const MAX_COMPLETION_TIME_SECONDS = 24 * 60 * 60;

router.post('/:id/complete', requirePlayerAuth, async (c) => {
	const puzzleId = c.req.param('id');

	// Validate puzzle ID format before any I/O: the client timer only ticks for
	// real puzzle pages, so a malformed id signals an abuse attempt.
	if (!isPuzzleId(puzzleId)) {
		return c.json({ error: 'bad_request', message: 'Invalid puzzle ID format' }, 400);
	}

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
	if (timeSeconds > MAX_COMPLETION_TIME_SECONDS) {
		return c.json(
			{ error: 'bad_request', message: 'timeSeconds exceeds the maximum allowed solve time' },
			400
		);
	}

	// Confirm the puzzle exists before recording, so puzzle_stats can't
	// accumulate rows for non-existent puzzles.
	if (!(await getPuzzle(c.env.PUZZLE_METADATA, puzzleId))) {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	const session = c.get('playerSession');
	await recordCompletion(getWorkerDb(c.env), session.user.id, puzzleId, Math.floor(timeSeconds));
	return c.json({ ok: true });
});

export default router;
