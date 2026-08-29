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
// hatch (see the perseus-operations skill's operator runbook).

import {
	getAuthoritativeStatus,
	getIdempotencyReservation,
	getFamily,
	listFamilies,
	listCleanupRecords,
	listLegacyCleanupRecords,
	deleteLegacyPuzzleAssets,
	deleteCleanupRecord,
	deleteMetadataDO,
	releaseIdempotencyKey,
	buildCleanupRecordFromFamily
} from './storage.worker';
import { getWorkerDb } from '../db.worker';
import {
	getAvatarTokensByPlayerIds,
	isAliveWorkflowStatus,
	isDeadWorkflowStatus,
	isWorkflowNotFoundError
} from '@perseus/shared';
import type { Env } from '../worker';
import type { PuzzleFamilyMetadata } from '@perseus/types';
import {
	ensureWorkerPuzzleDeletionFence,
	executeFamilySourceDeletion
} from './puzzle-deletion.worker';

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

/**
 * Limit the number of avatar objects listed (and thus deleted) per scheduled
 * run. Acts as the `limit` on the single R2 list call per run: every
 * eligible orphan in the listed page is processed before the R2 cursor
 * advances, so this bound guarantees no orphan is starved behind a separate
 * progression mechanism. The tradeoff is that a full sweep takes more
 * scheduled runs as the bucket grows.
 */
export const AVATAR_GC_BATCH_LIMIT = 200;

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
 * Scan KV for stuck "processing" families and clean up those whose workflows
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

	// TODO(scale): listFamilies scans the entire KV catalog on every run. This
	// is fine while family counts are small, but becomes the dominant cost as
	// the catalog grows. When this scan shows up in tail-CPU profiles, add a
	// `processing:<familyId>` KV index written at create time and deleted on
	// finalize/fail, so the reaper can list only in-flight families via a KV
	// prefix scan instead of the full catalog. The index is advisory (KV is
	// eventually consistent) — the workflow-status check below remains the
	// authoritative liveness signal, so a stale/missing index entry only
	// causes a skipped reap, never a wrong reap.
	const { families } = await listFamilies(env.PUZZLE_METADATA);
	result.scanned = families.length;

	const stuck = families.filter(
		(f) =>
			f.status === 'processing' &&
			typeof f.createdAt === 'number' &&
			now - f.createdAt > REAP_AFTER_MS
	);
	result.candidates = stuck.length;

	if (stuck.length === 0) {
		return result;
	}

	const cursor = await readReaperCursor(env.PUZZLE_METADATA, 'stuck-puzzles');
	const batch = rotateSlice(stuck, cursor, REAP_BATCH_LIMIT);

	await Promise.all(
		batch.map(async (familySummary) => {
			const familyId = familySummary.id;
			try {
				const family = await getFamily(env.PUZZLE_METADATA, familyId);
				if (!family || family.status !== 'processing') {
					return;
				}

				let workflowStatus: string;
				try {
					const instance = await env.PUZZLE_WORKFLOW.get(familyId);
					workflowStatus = (await instance.status()).status;
				} catch (wfErr) {
					if (isWorkflowNotFoundError(wfErr)) {
						workflowStatus = 'errored';
					} else {
						console.error(`Reaper: workflow status check failed for ${familyId}, skipping:`, wfErr);
						result.errors++;
						result.details.push({
							puzzleId: familyId,
							action: 'skip',
							error: 'workflow status check failed'
						});
						return;
					}
				}

				if (workflowStatus === 'complete') {
					console.warn(
						`Reaper: workflow for ${familyId} is complete but KV still shows processing (lag); skipping`
					);
					result.details.push({
						puzzleId: familyId,
						action: 'skip-complete-kv-lag'
					});
					return;
				}

				if (isAliveWorkflowStatus(workflowStatus)) {
					return;
				}

				if (!isDeadWorkflowStatus(workflowStatus)) {
					console.warn(
						`Reaper: unrecognized or unverifiable workflow status '${workflowStatus}' for ${familyId}, skipping`
					);
					return;
				}

				try {
					const authoritativeStatus = await getAuthoritativeStatus(
						env.PUZZLE_METADATA_DO,
						familyId
					);
					if (authoritativeStatus === 'ready') {
						console.warn(
							`Reaper: DO authoritative status is 'ready' for ${familyId} but workflow is dead and KV shows processing; skipping (finalize committed before workflow errored)`
						);
						result.details.push({
							puzzleId: familyId,
							action: 'skip-do-ready'
						});
						return;
					}
				} catch (doErr) {
					console.error(
						`Reaper: DO status check failed for ${familyId}, skipping (fail closed):`,
						doErr
					);
					result.errors++;
					result.details.push({
						puzzleId: familyId,
						action: 'do-status-check-failed',
						error: String(doErr)
					});
					return;
				}

				const record = buildCleanupRecordFromFamily(family);
				await ensureWorkerPuzzleDeletionFence(env, record);

				const deletion = await executeFamilySourceDeletion(env, record, async () => {
					if (record.idempotencyKey) {
						await releaseIdempotencyKey(env.PUZZLE_METADATA_DO, record.idempotencyKey, familyId);
					}
				});

				if (!deletion.ok) {
					const action = familyDeletionFailureAction(
						'',
						deletion.step,
						deletion.failedKeys !== undefined && deletion.failedKeys.length > 0
					);
					console.error(
						`Reaper: family cleanup failed for ${familyId} at ${deletion.step}:`,
						deletion
					);
					result.errors++;
					result.details.push({
						puzzleId: familyId,
						action,
						error: deletion.failedKeys
							? `failed keys: ${deletion.failedKeys.join(', ')}`
							: String(deletion.error ?? deletion.step)
					});
					return;
				}

				result.reaped++;
				result.details.push({
					puzzleId: familyId,
					action: 'reaped'
				});
			} catch (err) {
				console.error(`Reaper: unexpected error for ${familyId}:`, err);
				result.errors++;
				result.details.push({
					puzzleId: familyId,
					action: 'error',
					error: String(err)
				});
			}
		})
	);

	await writeReaperCursor(
		env.PUZZLE_METADATA,
		'stuck-puzzles',
		(cursor + batch.length) % stuck.length
	);

	return result;
}

