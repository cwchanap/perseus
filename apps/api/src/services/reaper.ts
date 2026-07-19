// Reaper: cron-triggered cleanup of orphaned puzzle metadata + R2 objects.
//
// When a puzzle create dies between createPuzzleMetadata and
// PUZZLE_WORKFLOW.create (or the workflow later errors/terminates), the
// puzzle's KV metadata and R2 original image are left behind. The
// stale-pending reclaim path in PuzzleMetadataDO marks the reservation
// failed so a retry creates a fresh puzzle, but the stuck puzzle's
// metadata and image remain for operator cleanup. This reaper automates
// that cleanup: it scans KV for long-stuck "processing" puzzles, checks
// the workflow status, and if the workflow is dead, deletes the KV
// metadata and R2 original image.
//
// Threshold: puzzles that have been in "processing" status for longer
// than REAP_AFTER_MS are candidates. The threshold is intentionally
// generous (2 hours) to avoid reaping puzzles whose workflows are still
// legitimately running on large piece counts.

import {
	deleteOriginalImage,
	deletePuzzleMetadata,
	getPuzzle,
	listPuzzles
} from './storage.worker';
import type { Env } from '../worker';

/** Reap puzzles stuck in processing for longer than this. */
export const REAP_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Limit the number of puzzles reaped per scheduled run. */
export const REAP_BATCH_LIMIT = 50;

/** Workflow instance with a status() method (Cloudflare Workflows API). */
interface WorkflowInstance {
	status(): Promise<{ status: string }>;
}

/** Workflow binding with the instance methods the reaper needs. */
interface WorkflowBindingForReap {
	get(id: string): Promise<WorkflowInstance>;
}

export interface ReapResult {
	scanned: number;
	candidates: number;
	reaped: number;
	errors: number;
	details: Array<{ puzzleId: string; action: string; error?: string }>;
}

/**
 * Scan KV for stuck "processing" puzzles and clean up those whose workflows
 * are dead (errored, terminated, or unknown/never-created). Returns a summary
 * of what was done. Safe to run concurrently — deletions are idempotent.
 */
export async function reapStuckPuzzles(env: Env, now = Date.now()): Promise<ReapResult> {
	const result: ReapResult = {
		scanned: 0,
		candidates: 0,
		reaped: 0,
		errors: 0,
		details: []
	};

	const { puzzles } = await listPuzzles(env.PUZZLE_METADATA);
	result.scanned = puzzles.length;

	const stuck = puzzles.filter(
		(p) =>
			p.status === 'processing' &&
			typeof p.createdAt === 'number' &&
			now - p.createdAt > REAP_AFTER_MS
	);
	result.candidates = stuck.length;

	if (stuck.length === 0) {
		return result;
	}

	// Process in batches to avoid exceeding CPU time limits.
	const batch = stuck.slice(0, REAP_BATCH_LIMIT);

	await Promise.all(
		batch.map(async (puzzle) => {
			try {
				// Re-read full metadata (listPuzzles returns summaries).
				const meta = await getPuzzle(env.PUZZLE_METADATA, puzzle.id);
				if (!meta || meta.status !== 'processing') {
					// Status changed since the list — skip.
					return;
				}

				// Check if the workflow is dead.
				let workflowStatus: string;
				try {
					const instance = await (env.PUZZLE_WORKFLOW as unknown as WorkflowBindingForReap).get(
						puzzle.id
					);
					workflowStatus = (await instance.status()).status;
				} catch (wfErr) {
					// If we can't reach the workflow API, skip — don't reap
					// a puzzle whose workflow might still be running.
					console.error(`Reaper: workflow status check failed for ${puzzle.id}, skipping:`, wfErr);
					result.errors++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'skip',
						error: 'workflow status check failed'
					});
					return;
				}

				if (workflowStatus === 'running') {
					// Workflow is still alive — don't reap.
					return;
				}

				// Workflow is dead (errored, terminated, unknown, or
				// complete—but if complete, the workflow should have set
				// status to 'ready' or 'failed'; a 'processing' puzzle with
				// a completed workflow is itself an orphan). Reap it.
				const isDead =
					workflowStatus === 'errored' ||
					workflowStatus === 'terminated' ||
					workflowStatus === 'unknown' ||
					// 'complete' with status still 'processing' means the
					// workflow finished but didn't update metadata — orphan.
					workflowStatus === 'complete';

				if (!isDead) {
					// Unknown status string — skip to be safe.
					console.warn(
						`Reaper: unrecognized workflow status '${workflowStatus}' for ${puzzle.id}, skipping`
					);
					return;
				}

				// Delete R2 original image (best-effort).
				try {
					await deleteOriginalImage(env.PUZZLES_BUCKET, puzzle.id);
				} catch (r2Err) {
					// Log but continue — we still want to delete KV metadata.
					console.error(`Reaper: failed to delete R2 image for ${puzzle.id}:`, r2Err);
					result.details.push({
						puzzleId: puzzle.id,
						action: 'r2-delete-failed',
						error: String(r2Err)
					});
				}

				// Delete KV metadata.
				try {
					await deletePuzzleMetadata(env.PUZZLE_METADATA, puzzle.id);
					result.reaped++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'reaped'
					});
				} catch (kvErr) {
					console.error(`Reaper: failed to delete KV metadata for ${puzzle.id}:`, kvErr);
					result.errors++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'kv-delete-failed',
						error: String(kvErr)
					});
				}
			} catch (err) {
				console.error(`Reaper: unexpected error for ${puzzle.id}:`, err);
				result.errors++;
				result.details.push({
					puzzleId: puzzle.id,
					action: 'error',
					error: String(err)
				});
			}
		})
	);

	return result;
}
