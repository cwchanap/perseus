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

import {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	deleteCleanupRecord,
	getAuthoritativeStatus,
	getIdempotencyReservation,
	getPuzzle,
	listPuzzles,
	listCleanupRecords,
	releaseIdempotencyKey
} from './storage.worker';
import { getWorkerDb } from '../db.worker';
import {
	deletePuzzleOwnership,
	deletePuzzleStats,
	getAvatarTokensByPlayerIds,
	isAliveWorkflowStatus,
	isDeadWorkflowStatus,
	isWorkflowNotFoundError
} from '@perseus/shared';
import type { Env } from '../worker';

/** Reap puzzles stuck in processing for longer than this. */
export const REAP_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Limit the number of puzzles reaped per scheduled run. */
export const REAP_BATCH_LIMIT = 50;

/**
 * Minimum age for a versioned avatar R2 object before the GC reaper will
 * delete it. The upload route's read-after-write cleanup covers the common
 * case, but concurrent overlapping uploads can still orphan a loser's object
 * (see player.worker.ts POST /avatar). This threshold gives in-flight uploads
 * time to complete their D1 write and authority check before the reaper
 * treats an unreferenced object as garbage.
 */
export const AVATAR_GC_AGE_MS = 1 * 60 * 60 * 1000; // 1 hour

/** Limit the number of avatar objects deleted per scheduled run. */
export const AVATAR_GC_BATCH_LIMIT = 200;

/**
 * Maximum number of R2 list pages fetched per scheduled avatar GC run. Each
 * page returns up to 1000 objects, so this bounds the list calls and memory
 * per run. The R2 list cursor is persisted between runs so the scan resumes
 * where it left off — without it, one run would list the entire avatars/
 * prefix before deleting anything, accumulating excessive R2 list calls and
 * memory as the bucket grows.
 */
export const AVATAR_GC_MAX_PAGES = 10;

// --- Reaper cursor persistence ---
//
// Each reaper selects a bounded batch from a deterministically-ordered
// candidate list. Without a persisted cursor, `slice(0, LIMIT)` always
// selects the same first N candidates. If those N persistently fail
// (workflow API unreachable, DO tombstone failing, R2 delete erroring),
// they occupy the batch every run and later candidates are NEVER visited
// — permanently starved behind the same noisy prefix.
//
// The fix: persist a numeric cursor in KV per reaper. Each run reads the
// cursor, selects a rotating page starting at the cursor (wrapping to the
// beginning), processes it, and advances the cursor by the page size
// REGARDLESS of whether individual candidates succeeded. This guarantees
// every candidate is eventually visited even if some persistently fail.
//
// The cursor is a numeric offset into the candidate list. The list changes
// between runs (items reaped drop out, new items added), so the offset is
// not a stable position — some items may be revisited or briefly skipped
// when the list shifts. This is acceptable for a GC reaper: deletions are
// idempotent, and the key property is that no candidate is permanently
// starved. A cursor read/parse failure falls back to 0 (the old behavior);
// a cursor write failure is logged, not fatal (the next run reuses the
// stale cursor — no worse than the old prefix behavior).

const REAPER_CURSOR_PREFIX = 'reaper:cursor:';

/** Read the persisted cursor for a reaper. Returns 0 if missing/unparseable. */
async function readReaperCursor(kv: KVNamespace, name: string): Promise<number> {
	try {
		const raw = await kv.get(REAPER_CURSOR_PREFIX + name);
		if (raw === null) return 0;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
	} catch {
		return 0;
	}
}

/** Persist the cursor for a reaper. Best-effort — logged, not fatal. */
async function writeReaperCursor(kv: KVNamespace, name: string, cursor: number): Promise<void> {
	try {
		await kv.put(REAPER_CURSOR_PREFIX + name, String(cursor));
	} catch (err) {
		console.error(`Reaper: failed to persist cursor for ${name}:`, err);
	}
}

/**
 * Read a persisted opaque-string cursor (e.g. an R2 list continuation
 * cursor). Returns undefined when missing/unparseable — the caller treats
 * that as "start from the beginning." Distinct from readReaperCursor
 * because R2 cursors are opaque strings, not numeric offsets.
 */
