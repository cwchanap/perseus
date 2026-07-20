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
// metadata, R2 assets (original + thumbnail + generated pieces), and the
// D1 ownership row.
//
// Threshold: puzzles that have been in "processing" status for longer
// than REAP_AFTER_MS are candidates. The threshold is intentionally
// generous (2 hours) to avoid reaping puzzles whose workflows are still
// legitimately running on large piece counts.
//
// 'complete' workflow status is NOT treated as dead: Cloudflare Workflows
// only mark a workflow 'complete' after every step succeeds, which means
// the finalize step ran and the authoritative PuzzleMetadataDO has
// status 'ready'. A KV read that still shows 'processing' is eventual-
// consistency lag (the DO's KV sync retries can exhaust), not an orphan.
// Reaping would destroy a valid completed puzzle, so we skip and let KV
// catch up. If KV never catches up, operator force-delete is the escape
// hatch (see docs/OPERATOR_RUNBOOK.md).

import { deletePuzzleAssets, deletePuzzleMetadata, getPuzzle, listPuzzles } from './storage.worker';
import { getWorkerDb } from '../db.worker';
import { deletePuzzleOwnership } from '@perseus/shared';
import type { Env } from '../worker';

/** Reap puzzles stuck in processing for longer than this. */
export const REAP_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Limit the number of puzzles reaped per scheduled run. */
export const REAP_BATCH_LIMIT = 50;

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

	// TODO(scale): listPuzzles scans the entire KV catalog on every run. This
	// is fine while puzzle counts are small, but becomes the dominant cost as
	// the catalog grows. When this scan shows up in tail-CPU profiles, add a
	// `processing:<puzzleId>` KV index written at create time and deleted on
	// finalize/fail, so the reaper can list only in-flight puzzles via a KV
	// prefix scan instead of the full catalog. The index is advisory (KV is
	// eventually consistent) — the workflow-status check below remains the
	// authoritative liveness signal, so a stale/missing index entry only
	// causes a skipped reap, never a wrong reap.
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
					const instance = await env.PUZZLE_WORKFLOW.get(puzzle.id);
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

				// 'complete' means every workflow step succeeded, including
				// finalize (which writes status 'ready' to the authoritative
				// PuzzleMetadataDO). A KV read that still shows 'processing'
				// is eventual-consistency lag, not an orphan — reaping would
				// destroy a valid completed puzzle. Skip and let KV catch up.
				if (workflowStatus === 'complete') {
					console.warn(
						`Reaper: workflow for ${puzzle.id} is complete but KV still shows processing (lag); skipping`
					);
					result.details.push({
						puzzleId: puzzle.id,
						action: 'skip-complete-kv-lag'
					});
					return;
				}

				// Workflow is dead (errored, terminated, or unknown/never-
				// created). Reap it.
				const isDead =
					workflowStatus === 'errored' ||
					workflowStatus === 'terminated' ||
					workflowStatus === 'unknown';

				if (!isDead) {
					// Unknown status string — skip to be safe.
					console.warn(
						`Reaper: unrecognized workflow status '${workflowStatus}' for ${puzzle.id}, skipping`
					);
					return;
				}

				// Delete all R2 assets (original + thumbnail + generated
				// pieces). Uses pieceCount from metadata; R2 deletes on non-
				// existent keys are no-ops, so partial generation is covered.
				// Best-effort: log failures but continue to KV/D1 cleanup.
				try {
					const pieceCount = typeof meta.pieceCount === 'number' ? meta.pieceCount : 0;
					const r2Result = await deletePuzzleAssets(env.PUZZLES_BUCKET, puzzle.id, pieceCount);
					if (!r2Result.success) {
						console.error(
							`Reaper: failed to delete some R2 assets for ${puzzle.id}:`,
							r2Result.failedKeys
						);
						result.details.push({
							puzzleId: puzzle.id,
							action: 'r2-delete-partial',
							error: `failed keys: ${r2Result.failedKeys.join(', ')}`
						});
					}
				} catch (r2Err) {
					// Log but continue — we still want to delete KV/D1 metadata.
					console.error(`Reaper: failed to delete R2 assets for ${puzzle.id}:`, r2Err);
					result.details.push({
						puzzleId: puzzle.id,
						action: 'r2-delete-failed',
						error: String(r2Err)
					});
				}

				// Delete KV metadata. deletePuzzleMetadata never throws — it
				// returns { success, error } so a KV failure is observable here
				// without a try/catch around a non-throwing call. Branching on
				// .success keeps reaped++ honest (only increments when the KV
				// delete actually succeeded) and emits a kv-delete-failed detail
				// on failure so operators see the failure in the run summary.
				const kvResult = await deletePuzzleMetadata(env.PUZZLE_METADATA, puzzle.id);
				if (kvResult.success) {
					result.reaped++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'reaped'
					});
				} else {
					console.error(`Reaper: failed to delete KV metadata for ${puzzle.id}:`, kvResult.error);
					result.errors++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'kv-delete-failed',
						error: String(kvResult.error)
					});
				}

				// Best-effort D1 ownership row cleanup. Player uploads insert
				// a D1 ownership row with status 'processing', which is visible
				// in the uploader's "My Puzzles" list (VISIBLE_PLAYER_PUZZLE_
				// STATUSES includes 'processing'). Without this, a reaped
				// player puzzle keeps surfacing as a card that 404s on click.
				// Best-effort: a D1 failure is logged, not fatal — KV deletion
				// above is the source of truth for puzzle visibility. Mirrors
				// the withDbBestEffort pattern in admin.worker.ts.
				try {
					await deletePuzzleOwnership(getWorkerDb(env), puzzle.id).catch((err) =>
						console.error(`Reaper: failed to delete D1 ownership for ${puzzle.id}:`, err)
					);
				} catch (dbErr) {
					console.error(`Reaper: failed to init DB for ownership cleanup of ${puzzle.id}:`, dbErr);
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
