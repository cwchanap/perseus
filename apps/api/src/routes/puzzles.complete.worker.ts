import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDb } from '../db.worker';
import { recordCompletion, ensurePuzzleOwnership, SYSTEM_OWNER_ID } from '@perseus/shared';
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
	if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds) || timeSeconds < 1) {
		return c.json(
			{ error: 'bad_request', message: 'timeSeconds must be a number of at least 1 second' },
			400
		);
	}
	if (timeSeconds > MAX_COMPLETION_TIME_SECONDS) {
		return c.json(
			{ error: 'bad_request', message: 'timeSeconds exceeds the maximum allowed solve time' },
			400
		);
	}

	// Confirm the puzzle exists and is ready before recording, so puzzle_stats
	// can't accumulate rows for non-existent or not-yet-generated puzzles.
	// Mirrors GET /api/puzzles/:id, which 404s non-ready puzzles. getPuzzle
	// re-throws on corrupt metadata (validation failure); catch those and
	// return a deliberate 500 instead of letting Hono emit a generic
	// unstructured 500 (no app.onError is defined).
	let puzzle: Awaited<ReturnType<typeof getPuzzle>>;
	try {
		puzzle = await getPuzzle(c.env.PUZZLE_METADATA, puzzleId);
	} catch (error) {
		console.error(`Failed to retrieve puzzle ${puzzleId}:`, error);
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
	}
	if (!puzzle || puzzle.status !== 'ready') {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	const session = c.get('playerSession');
	const db = getWorkerDb(c.env);
	// Lazily backfill a system-owned D1 row for puzzles that predate the D1
	// mirror or whose best-effort ownership insert failed at creation time.
	// Without this row, listPlayerStats left-joins a missing puzzles row and
	// the Best Times UI shows the puzzle UUID instead of its name. Best-effort:
	// a failure is logged, not fatal — recordCompletion below is the
	// authoritative write and would surface a real D1 outage anyway.
	await ensurePuzzleOwnership(db, {
		id: puzzleId,
		ownerId: SYSTEM_OWNER_ID,
		name: puzzle.name,
		pieceCount: puzzle.pieceCount,
		...(puzzle.category ? { category: puzzle.category } : {}),
		status: 'ready',
		createdAt: puzzle.createdAt
	}).catch((err) => console.error(`Failed to backfill puzzle ownership for ${puzzleId}:`, err));
	await recordCompletion(db, session.user.id, puzzleId, Math.floor(timeSeconds));
	return c.json({ ok: true });
});

export default router;
