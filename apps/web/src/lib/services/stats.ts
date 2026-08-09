// Versioned local statistics for puzzle completions.
//
// The canonical personal best is available only to eligible standard_timed runs
// with known timing. Rotation, assisted, relaxed, and legacy-unknown runs count
// toward totalCompletions but never create or overwrite the standard best.

import type { SealedCompletion } from './gameplay/session/types';

export interface PuzzleStatsV1 {
	schemaVersion: 1;
	puzzleId: string;
	standardBestTime: number | null;
	standardBestCompletedAt: number | null;
	totalCompletions: number;
	lastCompletedAt: number;
	/** Most recently recorded run ID; also the newest entry in `recordedRunIds`. */
	lastRecordedRunId: string | null;
	/**
	 * Bounded ring of recently recorded run IDs, newest first. Dedup is per
	 * run ID across more than just the most recent run, so a stale pending
	 * session replaying an older run after a newer completion does not double
	 * count.
	 */
	recordedRunIds: string[];
}

const STATS_KEY_PREFIX = 'puzzle-stats-';
const CURRENT_STATS_SCHEMA_VERSION = 1;
/** Maximum number of run IDs retained for replay dedup. */
const MAX_RECORDED_RUN_IDS = 32;

export type LocalStatsFailureReason = 'storage_error';

export type RecordLocalCompletionResult =
	| { status: 'recorded'; isNewStandardBest: boolean; stats: PuzzleStatsV1 }
	| { status: 'replayed'; isNewStandardBest: boolean; stats: PuzzleStatsV1 }
	| {
			status: 'failed';
			isNewStandardBest: boolean;
			inMemoryStats: PuzzleStatsV1;
			/**
			 * Why the write did not persist. `storage_error` is a transient
			 * failure (Web Locks unavailable/rejected, or localStorage.setItem
			 * threw) and is retryable on hydration.
			 */
			reason: LocalStatsFailureReason;
	  };

function getStorageKey(puzzleId: string): string {
	return `${STATS_KEY_PREFIX}${puzzleId}`;
}

function isEligibleStandardBest(seal: SealedCompletion): boolean {
	return (
		seal.resultClass === 'standard_timed' &&
		seal.timingQuality === 'known' &&
		seal.elapsedActiveSeconds !== null
	);
}

function parseStoredStats(raw: Record<string, unknown>, puzzleId: string): PuzzleStatsV1 | null {
	if (raw.schemaVersion !== CURRENT_STATS_SCHEMA_VERSION) return null;
	return validateV1(raw, puzzleId);
}

function validateV1(raw: Record<string, unknown>, puzzleId: string): PuzzleStatsV1 | null {
	// Caller (parseStoredStats) guarantees schemaVersion === 1 before invoking.
	if (raw.puzzleId !== puzzleId) return null;
	const standardBestTime = raw.standardBestTime;
	if (
		standardBestTime !== null &&
		(typeof standardBestTime !== 'number' ||
			!Number.isFinite(standardBestTime) ||
			standardBestTime < 0)
	) {
		return null;
	}
	const standardBestCompletedAt = raw.standardBestCompletedAt;
	if (
		standardBestCompletedAt !== null &&
		(typeof standardBestCompletedAt !== 'number' ||
			!Number.isFinite(standardBestCompletedAt) ||
			standardBestCompletedAt < 0)
	) {
		return null;
	}
	const totalCompletions = raw.totalCompletions;
	if (
		typeof totalCompletions !== 'number' ||
		!Number.isInteger(totalCompletions) ||
		totalCompletions < 0
	) {
		return null;
	}
	const lastCompletedAt = raw.lastCompletedAt;
	if (
		typeof lastCompletedAt !== 'number' ||
		!Number.isFinite(lastCompletedAt) ||
		lastCompletedAt < 0
	) {
		return null;
	}
	const lastRecordedRunId = raw.lastRecordedRunId;
	if (lastRecordedRunId !== null && typeof lastRecordedRunId !== 'string') return null;
	const recordedRunIds = normalizeRecordedRunIds(raw.recordedRunIds, lastRecordedRunId);
	if (recordedRunIds === false) return null;
	// A retained run id implies a recorded completion; a record claiming fewer
	// completions than retained ids is internally inconsistent and likely
	// corrupt. Reject rather than salvage, since replay dedup trusts the ring.
	if ((totalCompletions as number) < recordedRunIds.length) return null;
	return {
		schemaVersion: CURRENT_STATS_SCHEMA_VERSION,
		puzzleId,
		standardBestTime: (standardBestTime as number | null) ?? null,
		standardBestCompletedAt: (standardBestCompletedAt as number | null) ?? null,
		totalCompletions: totalCompletions as number,
		lastCompletedAt: lastCompletedAt as number,
		lastRecordedRunId: (lastRecordedRunId as string | null) ?? null,
		recordedRunIds
	};
}