async function readReaperStringCursor(kv: KVNamespace, name: string): Promise<string | undefined> {
	try {
		const raw = await kv.get(REAPER_CURSOR_PREFIX + name);
		return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Persist an opaque-string cursor. A null/undefined cursor clears the
 * stored value so the next run starts from the beginning (used when a
 * listing scan completes). Best-effort — logged, not fatal.
 */
async function writeReaperStringCursor(
	kv: KVNamespace,
	name: string,
	cursor: string | undefined
): Promise<void> {
	try {
		if (cursor === undefined) {
			await kv.delete(REAPER_CURSOR_PREFIX + name);
		} else {
			await kv.put(REAPER_CURSOR_PREFIX + name, cursor);
		}
	} catch (err) {
		console.error(`Reaper: failed to persist string cursor for ${name}:`, err);
	}
}

/**
 * Select up to `limit` items from `arr` starting at `cursor`, wrapping to
 * the beginning if the end is reached. Returns items in processing order
 * (cursor, cursor+1, ..., wrap, ...). Returns an empty array if `arr` is
 * empty. If `cursor >= arr.length`, it is clamped via modulo first.
 */
function rotateSlice<T>(arr: T[], cursor: number, limit: number): T[] {
	if (arr.length === 0) return [];
	const start = cursor % arr.length;
	const count = Math.min(limit, arr.length);
	const result: T[] = [];
	for (let i = 0; i < count; i++) {
		result.push(arr[(start + i) % arr.length]);
	}
	return result;
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
 * are dead (errored, terminated, or never-created/not-found). Returns a
 * summary of what was done. Safe to run concurrently — deletions are
 * idempotent.
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

	// Process a rotating page starting at the persisted cursor. The cursor
	// advances by the page size regardless of individual success, so
	// persistently-failing candidates don't starve later ones. See the
	// cursor persistence comment above for the full rationale.
	const cursor = await readReaperCursor(env.PUZZLE_METADATA, 'stuck-puzzles');
	const batch = rotateSlice(stuck, cursor, REAP_BATCH_LIMIT);

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
					// A not-found error means the instance was never created (or
					// was deleted) — the puzzle is orphaned, so reap it. Map to
					// 'errored' (a confirmed-dead status) rather than 'unknown'
					// (which is NOT dead — it means liveness cannot be
					// established, and the workflow may still be running).
					// Other errors are transient (workflow API unreachable);
					// skip to avoid reaping a puzzle whose workflow might
					// still be live.
					if (isWorkflowNotFoundError(wfErr)) {
						workflowStatus = 'errored';
					} else {
						console.error(
							`Reaper: workflow status check failed for ${puzzle.id}, skipping:`,
							wfErr
						);
						result.errors++;
						result.details.push({
							puzzleId: puzzle.id,
							action: 'skip',
							error: 'workflow status check failed'
						});
						return;
					}
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

				// Any other non-terminal active status (queued, running,
				// paused, waiting, waitingForPause, rollingBack) means the
				// workflow may still make progress — don't reap.
				if (isAliveWorkflowStatus(workflowStatus)) {
					// Workflow is still alive — don't reap.
					return;
				}

				// Workflow is dead (errored, terminated, or never-created/
				// not-found — mapped to 'errored' above). Reap it.
				if (!isDeadWorkflowStatus(workflowStatus)) {
					// Unrecognized or unverifiable status (e.g. 'unknown' —
					// liveness cannot be established). Skip to be safe; the
					// workflow may still be running.
					console.warn(
						`Reaper: unrecognized or unverifiable workflow status '${workflowStatus}' for ${puzzle.id}, skipping`
					);
					return;
				}

				// Before reaping, verify the authoritative DO status. A workflow can
				// report 'errored' after finalize already committed 'ready' to the DO
				// (e.g. the mark-failed step's retry budget exhausted after a successful
				// finalize DO write, or a post-finalize step threw). The DO is the source
				// of truth — if it says 'ready', the puzzle is valid and must NOT be
				// reaped. A stale KV read showing 'processing' is eventual-consistency
				// lag, not an orphan.
				try {
					const authoritativeStatus = await getAuthoritativeStatus(
						env.PUZZLE_METADATA_DO,
						puzzle.id
					);
					if (authoritativeStatus === 'ready') {
						console.warn(
							`Reaper: DO authoritative status is 'ready' for ${puzzle.id} but workflow is dead and KV shows processing; skipping (finalize committed before workflow errored)`
						);
						result.details.push({
							puzzleId: puzzle.id,
							action: 'skip-do-ready'
						});
						return;
					}
					// null = DO has no metadata (truly orphaned) → proceed with reaping.
					// Any other status (processing, failed) → proceed with reaping.
				} catch (doErr) {
					// DO unreachable — fail closed. Reaping a valid puzzle is
					// irreversible (deletes R2 assets); skipping a dead one is
					// recoverable (next reaper run, or operator force-delete).
					console.error(
						`Reaper: DO status check failed for ${puzzle.id}, skipping (fail closed):`,
						doErr
					);
					result.errors++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'do-status-check-failed',
						error: String(doErr)
					});
					return;
				}

				// Tombstone the DO BEFORE deleting R2 assets and KV metadata.
				// The DO tombstone prevents a (dead) workflow's post-termination
				// step from resurrecting stale metadata in KV via the DO's KV
				// sync. Doing this first means a tombstone failure leaves the
				// puzzle fully discoverable for the next reaper run (KV intact,
				// DO live — the reaper re-checks both). Without this ordering, a
				// KV delete with a failed tombstone bricks the retry path: the DO
				// stays live and a later workflow update can repopulate stale
				// metadata.
				try {
					await deleteMetadataDO(env.PUZZLE_METADATA_DO, puzzle.id);
				} catch (doErr) {
					console.error(`Reaper: failed to tombstone metadata DO for ${puzzle.id}:`, doErr);
					result.errors++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'do-tombstone-failed',
						error: String(doErr)
					});
					return;
				}

				// Delete all R2 assets (original + thumbnail + generated
				// pieces). Uses pieceCount from metadata; R2 deletes on non-
				// existent keys are no-ops, so partial generation is covered.
				// CRITICAL: if R2 deletion fails (partially or totally), do NOT
				// delete KV or D1 metadata — the failed R2 keys would become
				// invisible orphans with no metadata to discover them. Preserve
				// KV so the next reaper run retries R2 cleanup. The DO is
				// already tombstoned, so getAuthoritativeStatus returns null on
				// the next run, which means "truly orphaned → proceed."
				try {
					const pieceCount = typeof meta.pieceCount === 'number' ? meta.pieceCount : 0;
					const r2Result = await deletePuzzleAssets(env.PUZZLES_BUCKET, puzzle.id, pieceCount);
					if (!r2Result.success) {
						console.error(
							`Reaper: failed to delete some R2 assets for ${puzzle.id}, preserving KV for retry:`,
							r2Result.failedKeys
						);
						result.errors++;
						result.details.push({
							puzzleId: puzzle.id,
							action: 'r2-delete-partial',
							error: `failed keys: ${r2Result.failedKeys.join(', ')}`
						});
						return;
					}
				} catch (r2Err) {
					// R2 deletion threw — preserve KV for the next reaper run.
					console.error(
						`Reaper: failed to delete R2 assets for ${puzzle.id}, preserving KV for retry:`,
						r2Err
					);
					result.errors++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'r2-delete-failed',
						error: String(r2Err)
					});
					return;
				}

				// R2 deletion fully succeeded — safe to delete KV and D1
				// metadata. deletePuzzleMetadata never throws — it returns
				// { success, error } so a KV failure is observable here
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

					// Best-effort DO idempotency reservation release. Without
					// this, a reaped puzzle leaves its reservation pointing at
					// the dead puzzleId indefinitely — a same-key re-upload
					// would reclaim into a 404 and require a second reap pass.
					// Only puzzles created with an Idempotency-Key header
					// carry meta.idempotencyKey. Best-effort: a DO failure is
					// logged, not fatal — the reservation TTL (if any) and
					// operator force-release are the backstops.
					if (meta.idempotencyKey) {
						try {
							await releaseIdempotencyKey(env.PUZZLE_METADATA_DO, meta.idempotencyKey, puzzle.id);
						} catch (releaseErr) {
							console.error(
								`Reaper: failed to release DO reservation for ${puzzle.id}:`,
								releaseErr
							);
							result.details.push({
								puzzleId: puzzle.id,
								action: 'do-release-failed',
								error: String(releaseErr)
							});
						}
					}

					// Best-effort D1 ownership row cleanup. Player uploads insert
					// a D1 ownership row with status 'processing', which is visible
					// in the uploader's "My Puzzles" list (VISIBLE_PLAYER_PUZZLE_
					// STATUSES includes 'processing'). Without this, a reaped
					// player puzzle keeps surfacing as a card that 404s on click.
					// Gate on KV success: if KV deletion failed, the puzzle still
					// exists in the player list mirror and the next reaper pass can
					// retry KV cleanup.
					try {
						await deletePuzzleOwnership(getWorkerDb(env), puzzle.id).catch((err) =>
							console.error(`Reaper: failed to delete D1 ownership for ${puzzle.id}:`, err)
						);
						// Best-effort cleanup of puzzle_stats rows so a reaped
						// puzzle doesn't linger in players' best-times lists with a
						// null name after the left join. Mirrors the admin delete
						// path, which calls deletePuzzleStats alongside
						// deletePuzzleOwnership. Logged, not fatal.
						await deletePuzzleStats(getWorkerDb(env), puzzle.id).catch((err) =>
							console.error(`Reaper: failed to delete D1 stats for ${puzzle.id}:`, err)
						);
					} catch (dbErr) {
						console.error(
							`Reaper: failed to init DB for ownership cleanup of ${puzzle.id}:`,
							dbErr
						);
					}
				} else {
					console.error(`Reaper: failed to delete KV metadata for ${puzzle.id}:`, kvResult.error);
					result.errors++;
					result.details.push({
						puzzleId: puzzle.id,
						action: 'kv-delete-failed',
						error: String(kvResult.error)
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

	// Advance the cursor by the page size regardless of individual success.
	await writeReaperCursor(
		env.PUZZLE_METADATA,
		'stuck-puzzles',
		(cursor + batch.length) % stuck.length
	);

	return result;
}

/**
 * Process explicit cleanup records left by the admin route when it could not
 * confirm workflow termination within the bounded timeout. These records
 * ensure that puzzles deferred to the reaper are eventually cleaned up even
 * if the workflow completes after the deferral (finalize wrote 'ready' to
 * the DO, then the D1 mirror step finishes and the workflow becomes
 * 'complete'). Without this, the reaper's stuck-processing scan would never
 * select such puzzles (they're no longer 'processing' in KV) and would skip
 * 'complete' workflows.
 *
 * The DO tombstone is confirmed (or performed) here before deleting R2/KV
 * assets. The admin route attempts to tombstone the DO before writing the
 * cleanup record, but that tombstone can fail (DO unreachable, transient
 * error). If this function skipped the tombstone — assuming it was already
 * done — a failed initial tombstone would leave the DO alive after the
 * reaper deletes R2 and KV, creating a metadata-resurrection path if
 * anything later updates that DO. deleteMetadataDO is idempotent (calling
 * /delete on an already-tombstoned DO is a 200 no-op), so re-tombstoning
 * is always safe. The cleanup record itself is deleted only after
 * tombstone, R2, and KV cleanup all succeed.
 */
export async function reapCleanupRecords(env: Env): Promise<ReapResult> {
	const result: ReapResult = {
		scanned: 0,
		candidates: 0,
		reaped: 0,
		errors: 0,
		details: []
	};

	const records = await listCleanupRecords(env.PUZZLE_METADATA);
	result.scanned = records.length;
	result.candidates = records.length;

	if (records.length === 0) {
		return result;
	}

	const cursor = await readReaperCursor(env.PUZZLE_METADATA, 'cleanup-records');
	const batch = rotateSlice(records, cursor, REAP_BATCH_LIMIT);

	await Promise.all(
		batch.map(async (record) => {
			try {
				// Check if the workflow has stopped. Unlike the stuck-
				// processing reaper, we DO clean up 'complete' workflows
				// here — the cleanup record proves the puzzle lost its
				// idempotency reservation (reclaimed by a retry), so the
				// completed puzzle is a duplicate that must be removed.
				let workflowStatus: string;
				try {
					const instance = await env.PUZZLE_WORKFLOW.get(record.puzzleId);
					workflowStatus = (await instance.status()).status;
				} catch (wfErr) {
					if (isWorkflowNotFoundError(wfErr)) {
						// Instance never created or already deleted — safe
						// to clean up.
						workflowStatus = 'errored';
					} else {
						console.error(
							`Reaper cleanup: workflow status check failed for ${record.puzzleId}, skipping:`,
							wfErr
						);
						result.errors++;
						result.details.push({
							puzzleId: record.puzzleId,
							action: 'cleanup-skip',
							error: 'workflow status check failed'
						});
						return;
					}
				}

				// Only clean up if the workflow has stopped (dead or
				// complete). Unlike the stuck-processing reaper, we DO
				// clean up 'complete' workflows here — the cleanup record
				// proves the puzzle lost its idempotency reservation
				// (reclaimed by a retry), so the completed puzzle is a
				// duplicate that must be removed. Note: 'complete' is in
				// ACTIVE_WORKFLOW_STATUSES (it means success), so we check
				// it BEFORE the alive check.
				if (workflowStatus === 'complete' || isDeadWorkflowStatus(workflowStatus)) {
					// Workflow has stopped — proceed with cleanup below.
				} else if (isAliveWorkflowStatus(workflowStatus)) {
					// Workflow is still running — skip and retry next run.
					return;
				} else {
					// 'unknown' or unrecognized — skip to be safe.
					console.warn(
						`Reaper cleanup: workflow status '${workflowStatus}' for ${record.puzzleId} is not confirmed stopped, skipping`
					);
					return;
				}

				// Tombstone the DO BEFORE deleting R2 assets and KV metadata.
				// The admin route attempts this before writing the cleanup
				// record, but that attempt can fail. deleteMetadataDO is
				// idempotent (a no-op on an already-tombstoned DO), so calling
				// it here is always safe — it either confirms the prior
				// tombstone or performs it for the first time. If it fails, do
				// NOT delete R2/KV — a live DO can resurrect stale metadata via
				// KV sync after R2/KV cleanup. Preserve the cleanup record for
				// the next reaper run.
				try {
					await deleteMetadataDO(env.PUZZLE_METADATA_DO, record.puzzleId);
				} catch (doErr) {
					console.error(
						`Reaper cleanup: failed to tombstone metadata DO for ${record.puzzleId}:`,
						doErr
					);
					result.errors++;
					result.details.push({
						puzzleId: record.puzzleId,
						action: 'cleanup-do-tombstone-failed',
						error: String(doErr)
					});
					return;
				}

				// DO tombstoned — safe to delete R2 assets.
				try {
					const r2Result = await deletePuzzleAssets(
						env.PUZZLES_BUCKET,
						record.puzzleId,
						record.pieceCount
					);
					if (!r2Result.success) {
						console.error(
							`Reaper cleanup: failed to delete some R2 assets for ${record.puzzleId}, preserving KV for retry:`,
							r2Result.failedKeys
						);
						result.errors++;
						result.details.push({
							puzzleId: record.puzzleId,
							action: 'cleanup-r2-delete-partial',
							error: `failed keys: ${r2Result.failedKeys.join(', ')}`
						});
						return;
					}
				} catch (r2Err) {
					console.error(
						`Reaper cleanup: failed to delete R2 assets for ${record.puzzleId}, preserving KV for retry:`,
						r2Err
					);
					result.errors++;
					result.details.push({
						puzzleId: record.puzzleId,
						action: 'cleanup-r2-delete-failed',
						error: String(r2Err)
					});
					return;
				}

				// R2 deletion succeeded — delete KV metadata and D1.
				const kvResult = await deletePuzzleMetadata(env.PUZZLE_METADATA, record.puzzleId);
				if (kvResult.success) {
					result.reaped++;
					result.details.push({
						puzzleId: record.puzzleId,
						action: 'cleanup-reaped'
					});

					// Best-effort idempotency reservation release.
					if (record.idempotencyKey) {
						try {
							await releaseIdempotencyKey(
								env.PUZZLE_METADATA_DO,
								record.idempotencyKey,
								record.puzzleId
							);
						} catch (releaseErr) {
							console.error(
								`Reaper cleanup: failed to release DO reservation for ${record.puzzleId}:`,
								releaseErr
							);
						}
					}

					// Best-effort D1 ownership cleanup.
					try {
						await deletePuzzleOwnership(getWorkerDb(env), record.puzzleId).catch((err) =>
							console.error(
								`Reaper cleanup: failed to delete D1 ownership for ${record.puzzleId}:`,
								err
							)
						);
						// Best-effort cleanup of puzzle_stats rows (see reapStuck-
						// Puzzles for rationale). Mirrors the admin delete path.
						await deletePuzzleStats(getWorkerDb(env), record.puzzleId).catch((err) =>
							console.error(
								`Reaper cleanup: failed to delete D1 stats for ${record.puzzleId}:`,
								err
							)
						);
					} catch (dbErr) {
						console.error(
							`Reaper cleanup: failed to init DB for ownership cleanup of ${record.puzzleId}:`,
							dbErr
						);
					}

					// Delete the cleanup record itself.
					try {
						await deleteCleanupRecord(env.PUZZLE_METADATA, record.puzzleId);
					} catch (cleanupErr) {
						console.error(
							`Reaper cleanup: failed to delete cleanup record for ${record.puzzleId}:`,
							cleanupErr
						);
					}
				} else {
					console.error(
						`Reaper cleanup: failed to delete KV metadata for ${record.puzzleId}:`,
						kvResult.error
					);
					result.errors++;
					result.details.push({
						puzzleId: record.puzzleId,
						action: 'cleanup-kv-delete-failed',
						error: String(kvResult.error)
					});
				}
			} catch (err) {
				console.error(`Reaper cleanup: unexpected error for ${record.puzzleId}:`, err);
				result.errors++;
				result.details.push({
					puzzleId: record.puzzleId,
					action: 'cleanup-error',
					error: String(err)
				});
			}
		})
	);

	await writeReaperCursor(
		env.PUZZLE_METADATA,
		'cleanup-records',
		(cursor + batch.length) % records.length
	);

	return result;
}

/**
 * Reap puzzles whose idempotency key was reclaimed by a retry — the durable
 * orphan signal that closes the gap left by a failed `writeCleanupRecord`.
 *
 * The gap: when the admin route's commit conflicts (a retry reclaimed the
 * reservation and minted a replacement puzzleId), it calls
 * `cleanupOrphanedWorkflow`, which writes a cleanup record BEFORE any
 * destructive work. If that KV write fails, the helper aborts without
 * terminating the workflow, tombstoning the DO, or cleaning assets, and
 * returns a 500 telling the client to retry. That retry follows the
 * replacement's reservation (not the orphan), so the orphan is never
 * rediscovered by a client. If the orphaned workflow then completes:
 *   - Its metadata becomes 'ready', so the stuck-processing reaper never
 *     selects it (it scans only 'processing' puzzles and explicitly skips
 *     'complete' workflows and DO-ready puzzles).
 *   - The cleanup-record reaper cannot see it (the record write failed).
 * The result is a permanently accessible duplicate ready puzzle + R2 assets.
 *
 * This scan closes that gap with a read-only ownership check. For every
 * puzzle whose KV metadata carries an `idempotencyKey`, it asks the
 * reservation DO (keyed by idFromName(idempotencyKey)) which puzzleId the
 * key currently maps to. If the current owner differs from this puzzle's
 * id, the puzzle lost its reservation to a retry and is a durable orphan
 * — regardless of whether a cleanup record exists or the workflow
 * completed. A null reservation (no record) is NOT treated as an orphan:
 * the absence of a record is a weak signal that can result from DO state
 * loss, a release that followed KV deletion (the codebase's normal
 * deletion ordering), or an operational action. Reaping on null alone
 * risks destroying a healthy completed puzzle whose reservation record is
 * simply absent — an irreversible mistake. Instead, null reservations
 * are skipped and logged with a distinct action so operators can review
 * and force-delete true orphans via the runbook. A reservation ownership
 * mismatch (the key now points at a different puzzleId) remains
 * sufficient evidence by itself — that is a durable, positive orphan
 * signal.
 *
 * Ownership mismatches are determined BEFORE applying REAP_BATCH_LIMIT.
 * The source catalog is sorted newest-first (listPuzzles), so batching
 * before the mismatch check would select the same newest N candidates
 * every run and permanently starve older orphans behind newer healthy
 * owners.
 *
 * Puzzles created without an `Idempotency-Key` header have no
 * `meta.idempotencyKey` and are skipped (no key to check).
 */
export async function reapOrphanedReservations(env: Env): Promise<ReapResult> {
	const result: ReapResult = {
		scanned: 0,
		candidates: 0,
		reaped: 0,
		errors: 0,
		details: []
	};

	const { puzzles } = await listPuzzles(env.PUZZLE_METADATA);
	result.scanned = puzzles.length;

	// listPuzzles returns summaries without idempotencyKey; re-read full
	// metadata to obtain it. Only puzzles created with an Idempotency-Key
	// header carry meta.idempotencyKey — the rest are skipped (no key to
	// reconcile). Reuse the same full-catalog scan the stuck-processing
	// reaper performs; the scale TODO at reapStuckPuzzles applies here too.
	const candidates: Array<{ id: string; pieceCount: number; idempotencyKey: string }> = [];
	// Read full metadata concurrently in bounded chunks to avoid exceeding
	// Worker subrequest/CPU budgets while preserving input-order candidate
	// collection (chunks processed sequentially; Promise.all preserves order
	// within each chunk). Per-puzzle error accounting/details are preserved.
	const META_CHUNK_SIZE = 10;
	for (let i = 0; i < puzzles.length; i += META_CHUNK_SIZE) {
		const chunk = puzzles.slice(i, i + META_CHUNK_SIZE);
		const metas = await Promise.all(
			chunk.map(async (puzzle) => {
				try {
					const meta = await getPuzzle(env.PUZZLE_METADATA, puzzle.id);
					return { puzzle, meta };
				} catch (err) {
					return { puzzle, err };
				}
			})
		);
		for (const entry of metas) {
			if ('err' in entry) {
				console.error(
					`Reaper orphan: failed to read metadata for ${entry.puzzle.id}, skipping:`,
					entry.err
				);
				result.errors++;
				result.details.push({
					puzzleId: entry.puzzle.id,
					action: 'orphan-meta-read-failed',
					error: String(entry.err)
				});
				continue;
			}
			const { puzzle, meta } = entry;
			if (meta && typeof meta.idempotencyKey === 'string' && meta.idempotencyKey) {
				candidates.push({
					id: puzzle.id,
					pieceCount: typeof meta.pieceCount === 'number' ? meta.pieceCount : 0,
					idempotencyKey: meta.idempotencyKey
				});
			}
		}
	}
	result.candidates = candidates.length;

	if (candidates.length === 0) {
		return result;
	}

	// Determine ownership mismatches BEFORE applying REAP_BATCH_LIMIT. The
	// source catalog is sorted newest-first (listPuzzles), so batching before
	// the mismatch check would select the same newest N candidates every run
	// and permanently starve older orphans behind newer healthy owners.
	// Querying every candidate's reservation DO is the dominant cost as the
	// catalog grows, but the full-catalog scan TODO at reapStuckPuzzles
	// applies here too; a persisted cursor or rotating page is the scale fix.
	//
	// Mismatches are collected in deterministic input (catalog) order via
	// Promise.all's positional result array, NOT in asynchronous completion
	// order. Async-order collection (pushing into a shared array as each DO
	// call resolves) lets a fast subset that repeatedly fails cleanup occupy
	// the first REAP_BATCH_LIMIT slots on every run while slower mismatches
	// remain unprocessed — starving them behind the same noisy candidates.
	// Input-order collection rotates which mismatches land in the batch as
	// earlier ones are reaped and drop out of the catalog.
	const mismatches = (
		await Promise.all(
			candidates.map(async (candidate) => {
				try {
					const reservation = await getIdempotencyReservation(
						env.PUZZLE_METADATA_DO,
						candidate.idempotencyKey
					);
					if (reservation === null) {
						// No reservation record. This is NOT treated as an
						// orphan signal: the absence of a record can result
						// from DO state loss, a release that followed KV
						// deletion (the codebase's normal deletion ordering),
						// or an operational action. Reaping on null alone
						// risks destroying a healthy completed puzzle whose
						// reservation record is simply absent — an
						// irreversible mistake. Skip and log a distinct
						// action so operators can review and force-delete
						// true orphans via the runbook. A positive ownership
						// mismatch (below) remains sufficient evidence.
						console.warn(
							`Reaper orphan: no reservation record for ${candidate.id} (key ${candidate.idempotencyKey}); skipping — verify and force-delete if orphaned`
						);
						result.details.push({
							puzzleId: candidate.id,
							action: 'skip-null-reservation'
						});
						return null;
					}
					if (reservation.puzzleId === candidate.id) {
						// This puzzle IS the current reservation owner — not an orphan.
						return null;
					}

					// Ownership mismatch: the idempotency key now belongs to a
					// different puzzleId. This puzzle lost its reservation (reclaimed
					// by a retry that minted a replacement) and is a durable orphan.
					// This catches the gap where writeCleanupRecord failed AND the
					// workflow later completed — neither the stuck-processing reaper
					// (skips 'complete'/'ready') nor the cleanup-record reaper (no
					// record) would otherwise reach it.
					return candidate;
				} catch (err) {
					console.error(
						`Reaper orphan: reservation check failed for ${candidate.id}, skipping:`,
						err
					);
					result.errors++;
					result.details.push({
						puzzleId: candidate.id,
						action: 'orphan-reservation-check-failed',
						error: String(err)
					});
					return null;
				}
			})
		)
	).filter((c): c is { id: string; pieceCount: number; idempotencyKey: string } => c !== null);

	if (mismatches.length === 0) {
		return result;
	}

	// Process a rotating page starting at the persisted cursor. The
	// deterministic input-order collection above ensures the candidate list
	// is stable across runs (modulo reaped items dropping out), and the
	// advancing cursor ensures persistently-failing mismatches don't starve
	// later ones — the gap left by the old `slice(0, REAP_BATCH_LIMIT)`.
	const cursor = await readReaperCursor(env.PUZZLE_METADATA, 'orphaned-reservations');
	const batch = rotateSlice(mismatches, cursor, REAP_BATCH_LIMIT);

	await Promise.all(
		batch.map(async (candidate) => {
			try {
				// Check the workflow has stopped before deleting R2 assets. A
				// live workflow writes thumbnails and pieces directly to R2, so
				// deleting assets before it stops leaves orphaned R2 objects the
				// reaper cannot find (KV metadata already deleted). Mirrors the
				// cleanup-record reaper's gating.
				let workflowStatus: string;
				try {
					const instance = await env.PUZZLE_WORKFLOW.get(candidate.id);
					workflowStatus = (await instance.status()).status;
				} catch (wfErr) {
					if (isWorkflowNotFoundError(wfErr)) {
						workflowStatus = 'errored';
					} else {
						console.error(
							`Reaper orphan: workflow status check failed for ${candidate.id}, skipping:`,
							wfErr
						);
						result.errors++;
						result.details.push({
							puzzleId: candidate.id,
							action: 'orphan-skip',
							error: 'workflow status check failed'
						});
						return;
					}
				}

				if (workflowStatus === 'complete' || isDeadWorkflowStatus(workflowStatus)) {
					// Workflow has stopped — proceed with cleanup below.
				} else if (isAliveWorkflowStatus(workflowStatus)) {
					// Workflow is still running — skip and retry next run.
					return;
				} else {
					console.warn(
						`Reaper orphan: workflow status '${workflowStatus}' for ${candidate.id} is not confirmed stopped, skipping`
					);
					return;
				}

				// Tombstone the DO BEFORE deleting R2/KV — prevents a (dead)
				// workflow's post-termination step from resurrecting stale
				// metadata in KV via the DO's KV sync. Idempotent (no-op on an
				// already-tombstoned DO). On failure, preserve KV and defer to
				// the next run.
				try {
					await deleteMetadataDO(env.PUZZLE_METADATA_DO, candidate.id);
				} catch (doErr) {
					console.error(
						`Reaper orphan: failed to tombstone metadata DO for ${candidate.id}:`,
						doErr
					);
					result.errors++;
					result.details.push({
						puzzleId: candidate.id,
						action: 'orphan-do-tombstone-failed',
						error: String(doErr)
					});
					return;
				}

				// Delete R2 assets. On partial/total failure, preserve KV so the
				// next reaper run retries R2 cleanup (failed R2 keys with no KV
				// are invisible orphans).
				try {
					const r2Result = await deletePuzzleAssets(
						env.PUZZLES_BUCKET,
						candidate.id,
						candidate.pieceCount
					);
					if (!r2Result.success) {
						console.error(
							`Reaper orphan: failed to delete some R2 assets for ${candidate.id}, preserving KV for retry:`,
							r2Result.failedKeys
						);
						result.errors++;
						result.details.push({
							puzzleId: candidate.id,
							action: 'orphan-r2-delete-partial',
							error: `failed keys: ${r2Result.failedKeys.join(', ')}`
						});
						return;
					}
				} catch (r2Err) {
					console.error(
						`Reaper orphan: failed to delete R2 assets for ${candidate.id}, preserving KV for retry:`,
						r2Err
					);
					result.errors++;
					result.details.push({
						puzzleId: candidate.id,
						action: 'orphan-r2-delete-failed',
						error: String(r2Err)
					});
					return;
				}

				// R2 deletion succeeded — delete KV metadata.
				const kvResult = await deletePuzzleMetadata(env.PUZZLE_METADATA, candidate.id);
				if (!kvResult.success) {
					console.error(
						`Reaper orphan: failed to delete KV metadata for ${candidate.id}:`,
						kvResult.error
					);
					result.errors++;
					result.details.push({
						puzzleId: candidate.id,
						action: 'orphan-kv-delete-failed',
						error: String(kvResult.error)
					});
					return;
				}

				result.reaped++;
				result.details.push({
					puzzleId: candidate.id,
					action: 'orphan-reaped'
				});

				// Best-effort idempotency reservation release. The mismatch
				// already proves the key belongs to a different puzzleId, so
				// this release targets (key, orphanId) — a 404 (owner mismatch)
				// is expected and harmless. Logged, not fatal.
				try {
					await releaseIdempotencyKey(
						env.PUZZLE_METADATA_DO,
						candidate.idempotencyKey,
						candidate.id
					);
				} catch (releaseErr) {
					console.error(
						`Reaper orphan: failed to release DO reservation for ${candidate.id}:`,
						releaseErr
					);
				}

				// Best-effort D1 ownership cleanup so a reaped orphan doesn't
				// keep surfacing in the uploader's "My Puzzles" list as a 404.
				try {
					await deletePuzzleOwnership(getWorkerDb(env), candidate.id).catch((err) =>
						console.error(`Reaper orphan: failed to delete D1 ownership for ${candidate.id}:`, err)
					);
					// Best-effort cleanup of puzzle_stats rows (see reapStuck-
					// Puzzles for rationale). Mirrors the admin delete path.
					await deletePuzzleStats(getWorkerDb(env), candidate.id).catch((err) =>
						console.error(`Reaper orphan: failed to delete D1 stats for ${candidate.id}:`, err)
					);
				} catch (dbErr) {
					console.error(
						`Reaper orphan: failed to init DB for ownership cleanup of ${candidate.id}:`,
						dbErr
					);
				}
			} catch (err) {
				console.error(`Reaper orphan: unexpected error for ${candidate.id}:`, err);
				result.errors++;
				result.details.push({
					puzzleId: candidate.id,
					action: 'orphan-error',
					error: String(err)
				});
			}
		})
	);

	await writeReaperCursor(
		env.PUZZLE_METADATA,
		'orphaned-reservations',
		(cursor + batch.length) % mismatches.length
	);

	return result;
}

/**
 * Garbage-collect orphaned versioned avatar R2 objects.
 *
 * The avatar upload route (player.worker.ts POST /avatar) writes each upload
 * to a unique versioned key `avatars/{playerId}/{token}` and uses D1's
 * avatarUpdateToken to select which version is served. A read-after-write
 * cleanup deletes the superseded object, but concurrent overlapping uploads
 * can still orphan a loser's object — the authority check is a TOCTOU window
 * that a future overlapping write can invalidate, and first-time concurrent
 * uploads (both read null) skip cleanup entirely.
 *
 * This reaper closes that gap with delayed GC: it lists versioned avatar
 * objects in R2 (bounded to AVATAR_GC_MAX_PAGES per run, resuming from a
 * persisted R2 list cursor), batch-queries D1 for each player's
 * authoritative token, and deletes any versioned object whose token is
 * not authoritative AND whose age exceeds AVATAR_GC_AGE_MS. The age
 * threshold ensures in-flight uploads have completed before their objects
 * are considered garbage.
 *
 * The legacy unversioned key `avatars/{playerId}` (pre-migration fallback) is
 * never deleted — it serves as the D1-unavailable fallback in the serve route.
 *
 * If D1 is unavailable, the reaper skips all players (fail closed) rather than
 * deleting objects it cannot verify. R2 deletes are idempotent, so concurrent
 * runs or runs overlapping with an upload are safe.
 *
 * Bounded listing: the R2 list cursor is persisted in KV between runs so the
 * scan resumes where it left off. When a scan reaches the end of the prefix
 * (page.truncated === false), the cursor is cleared so the next run starts a
 * fresh sweep. This bounds list calls and memory per run regardless of bucket
 * size; the tradeoff is that a full sweep takes multiple scheduled runs.
 */
export async function reapOrphanedAvatars(env: Env, now = Date.now()): Promise<ReapResult> {
	const result: ReapResult = {
		scanned: 0,
		candidates: 0,
		reaped: 0,
		errors: 0,
		details: []
	};

	// List objects under the avatars/ prefix, bounded to AVATAR_GC_MAX_PAGES
	// per run. The R2 list cursor is persisted between runs so the scan
	// resumes where it left off — without it, one run would list the entire
	// prefix before deleting anything, accumulating excessive R2 list calls
	// and memory as the bucket grows.
	const R2_CURSOR_NAME = 'orphaned-avatars-r2';
	const allObjects: Array<{ key: string; uploaded: Date }> = [];
	let listCursor = await readReaperStringCursor(env.PUZZLE_METADATA, R2_CURSOR_NAME);
	let pagesListed = 0;
	let listComplete = false;
	while (pagesListed < AVATAR_GC_MAX_PAGES) {
		const page = await env.PUZZLES_BUCKET.list({ prefix: 'avatars/', cursor: listCursor });
		for (const obj of page.objects) {
			allObjects.push({ key: obj.key, uploaded: obj.uploaded });
		}
		pagesListed++;
		if (!page.truncated) {
			listComplete = true;
			break;
		}
		listCursor = page.cursor;
	}
	// Persist the cursor for the next run. If the listing completed, clear
	// the cursor so the next run starts a fresh sweep from the beginning.
	await writeReaperStringCursor(
		env.PUZZLE_METADATA,
		R2_CURSOR_NAME,
		listComplete ? undefined : listCursor
	);
	result.scanned = allObjects.length;

	// Parse keys into versioned (avatars/{playerId}/{token}) and legacy
	// (avatars/{playerId}). Only versioned objects with a token are GC
	// candidates; legacy keys are never deleted (D1-unavailable fallback).
	interface VersionedAvatar {
		key: string;
		playerId: string;
		token: string;
		uploaded: Date;
	}
	const versioned: VersionedAvatar[] = [];
	for (const obj of allObjects) {
		const parts = obj.key.split('/');
		// Expected: ['avatars', playerId, token]
		if (parts.length !== 3 || !parts[1] || !parts[2]) continue;
		versioned.push({
			key: obj.key,
			playerId: parts[1],
			token: parts[2],
			uploaded: obj.uploaded
		});
	}

	if (versioned.length === 0) {
		return result;
	}

	// Batch-query D1 for the authoritative avatarUpdateToken of every player
	// that has versioned objects. Fail closed: if D1 is unavailable, skip all
	// deletion — we cannot determine which objects are orphaned without the
	// authoritative token. The age threshold means a future run will catch
	// them once D1 recovers.
	const playerIds = [...new Set(versioned.map((v) => v.playerId))];
	let tokensByPlayer: Map<string, string | null>;
	try {
		const db = getWorkerDb(env);
		tokensByPlayer = await getAvatarTokensByPlayerIds(db, playerIds);
	} catch (dbErr) {
		console.error('Reaper avatar GC: D1 unavailable, skipping all deletion:', dbErr);
		result.errors++;
		result.details.push({
			puzzleId: '*',
			action: 'avatar-gc-d1-unavailable',
			error: String(dbErr)
		});
		return result;
	}

	// Select orphaned objects: token != authoritative AND age > threshold.
	// A player with no D1 row (tokensByPlayer has no entry) has no
	// authoritative token — all their versioned objects are orphans (the
	// profile override was deleted or never created). Safe to delete after
	// the age threshold.
	const orphans = versioned.filter((v) => {
		const authoritative = tokensByPlayer.get(v.playerId) ?? null;
		if (v.token === authoritative) return false; // still the served version
		const ageMs = now - v.uploaded.getTime();
		return ageMs > AVATAR_GC_AGE_MS;
	});
	result.candidates = orphans.length;

	if (orphans.length === 0) {
		return result;
	}

	// Process a rotating page starting at the persisted cursor. The cursor
	// advances by the page size regardless of individual R2 delete success,
	// so persistently-failing objects (e.g. a corrupted key that always
	// errors) don't starve later orphans behind the same prefix.
	const cursor = await readReaperCursor(env.PUZZLE_METADATA, 'orphaned-avatars');
	const batch = rotateSlice(orphans, cursor, AVATAR_GC_BATCH_LIMIT);

	await Promise.all(
		batch.map(async (obj) => {
			try {
				await env.PUZZLES_BUCKET.delete(obj.key);
				result.reaped++;
				result.details.push({
					puzzleId: obj.playerId,
					action: 'avatar-gc-reaped'
				});
			} catch (r2Err) {
				console.error(`Reaper avatar GC: failed to delete ${obj.key}:`, r2Err);
				result.errors++;
				result.details.push({
					puzzleId: obj.playerId,
					action: 'avatar-gc-delete-failed',
					error: String(r2Err)
				});
			}
		})
	);

	await writeReaperCursor(
		env.PUZZLE_METADATA,
		'orphaned-avatars',
		(cursor + batch.length) % orphans.length
	);

	return result;
}
