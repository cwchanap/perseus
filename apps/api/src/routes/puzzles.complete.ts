import { Hono } from 'hono';
import { getDbContext } from '../db';
import {
	recordLegacyCompletion,
	recordVersionedCompletion,
	ensurePuzzleOwnership,
	SYSTEM_OWNER_ID
} from '@perseus/shared';
import { isPuzzleId } from '@perseus/types';
import { getPuzzle } from '../services/storage';
import { isPuzzleReady } from './puzzle-ready';
import { requirePlayerAuth } from '../middleware/player-auth';
import type { PlayerSessionRecord } from '../services/player-auth';
import {
	completionInternalErrorResponse,
	completionResultToResponse,
	parseCompletionRequest
} from './puzzles.complete.shared';

const router = new Hono<{ Variables: { playerSession: PlayerSessionRecord } }>();

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
	const parsed = parseCompletionRequest(body);
	if (!parsed.ok) return c.json(parsed.body, parsed.status);

	// Confirm the puzzle exists and is ready before recording, so puzzle_stats
	// can't accumulate rows for non-existent or not-yet-generated puzzles.
	// Mirrors the Worker route and GET /api/puzzles/:id, which 404 non-ready
	// puzzles. getPuzzle re-throws non-ENOENT errors (corrupt metadata,
	// permission denied); catch those and return a deliberate 500 instead of
	// letting Hono emit a generic unstructured 500 (no app.onError is defined).
	let puzzle: Awaited<ReturnType<typeof getPuzzle>>;
	try {
		puzzle = await getPuzzle(puzzleId);
	} catch (error) {
		console.error(`Failed to retrieve puzzle ${puzzleId}:`, error);
		const response = completionInternalErrorResponse('Failed to retrieve puzzle');
		return c.json(response.body, response.status);
	}
	if (!puzzle || !isPuzzleReady(puzzle)) {
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}

	const session = c.get('playerSession');
	const ownershipRow = {
		id: puzzleId,
		ownerId: SYSTEM_OWNER_ID,
		name: puzzle.name,
		pieceCount: puzzle.pieceCount,
		...(puzzle.category ? { category: puzzle.category } : {}),
		status: 'ready',
		createdAt: puzzle.createdAt
	} as const;

	try {
		const { db, completionWrites } = getDbContext();
		const result =
			parsed.value.kind === 'legacy'
				? await recordLegacyCompletion(
						completionWrites,
						session.user.id,
						puzzleId,
						parsed.value.timeSeconds
					)
				: await recordVersionedCompletion(
						completionWrites,
						session.user.id,
						puzzleId,
						parsed.value.request
					);
		const response = completionResultToResponse(result);
		if (result.status !== 'tombstoned') {
			// Lazily backfill a system-owned row for puzzles that predate the DB
			// mirror. Tombstones skip this so deletion cannot recreate ownership.
			await ensurePuzzleOwnership(db, ownershipRow).catch((err) =>
				console.error(`Failed to backfill puzzle ownership for ${puzzleId}:`, err)
			);
		}
		return c.json(response.body, response.status);
	} catch (error) {
		console.error(`Failed to record completion for puzzle ${puzzleId}:`, error);
		const response = completionInternalErrorResponse('Failed to record completion');
		return c.json(response.body, response.status);
	}
});

export default router;