/**
 * Validate and normalize the recorded-run-id ring. Returns `false` for a
 * missing or malformed field (non-array, non-string entries) — silently
 * dropping entries would weaken replay dedup and let an old run count again.
 * The ring is capped at MAX_RECORDED_RUN_IDS (newest first).
 *
 * Consistency is enforced rather than salvaged: duplicate ids are rejected
 * (silent dedup would mask corruption), and `lastRecordedRunId` must equal the
 * ring head when both are present (or both be empty/null together). A mismatch
 * such as `lastRecordedRunId: "A"` with `recordedRunIds: ["B"]` is
 * contradictory — since recording dedups against the ring, run A would count
 * again on replay.
 */
function normalizeRecordedRunIds(raw: unknown, lastRecordedRunId: string | null): string[] | false {
	if (!Array.isArray(raw)) return false;
	for (const id of raw) {
		if (typeof id !== 'string') return false;
	}
	// Reject duplicates rather than silently deduping.
	if (new Set(raw).size !== raw.length) return false;
	// The ring (newest first) must agree with lastRecordedRunId: both empty
	// together, or lastRecordedRunId === ring head.
	if (raw.length === 0) {
		if (lastRecordedRunId !== null) return false;
	} else if (lastRecordedRunId === null || raw[0] !== lastRecordedRunId) {
		return false;
	}
	return raw.slice(0, MAX_RECORDED_RUN_IDS);
}

export function getStats(puzzleId: string): PuzzleStatsV1 | null {
	if (typeof window === 'undefined') return null;
	const key = getStorageKey(puzzleId);

	let raw: string | null;
	try {
		raw = localStorage.getItem(key);
	} catch {
		return null;
	}
	if (raw === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		try {
			localStorage.removeItem(key);
		} catch {
			// best-effort cleanup
		}
		return null;
	}

	if (parsed && typeof parsed === 'object') {
		const stats = parseStoredStats(parsed as Record<string, unknown>, puzzleId);
		if (stats) return stats;
	}
	// Best-effort cleanup of any stale, malformed, or unsupported record.
	try {
		localStorage.removeItem(key);
	} catch {
		// best-effort cleanup
	}
	return null;
}

export function getBestTime(puzzleId: string): number | null {
	return getStats(puzzleId)?.standardBestTime ?? null;
}

function freshStats(puzzleId: string): PuzzleStatsV1 {
	return {
		schemaVersion: CURRENT_STATS_SCHEMA_VERSION,
		puzzleId,
		standardBestTime: null,
		standardBestCompletedAt: null,
		totalCompletions: 0,
		lastCompletedAt: 0,
		lastRecordedRunId: null,
		recordedRunIds: []
	};
}

/**
 * Record a sealed run in local statistics. Idempotent per run id: a replayed
 * run does not increment totals. Only an eligible standard-timed known run with
 * non-null elapsed may create or improve the canonical best.
 *
 * Cross-tab safe: the read-modify-write is serialized per puzzle via a Web
 * Lock so two tabs completing different runs concurrently cannot both read
 * the same aggregate and overwrite one another. When the Web Locks API is
 * unavailable (SSR, legacy browsers), the lossy unlocked
 * read-modify-write is NOT performed — two tabs could race and silently drop
 * a completion, a faster best time, or each other's run-id ring. Instead the
 * in-memory verdict is computed for display and a retryable failure is
 * returned so the effect stays pending for a hydration retry on a capable
 * client. A rejected lock request is likewise converted to a retryable
 * failure rather than surfacing as an uncaught rejection (the route fires
 * the handler with `void`).
 */
export async function recordLocalCompletion(
	puzzleId: string,
	seal: SealedCompletion
): Promise<RecordLocalCompletionResult> {
	if (typeof navigator !== 'undefined' && navigator.locks?.request) {
		try {
			return await navigator.locks.request(`perseus-stats-${puzzleId}`, () =>
				recordLocalCompletionUnsafe(puzzleId, seal)
			);
		} catch {
			// Lock acquisition failed or the callback rejected. Convert to a
			// retryable failure so the route acknowledges the effect instead
			// of leaving an unhandled promise rejection pending.
			return computeResultWithoutWrite(puzzleId, seal);
		}
	}
	// Web Locks unavailable: skip the lossy unlocked write. Compute the
	// in-memory verdict for display and return a retryable failure.
	return computeResultWithoutWrite(puzzleId, seal);
}