/** Map a family-deletion step failure to a reaper detail action, prefixed by
 * the reap path ('', 'orphan-', 'cleanup-') so detail rows stay attributable
 * to the scan that produced them. */
function familyDeletionFailureAction(prefix: string, step: string, hasFailedKeys: boolean): string {
	if (step === 'do-tombstone') return `${prefix}do-tombstone-failed`;
	if (step === 'r2')
		return hasFailedKeys ? `${prefix}r2-delete-partial` : `${prefix}r2-delete-failed`;
	if (step === 'kv-family' || step === 'kv-variant') return `${prefix}kv-delete-failed`;
	if (step === 'release') return `${prefix}do-release-failed`;
	return `${prefix}d1-finish-failed`;
}

/**
 * Process explicit cleanup records retained after deletion was chosen. The
 * workflow-liveness gate is read-only with respect to the permanent fence and
 * source state: unconfirmed liveness causes no D1 fence or DO/R2/KV mutation.
 *
 * Once stopped, cleanup re-persists the record before establishing the
 * permanent D1 fence, then mutates DO/R2/KV source state. Completion and
 * ownership cleanup must finish before the cleanup record is deleted. Any
 * required failure retains the record for retry.
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
			const familyId = record.familyId;
			try {
				let workflowStatus: string;
				try {
					const instance = await env.PUZZLE_WORKFLOW.get(familyId);
					workflowStatus = (await instance.status()).status;
				} catch (wfErr) {
					if (isWorkflowNotFoundError(wfErr)) {
						workflowStatus = 'errored';
					} else {
						console.error(
							`Reaper cleanup: workflow status check failed for ${familyId}, skipping:`,
							wfErr
						);
						result.errors++;
						result.details.push({
							puzzleId: familyId,
							action: 'cleanup-skip',
							error: 'workflow status check failed'
						});
						return;
					}
				}

				if (workflowStatus === 'complete' || isDeadWorkflowStatus(workflowStatus)) {
					// Workflow has stopped — proceed with cleanup below.
				} else if (isAliveWorkflowStatus(workflowStatus)) {
					return;
				} else {
					console.warn(
						`Reaper cleanup: workflow status '${workflowStatus}' for ${familyId} is not confirmed stopped, skipping`
					);
					return;
				}

				await ensureWorkerPuzzleDeletionFence(env, record);

				const deletion = await executeFamilySourceDeletion(env, record, async () => {
					if (record.idempotencyKey) {
						await releaseIdempotencyKey(env.PUZZLE_METADATA_DO, record.idempotencyKey, familyId);
					}
				});

				if (!deletion.ok) {
					console.error(
						`Reaper cleanup: family cleanup failed for ${familyId} at ${deletion.step}:`,
						deletion
					);
					result.errors++;
					result.details.push({
						puzzleId: familyId,
						action: familyDeletionFailureAction(
							'cleanup-',
							deletion.step,
							deletion.failedKeys !== undefined && deletion.failedKeys.length > 0
						),
						error: deletion.failedKeys
							? `failed keys: ${deletion.failedKeys.join(', ')}`
							: String(deletion.error ?? deletion.step)
					});
					return;
				}

				result.reaped++;
				result.details.push({
					puzzleId: familyId,
					action: 'cleanup-reaped'
				});
			} catch (err) {
				console.error(`Reaper cleanup: unexpected error for ${familyId}:`, err);
				result.errors++;
				result.details.push({
					puzzleId: familyId,
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
 * Drain legacy cleanup records (pre-family-scoped shape: { puzzleId,
 * pieceCount, idempotencyKey?, createdAt }). These records are silently
 * rejected by isValidCleanupRecord and would never be cleaned up without
 * this drain path. For each legacy record, confirm the workflow has
 * stopped (a legacy record can exist because the old delete path failed
 * to confirm liveness), tombstone the metadata DO, then delete its R2
 * assets (using the old puzzles/{id}/ key prefix), release its
 * idempotency key if present, and delete the KV cleanup record. Any
 * failure — or an alive/unconfirmed workflow — retains the record for a
 * later reaper pass.
 */
