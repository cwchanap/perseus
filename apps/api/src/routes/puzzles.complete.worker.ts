import { Hono } from 'hono';
import type { Env } from '../worker';
import { getWorkerDbContext } from '../db.worker';
import {
	recordVersionedCompletion,
	ensurePuzzleFamilyOwnership,
	ensurePublicDisplayName,
	SYSTEM_OWNER_ID
} from '@perseus/shared';
import { isPuzzleId } from '@perseus/types';
import { resolvePlayableVariant } from '../services/variant-playability.worker';
import { requirePlayerAuth } from '../middleware/player-auth.worker';
import type { PlayerSessionRecord } from '../services/player-auth.worker';
import {
	completionInternalErrorResponse,
	completionResultToResponse,
	parseCompletionRequest
} from './puzzles.complete.shared';

const router = new Hono<{
	Bindings: Env;
	Variables: { playerSession: PlayerSessionRecord };
}>();

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
	// Mirrors GET /api/puzzles/:id, which 404s non-ready puzzles. resolvePlayableVariant
	// re-throws on corrupt family metadata (validation failure); catch those and
	// return a deliberate 500 instead of letting Hono emit a generic
	// unstructured 500 (no app.onError is defined).
	let resolved: Awaited<ReturnType<typeof resolvePlayableVariant>>;
	try {
		resolved = await resolvePlayableVariant(c.env.PUZZLE_METADATA, puzzleId);
	} catch (error) {
		console.error(`Failed to retrieve puzzle ${puzzleId}:`, error);
		const response = completionInternalErrorResponse('Failed to retrieve puzzle');
		return c.json(response.body, response.status);
	}
	if (!resolved.playable) {
		if (resolved.status === 500) {
			console.error(`Failed to resolve family for puzzle ${puzzleId}:`, resolved.error);
			const response = completionInternalErrorResponse('Failed to retrieve puzzle');
			return c.json(response.body, response.status);
		}
		return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
	}
	const { puzzle } = resolved;

	const session = c.get('playerSession');
	const familyOwnershipRow = {
		id: puzzle.familyId,
		ownerId: SYSTEM_OWNER_ID,
		name: puzzle.name,
		aspectRatio: puzzle.aspectRatio ?? '4:3',
		...(puzzle.category ? { category: puzzle.category } : {}),
		status: 'ready' as const,
		createdAt: puzzle.createdAt
	};

	try {
		const { db, completionWrites } = getWorkerDbContext(c.env);
		const result = await recordVersionedCompletion(
			db,
			completionWrites,
			session.user.id,
			puzzleId,
			parsed.value,
			{ familyId: puzzle.familyId, difficulty: puzzle.difficulty }
		);
		if (result.status === 'recorded' || result.status === 'replayed') {
			await ensurePublicDisplayName(db, session.user.id, session.user.name).catch((err) =>
				console.error(`Failed to persist public display name for ${session.user.id}:`, err)
			);
		}
		const response = completionResultToResponse(result);
		if (result.status !== 'tombstoned') {
			// Lazily backfill a system-owned row for families that predate the DB
			// mirror. Tombstones skip this so deletion cannot recreate ownership.
			await ensurePuzzleFamilyOwnership(db, familyOwnershipRow).catch((err) =>
				console.error(`Failed to backfill puzzle family ownership for ${puzzle.familyId}:`, err)
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