/**
 * Read and parse the stored stats record WITHOUT side effects (no deletion).
 * Returns `null` for a missing/unreadable record.
 */
function readStoredStats(puzzleId: string): PuzzleStatsV1 | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(getStorageKey(puzzleId));
	} catch {
		return null;
	}
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	return parseStoredStats(parsed as Record<string, unknown>, puzzleId);
}

/**
 * Compute the record result and the would-be next stats WITHOUT writing.
 * Shared by the locked write path (which then persists `next`) and the
 * no-locks / rejected-lock fallback (which returns `next` as an in-memory
 * failed result without performing the lossy write).
 */
function computeRecord(
	puzzleId: string,
	seal: SealedCompletion
): { result: RecordLocalCompletionResult; next: PuzzleStatsV1 } {
	const stored = readStoredStats(puzzleId);
	const base = stored ?? freshStats(puzzleId);

	// Dedup against the bounded ring of recorded run IDs, not just the most
	// recent. A stale pending session can replay an older run after a newer
	// completion; such a replay must not increment totals.
	const recorded = new Set(base.recordedRunIds);
	if (recorded.has(seal.runId)) {
		return { result: { status: 'replayed', isNewStandardBest: false, stats: base }, next: base };
	}

	const eligible = isEligibleStandardBest(seal);
	const elapsed = seal.elapsedActiveSeconds ?? 0;
	const isNewStandardBest =
		eligible && (base.standardBestTime === null || elapsed < base.standardBestTime);

	// Seed the rebuilt ring from the same `recorded` set used for dedup, so
	// seal.runId is retained alongside prior IDs. It is already excluded from
	// `recorded` by the replay early-return above, so there is no duplicate.
	// Capped at MAX_RECORDED_RUN_IDS, newest first.
	const nextRunIds = [seal.runId, ...recorded].slice(0, MAX_RECORDED_RUN_IDS);

	const next: PuzzleStatsV1 = {
		schemaVersion: CURRENT_STATS_SCHEMA_VERSION,
		puzzleId,
		standardBestTime: isNewStandardBest ? elapsed : base.standardBestTime,
		standardBestCompletedAt: isNewStandardBest ? seal.completedAt : base.standardBestCompletedAt,
		totalCompletions: base.totalCompletions + 1,
		lastCompletedAt: Math.max(base.lastCompletedAt, seal.completedAt),
		lastRecordedRunId: seal.runId,
		recordedRunIds: nextRunIds
	};

	return { result: { status: 'recorded', isNewStandardBest, stats: next }, next };
}

function storageErrorResult(
	recorded: Extract<RecordLocalCompletionResult, { status: 'recorded' }>,
	next: PuzzleStatsV1
): RecordLocalCompletionResult {
	return {
		status: 'failed',
		isNewStandardBest: recorded.isNewStandardBest,
		inMemoryStats: next,
		reason: 'storage_error'
	};
}

function recordLocalCompletionUnsafe(
	puzzleId: string,
	seal: SealedCompletion
): RecordLocalCompletionResult {
	const { result, next } = computeRecord(puzzleId, seal);
	if (result.status !== 'recorded') {
		// 'replayed' needs no write. Return it as-is.
		return result;
	}
	try {
		localStorage.setItem(getStorageKey(puzzleId), JSON.stringify(next));
	} catch {
		return storageErrorResult(result, next);
	}
	return result;
}

/**
 * Fallback for the no-locks and rejected-lock paths: compute the in-memory
 * verdict (so the badge display stays accurate) WITHOUT performing the
 * unlocked read-modify-write, which two tabs could race on. A would-be
 * 'recorded' result is converted to a retryable 'failed' result (reason
 * `storage_error`) carrying the would-be next stats; a 'replayed' result
 * needs no write and passes through unchanged.
 */
function computeResultWithoutWrite(
	puzzleId: string,
	seal: SealedCompletion
): RecordLocalCompletionResult {
	const { result, next } = computeRecord(puzzleId, seal);
	if (result.status === 'recorded') {
		return storageErrorResult(result, next);
	}
	return result;
}

export function clearStats(puzzleId: string): void {
	if (typeof window === 'undefined') return;
	try {
		localStorage.removeItem(getStorageKey(puzzleId));
	} catch {
		// best-effort
	}
}
