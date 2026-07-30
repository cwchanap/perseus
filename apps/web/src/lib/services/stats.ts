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
	if (raw.schemaVersion === CURRENT_STATS_SCHEMA_VERSION) {
		return validateV1(raw, puzzleId);
	}
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
		!Number.isInteger(totalCompletions)
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
 * Validate and normalize the recorded-run-id ring. Absent on older records;
 * seeded from `lastRecordedRunId` for back-compat. Each entry must be a
 * string; the ring is capped at MAX_RECORDED_RUN_IDS (newest first).
 */
function normalizeRecordedRunIds(raw: unknown, lastRecordedRunId: string | null): string[] {
	if (Array.isArray(raw)) {
		const ids = raw.filter((id): id is string => typeof id === 'string');
		return Array.from(new Set(ids)).slice(0, MAX_RECORDED_RUN_IDS);
	}
	return lastRecordedRunId ? [lastRecordedRunId] : [];
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
	const stats = parseStoredStats(record, puzzleId);
	if (!stats) {
		try {
			localStorage.removeItem(getStorageKey(puzzleId));
		} catch {
			// best-effort cleanup
		}
		return null;
	}
	return stats;
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
 */
export function recordLocalCompletion(
	puzzleId: string,
	seal: SealedCompletion
): RecordLocalCompletionResult {
	const base = getStats(puzzleId) ?? freshStats(puzzleId);

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
		return { status: 'replayed', isNewStandardBest: false, stats: base };
	}

	const eligible = isEligibleStandardBest(seal);
	const elapsed = seal.elapsedActiveSeconds ?? 0;
	const isNewStandardBest =
		eligible && (base.standardBestTime === null || elapsed < base.standardBestTime);

	const nextRunIds = [seal.runId, ...base.recordedRunIds].slice(0, MAX_RECORDED_RUN_IDS);

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

	try {
		localStorage.setItem(getStorageKey(puzzleId), JSON.stringify(next));
	} catch {
		return { status: 'failed', isNewStandardBest, inMemoryStats: next };
	}
	return { status: 'recorded', isNewStandardBest, stats: next };
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
export function saveCompletionTime(puzzleId: string, timeSeconds: number): boolean {
	const seal: SealedCompletion = {
		runId: `compat-${timeSeconds}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`,
		resultClass: 'standard_timed',
		timingQuality: 'known',
		elapsedActiveSeconds: timeSeconds,
		completedAt: Date.now(),
		localStats: { status: 'succeeded' },
		serverSubmission: { status: 'not_applicable' }
	};
	return recordLocalCompletion(puzzleId, seal).isNewStandardBest;
}