export async function reapLegacyCleanupRecords(env: Env): Promise<ReapResult> {
	const result: ReapResult = {
		scanned: 0,
		candidates: 0,
		reaped: 0,
		errors: 0,
		details: []
	};

	const records = await listLegacyCleanupRecords(env.PUZZLE_METADATA);
	result.scanned = records.length;
	result.candidates = records.length;

	if (records.length === 0) {
		return result;
	}

	for (const record of records) {
		const puzzleId = record.puzzleId;
		try {
			// A legacy cleanup record can exist precisely because the old
			// delete path chose deletion but failed to confirm the workflow
			// stopped. If that workflow is still alive it can recreate
			// pieces/metadata after we delete R2, and once the cleanup record
			// is gone there is no durable retry path. Mirror reapCleanupRecords:
			// probe workflow liveness and tombstone the metadata DO before
			// touching R2/KV. Retain the record on any unconfirmed state so a
			// later pass retries.
			let workflowStatus: string;
			try {
				const instance = await env.PUZZLE_WORKFLOW.get(puzzleId);
				workflowStatus = (await instance.status()).status;
			} catch (wfErr) {
				if (isWorkflowNotFoundError(wfErr)) {
					workflowStatus = 'errored';
				} else {
					console.error(
						`Reaper legacy cleanup: workflow status check failed for ${puzzleId}, skipping:`,
						wfErr
					);
					result.errors++;
					result.details.push({
						puzzleId,
						action: 'legacy-cleanup-skip',
						error: 'workflow status check failed'
					});
					continue;
				}
			}

			if (workflowStatus === 'complete' || isDeadWorkflowStatus(workflowStatus)) {
				// Workflow has stopped — proceed with cleanup below.
			} else if (isAliveWorkflowStatus(workflowStatus)) {
				// Workflow still running — retain the record for a later pass.
				continue;
			} else {
				console.warn(
					`Reaper legacy cleanup: workflow status '${workflowStatus}' for ${puzzleId} is not confirmed stopped, skipping`
				);
				continue;
			}

			// Tombstone the metadata DO before deleting R2 so an in-flight
			// workflow cannot resurrect the puzzle in KV via the DO's KV sync.
			// Retain the cleanup record if the tombstone fails so a later pass
			// can retry the whole gated sequence.
			try {
				await deleteMetadataDO(env.PUZZLE_METADATA_DO, puzzleId);
			} catch (doErr) {
				console.error(
					`Reaper legacy cleanup: DO tombstone failed for ${puzzleId}, skipping:`,
					doErr
				);
				result.errors++;
				result.details.push({
					puzzleId,
					action: 'legacy-cleanup-do-tombstone-failed',
					error: String(doErr)
				});
				continue;
			}

			const r2Result = await deleteLegacyPuzzleAssets(
				env.PUZZLES_BUCKET,
				puzzleId,
				record.pieceCount
			);
			if (!r2Result.success) {
				console.error(
					`Reaper legacy cleanup: R2 asset deletion failed for ${puzzleId}:`,
					r2Result.failedKeys
				);
				result.errors++;
				result.details.push({
					puzzleId,
					action: 'legacy-cleanup-r2-failed',
					error: `failed keys: ${r2Result.failedKeys.join(', ')}`
				});
				continue;
			}

			if (record.idempotencyKey) {
				try {
					await releaseIdempotencyKey(env.PUZZLE_METADATA_DO, record.idempotencyKey, puzzleId);
				} catch (releaseErr) {
					console.error(
						`Reaper legacy cleanup: idempotency release failed for ${puzzleId}:`,
						releaseErr
					);
					result.errors++;
					result.details.push({
						puzzleId,
						action: 'legacy-cleanup-release-failed',
						error: String(releaseErr)
					});
					continue;
				}
			}

			await deleteCleanupRecord(env.PUZZLE_METADATA, puzzleId);
			result.reaped++;
			result.details.push({
				puzzleId,
				action: 'legacy-cleanup-reaped'
			});
		} catch (err) {
			console.error(`Reaper legacy cleanup: unexpected error for ${puzzleId}:`, err);
			result.errors++;
			result.details.push({
				puzzleId,
				action: 'legacy-cleanup-error',
				error: String(err)
			});
		}
	}

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

	const { families } = await listFamilies(env.PUZZLE_METADATA);
	result.scanned = families.length;

	const candidates: Array<{ family: PuzzleFamilyMetadata; idempotencyKey: string }> = [];
	const META_CHUNK_SIZE = 10;
	for (let i = 0; i < families.length; i += META_CHUNK_SIZE) {
		const chunk = families.slice(i, i + META_CHUNK_SIZE);
		const metas = await Promise.all(
			chunk.map(async (familySummary) => {
				try {
					const family = await getFamily(env.PUZZLE_METADATA, familySummary.id);
					return { familySummary, family };
				} catch (err) {
					return { familySummary, err };
				}
			})
		);
		for (const entry of metas) {
			if ('err' in entry) {
				console.error(
					`Reaper orphan: failed to read metadata for ${entry.familySummary.id}, skipping:`,
					entry.err
				);
				result.errors++;
				result.details.push({
					puzzleId: entry.familySummary.id,
					action: 'orphan-meta-read-failed',
					error: String(entry.err)
				});
				continue;
			}
			const { family } = entry;
			if (family && typeof family.idempotencyKey === 'string' && family.idempotencyKey) {
				candidates.push({ family, idempotencyKey: family.idempotencyKey });
			}
		}
	}
	result.candidates = candidates.length;

	if (candidates.length === 0) {
		return result;
	}

	const mismatches = (
		await Promise.all(
			candidates.map(async (candidate) => {
				try {
					const reservation = await getIdempotencyReservation(
						env.PUZZLE_METADATA_DO,
						candidate.idempotencyKey
					);
					if (reservation === null) {
						console.warn(
							`Reaper orphan: no reservation record for ${candidate.family.id} (key ${candidate.idempotencyKey}); skipping — verify and force-delete if orphaned`
						);
						result.details.push({
							puzzleId: candidate.family.id,
							action: 'skip-null-reservation'
						});
						return null;
					}
					if (reservation.familyId === candidate.family.id) {
						return null;
					}
					return candidate;
				} catch (err) {
					console.error(
						`Reaper orphan: reservation check failed for ${candidate.family.id}, skipping:`,
						err
					);
					result.errors++;
					result.details.push({
						puzzleId: candidate.family.id,
						action: 'orphan-reservation-check-failed',
						error: String(err)
					});
					return null;
				}
			})
		)
	).filter((c): c is { family: PuzzleFamilyMetadata; idempotencyKey: string } => c !== null);

	if (mismatches.length === 0) {
		return result;
	}

	const cursor = await readReaperCursor(env.PUZZLE_METADATA, 'orphaned-reservations');
	const batch = rotateSlice(mismatches, cursor, REAP_BATCH_LIMIT);

	await Promise.all(
		batch.map(async (candidate) => {
			const familyId = candidate.family.id;
			try {
				let workflowStatus: string;
				try {
					const instance = await env.PUZZLE_WORKFLOW.get(familyId);
					workflowStatus = (await instance.status()).status;
				} catch (wfErr) {
					if (isWorkflowNotFoundError(wfErr)) {
						workflowStatus = 'errored';
					} else {
						console.error(
							`Reaper orphan: workflow status check failed for ${familyId}, skipping:`,
							wfErr
						);
						result.errors++;
						result.details.push({
							puzzleId: familyId,
							action: 'orphan-skip',
							error: 'workflow status check failed'
						});
						return;
					}
				}

				if (workflowStatus === 'complete' || isDeadWorkflowStatus(workflowStatus)) {
					// Workflow has stopped — proceed with cleanup below.
				} else if (isAliveWorkflowStatus(workflowStatus)) {
					return;
				} else {
					console.warn(
						`Reaper orphan: workflow status '${workflowStatus}' for ${familyId} is not confirmed stopped, skipping`
					);
					return;
				}

				const record = buildCleanupRecordFromFamily(candidate.family);
				await ensureWorkerPuzzleDeletionFence(env, record);

				const deletion = await executeFamilySourceDeletion(env, record, async () => {
					await releaseIdempotencyKey(env.PUZZLE_METADATA_DO, candidate.idempotencyKey, familyId);
				});

				if (!deletion.ok) {
					const action = familyDeletionFailureAction(
						'orphan-',
						deletion.step,
						deletion.failedKeys !== undefined && deletion.failedKeys.length > 0
					);
					console.error(`Reaper orphan: family cleanup failed for ${familyId}:`, deletion);
					result.errors++;
					result.details.push({
						puzzleId: familyId,
						action,
						error: deletion.failedKeys
							? `failed keys: ${deletion.failedKeys.join(', ')}`
							: String(deletion.error ?? deletion.step)
					});
					return;
				}

				result.reaped++;
				result.details.push({
					puzzleId: familyId,
					action: 'orphan-reaped'
				});
			} catch (err) {
				console.error(`Reaper orphan: unexpected error for ${familyId}:`, err);
				result.errors++;
				result.details.push({
					puzzleId: familyId,
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
 * This reaper closes that gap with delayed GC: it lists ONE bounded page of
 * versioned avatar objects in R2 per run (limit = AVATAR_GC_BATCH_LIMIT,
 * resuming from a persisted R2 list cursor), batch-queries D1 for each
 * player's authoritative token, and deletes every orphaned object in that
 * page whose age exceeds AVATAR_GC_AGE_MS. The age threshold ensures
 * in-flight uploads have completed before their objects are considered
 * garbage.
 *
 * Single progression mechanism: the R2 list cursor is the ONLY cursor. Every
 * eligible orphan in the listed page is processed before the cursor advances,
 * so no orphan can be starved behind a separate numeric cursor that advances
 * past unprocessed objects (the bug the previous two-cursor design had: it
 * listed up to 10 pages per run but only deleted 200 orphans via a separate
 * numeric cursor, leaving the rest unvisited until the full scan wrapped —
 * and the numeric cursor was then applied to a completely different orphan
 * array). One page per run with `limit: AVATAR_GC_BATCH_LIMIT` bounds list
 * calls, memory, and deletes per run, and guarantees every listed orphan is
 * attempted.
 *
 * The legacy unversioned key `avatars/{playerId}` (pre-migration fallback) is
 * never deleted — it serves as the D1-unavailable fallback in the serve route.
 *
 * If D1 is unavailable, the reaper skips all players (fail closed) rather than
 * deleting objects it cannot verify. R2 deletes are idempotent, so concurrent
 * runs or runs overlapping with an upload are safe.
 *
 * Bounded listing: the R2 list cursor is persisted in KV between runs so the
 * scan resumes where it left off. When a page is not truncated, the cursor is
 * cleared so the next run starts a fresh sweep. This bounds list calls and
 * memory per run regardless of bucket size; the tradeoff is that a full sweep
 * takes multiple scheduled runs.
 *
 * Cursor advancement ordering: the cursor is persisted ONLY after the page
 * has been classified and all deletion attempts have settled. On D1 lookup
 * failure, the current cursor is RETAINED so the next run retries the same
 * page once D1 recovers — without that, a transient D1 outage would skip the
 * entire page until the R2 scan wrapped all the way around, delaying GC of
 * every orphan on the page by a full sweep (potentially unbounded on a
 * continuously growing bucket). After deletion attempts finish, the cursor
 * advances even if individual deletes failed; those failures are retried on
 * the next full sweep without blocking later pages (R2 deletes are
 * idempotent, so re-blocking later pages for a persistently-failing key
 * would re-introduce the starvation gap the single-cursor design closed).
 */
export async function reapOrphanedAvatars(env: Env, now = Date.now()): Promise<ReapResult> {
	const result: ReapResult = {
		scanned: 0,
		candidates: 0,
		reaped: 0,
		errors: 0,
		details: []
	};

	// List ONE bounded page of objects under the avatars/ prefix per run.
	// The R2 list cursor is persisted between runs so the scan resumes where
	// it left off. Bounding the list to AVATAR_GC_BATCH_LIMIT and processing
	// every eligible orphan in that page uses a single progression mechanism
	// — the R2 cursor — so no orphan is starved behind a separate cursor that
	// advances past unprocessed objects.
	const R2_CURSOR_NAME = 'orphaned-avatars-r2';
	const listCursor = await readReaperStringCursor(env.PUZZLE_METADATA, R2_CURSOR_NAME);
	const page = await env.PUZZLES_BUCKET.list({
		prefix: 'avatars/',
		cursor: listCursor,
		limit: AVATAR_GC_BATCH_LIMIT
	});
	const allObjects: Array<{ key: string; uploaded: Date }> = page.objects.map((obj) => ({
		key: obj.key,
		uploaded: obj.uploaded
	}));
	// Compute the next cursor once. The cursor advances ONLY after the
	// page has been successfully classified and all deletion attempts have
	// settled — see the cursor-advancement-ordering note in the doc comment
	// above. On D1 lookup failure, the current cursor is retained so the
	// next run retries this same page once D1 recovers, instead of skipping
	// it until the full R2 scan wraps.
	const nextCursor = page.truncated ? page.cursor : undefined;
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
		// Page processed — no versioned objects to classify. Advance.
		await writeReaperStringCursor(env.PUZZLE_METADATA, R2_CURSOR_NAME, nextCursor);
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
		// D1 unavailable — fail closed (no deletes). Do NOT advance the
		// cursor: retaining the current cursor means the next run retries
		// this same page once D1 recovers, instead of skipping it until the
		// full R2 scan wraps around (which on a large or continuously
		// growing bucket can delay GC of every orphan on this page
		// indefinitely).
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
		// Page processed — no orphans eligible for deletion. Advance.
		await writeReaperStringCursor(env.PUZZLE_METADATA, R2_CURSOR_NAME, nextCursor);
		return result;
	}

	// Process every eligible orphan in this page. There is no separate
	// numeric cursor — the R2 list cursor is the single progression
	// mechanism, so every orphan in a listed page is attempted before the
	// scan advances. This closes the starvation gap the previous two-cursor
	// design had (R2 cursor advancing past unprocessed orphans). The list
	// `limit` already bounds the page size to AVATAR_GC_BATCH_LIMIT, so the
	// delete count per run is bounded by construction.
	await Promise.all(
		orphans.map(async (obj) => {
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

	// Page processed — advance even if individual deletes failed. R2
	// deletes are idempotent, so a persistently-failing key is retried on
	// the next full sweep without blocking later pages (re-blocking would
	// re-introduce the starvation gap the single-cursor design closed).
	await writeReaperStringCursor(env.PUZZLE_METADATA, R2_CURSOR_NAME, nextCursor);

	return result;
}
