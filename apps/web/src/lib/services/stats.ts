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
	 * count. Absent on older records; seeded from `lastRecordedRunId`.
	 */
	recordedRunIds: string[];
}

const STATS_KEY_PREFIX = 'puzzle-stats-';
const CURRENT_STATS_SCHEMA_VERSION = 1;
/** Maximum number of run IDs retained for replay dedup. */
const MAX_RECORDED_RUN_IDS = 32;

export type RecordLocalCompletionResult =
	| { status: 'recorded'; isNewStandardBest: boolean; stats: PuzzleStatsV1 }
	| { status: 'replayed'; isNewStandardBest: boolean; stats: PuzzleStatsV1 }
	| { status: 'failed'; isNewStandardBest: boolean; inMemoryStats: PuzzleStatsV1 };

/**
 * Outcome of parsing a stored stats record. A future-schema record
 * (`schemaVersion` present and higher than current) is `incompatible`: it is
 * unreadable by this deployment and must be preserved (not deleted or
 * overwritten) so a newer client can still read it. This mirrors the session
 * persistence layer's incompatible-schema policy.
 */
type ParsedStats =
	| { kind: 'valid'; stats: PuzzleStatsV1 }
	| { kind: 'incompatible'; schemaVersion: number }
	| { kind: 'invalid' };

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

function parseLegacyRecord(raw: Record<string, unknown>, puzzleId: string): PuzzleStatsV1 | null {
	// Legacy unversioned shape: { puzzleId, bestTime, completedAt (ISO), totalCompletions }.
	const bestTime = raw.bestTime;
	const completedAt = raw.completedAt;
	const totalCompletions = raw.totalCompletions;
	if (
		typeof bestTime !== 'number' ||
		!Number.isFinite(bestTime) ||
		bestTime < 0 ||
		typeof completedAt !== 'string' ||
		typeof totalCompletions !== 'number' ||
		!Number.isInteger(totalCompletions) ||
		totalCompletions < 0
	) {
		return null;
	}
	const completedMs = Date.parse(completedAt);
	const ts = Number.isFinite(completedMs) ? completedMs : 0;
	return {
		schemaVersion: CURRENT_STATS_SCHEMA_VERSION,
		puzzleId,
		standardBestTime: bestTime,
		standardBestCompletedAt: ts,
		totalCompletions,
		lastCompletedAt: ts,
		lastRecordedRunId: null,
		recordedRunIds: []
	};
}

function parseStoredStats(raw: Record<string, unknown>, puzzleId: string): ParsedStats {
	// A present schemaVersion gates the versioned path. Only an ABSENT
	// schemaVersion is treated as legacy unversioned; a higher version is
	// incompatible (preserved), and a present-but-bogus version is invalid.
	if (Object.hasOwn(raw, 'schemaVersion')) {
		const version = raw.schemaVersion;
		if (typeof version !== 'number' || !Number.isInteger(version)) {
			return { kind: 'invalid' };
		}
		if (version > CURRENT_STATS_SCHEMA_VERSION) {
			return { kind: 'incompatible', schemaVersion: version };
		}
		if (version === CURRENT_STATS_SCHEMA_VERSION) {
			const v1 = validateV1(raw, puzzleId);
			return v1 ? { kind: 'valid', stats: v1 } : { kind: 'invalid' };
		}
		// A present-but-older versioned shape has no migration target (legacy
		// is unversioned); treat as corrupt.
		return { kind: 'invalid' };
	}
	const legacy = parseLegacyRecord(raw, puzzleId);
	return legacy ? { kind: 'valid', stats: legacy } : { kind: 'invalid' };
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
 * present-but-malformed field (non-array, non-string entries) — silently
 * dropping entries would weaken replay dedup and let an old run count again.
 * Absent (`undefined`) on older records is valid and seeded from
 * `lastRecordedRunId` for back-compat. The ring is capped at
 * MAX_RECORDED_RUN_IDS (newest first).
 *
 * Consistency is enforced rather than salvaged: duplicate ids are rejected
 * (silent dedup would mask corruption), and `lastRecordedRunId` must equal the
 * ring head when both are present (or both be empty/null together). A mismatch
 * such as `lastRecordedRunId: "A"` with `recordedRunIds: ["B"]` is
 * contradictory — since recording dedups against the ring, run A would count
 * again on replay.
 */
function normalizeRecordedRunIds(raw: unknown, lastRecordedRunId: string | null): string[] | false {
	if (raw === undefined) {
		// Back-compat: older v1 records have no ring; seed from
		// lastRecordedRunId. The seeded ring is consistent by construction.
		return lastRecordedRunId ? [lastRecordedRunId] : [];
	}
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
		try {
			localStorage.removeItem(getStorageKey(puzzleId));
		} catch {
			// best-effort cleanup
		}
		return null;
	}

	if (!parsed || typeof parsed !== 'object') return null;
	const record = parsed as Record<string, unknown>;
	const result = parseStoredStats(record, puzzleId);
	if (result.kind === 'valid') {
		return result.stats;
	}
	if (result.kind === 'incompatible') {
		// Preserve the newer-schema record; an older deployment must not
		// destroy statistics it cannot read. The record is left in place for
		// a newer client to interpret.
		return null;
	}
	// invalid: best-effort cleanup of a corrupt current-schema/legacy record.
	try {
		localStorage.removeItem(getStorageKey(puzzleId));
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
			return computeFailedResult(puzzleId, seal);
		}
	}
	// Web Locks unavailable: skip the lossy unlocked write. Compute the
	// in-memory verdict for display and return a retryable failure.
	return computeFailedResult(puzzleId, seal);
}

/**
 * Read and parse the stored stats record WITHOUT side effects (no deletion).
 * Returns `null` for a missing/unreadable record. Used by the write path to
 * detect an incompatible future-schema record before touching storage.
 */
function readStoredStats(puzzleId: string): ParsedStats | null {
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
	// An incompatible (future-schema) record must not be overwritten by an
	// older deployment. Suppress the write and report failure against an
	// empty in-memory baseline so no unverified "new best" is claimed. The
	// newer client that wrote the record still owns it.
	if (stored?.kind === 'incompatible') {
		const baseline = freshStats(puzzleId);
		return {
			result: { status: 'failed', isNewStandardBest: false, inMemoryStats: baseline },
			next: baseline
		};
	}
	const base = stored?.kind === 'valid' ? stored.stats : freshStats(puzzleId);

	// Dedup against the bounded ring of recorded run IDs, not just the most
	// recent. A stale pending session can replay an older run after a newer
	// completion; such a replay must not increment totals.
	const recorded = new Set(
		base.recordedRunIds.length > 0
			? base.recordedRunIds
			: base.lastRecordedRunId
				? [base.lastRecordedRunId]
				: []
	);
	if (recorded.has(seal.runId)) {
		return { result: { status: 'replayed', isNewStandardBest: false, stats: base }, next: base };
	}

	const eligible = isEligibleStandardBest(seal);
	const elapsed = seal.elapsedActiveSeconds ?? 0;
	const isNewStandardBest =
		eligible && (base.standardBestTime === null || elapsed < base.standardBestTime);

	// Seed the rebuilt ring from the same `recorded` set used for dedup (which
	// falls back to lastRecordedRunId when recordedRunIds is empty), so the
	// fallback id is retained in the ring rather than dropped. seal.runId is
	// already excluded from `recorded` by the replay early-return above, so
	// there is no duplicate. Capped at MAX_RECORDED_RUN_IDS, newest first.
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

function recordLocalCompletionUnsafe(
	puzzleId: string,
	seal: SealedCompletion
): RecordLocalCompletionResult {
	const { result, next } = computeRecord(puzzleId, seal);
	if (result.status !== 'recorded') {
		// 'replayed' (no write needed) or 'failed' (incompatible: no write
		// allowed). Return as-is.
		return result;
	}
	try {
		localStorage.setItem(getStorageKey(puzzleId), JSON.stringify(next));
	} catch {
		return { status: 'failed', isNewStandardBest: result.isNewStandardBest, inMemoryStats: next };
	}
	return result;
}

/**
 * Fallback for the no-locks and rejected-lock paths: compute the in-memory
 * verdict (so the badge display stays accurate) but do NOT perform the
 * unlocked read-modify-write, which two tabs could race on. A would-be
 * 'recorded' result is converted to a retryable 'failed' result carrying
 * the would-be next stats; 'replayed' and incompatible-'failed' results
 * need no write and pass through unchanged.
 */
function computeFailedResult(
	puzzleId: string,
	seal: SealedCompletion
): RecordLocalCompletionResult {
	const { result, next } = computeRecord(puzzleId, seal);
	if (result.status === 'recorded') {
		return { status: 'failed', isNewStandardBest: result.isNewStandardBest, inMemoryStats: next };
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

/**
 * @deprecated Compatibility shim retained until the puzzle route migrates to
 * recordLocalCompletion (HPA-372 Tasks 10/11). Returns the in-memory new-best
 * verdict even when the local write fails.
 */
export async function saveCompletionTime(puzzleId: string, timeSeconds: number): Promise<boolean> {
	const seal: SealedCompletion = {
		runId: `compat-${timeSeconds}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`,
		resultClass: 'standard_timed',
		timingQuality: 'known',
		elapsedActiveSeconds: timeSeconds,
		completedAt: Date.now(),
		localStats: { status: 'succeeded' },
		serverSubmission: { status: 'not_applicable' }
	};
	return (await recordLocalCompletion(puzzleId, seal)).isNewStandardBest;
}
