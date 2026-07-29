import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	getStats,
	getBestTime,
	recordLocalCompletion,
	clearStats,
	saveCompletionTime
} from '../stats';
import type { SealedCompletion } from '../gameplay/session/types';

function makeSeal(overrides: Partial<SealedCompletion> = {}): SealedCompletion {
	return {
		runId: '11111111-1111-4111-8111-111111111111',
		resultClass: 'standard_timed',
		timingQuality: 'known',
		elapsedActiveSeconds: 120,
		completedAt: 1_000,
		localStats: { status: 'pending' },
		serverSubmission: { status: 'pending' },
		...overrides
	};
}

describe('Stats Service', () => {
	const puzzleId = 'test-puzzle-stats-123';

	beforeEach(() => {
		localStorage.clear();
	});

	describe('getStats / getBestTime', () => {
		it('returns null when no stats exist', () => {
			expect(getStats(puzzleId)).toBeNull();
			expect(getBestTime(puzzleId)).toBeNull();
		});

		it('returns null for malformed JSON', () => {
			localStorage.setItem(`puzzle-stats-${puzzleId}`, 'invalid json{{{');
			expect(getStats(puzzleId)).toBeNull();
		});

		it('migrates a legacy unversioned record to a standard best', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					puzzleId,
					bestTime: 90,
					completedAt: '2024-01-01T00:00:00.000Z',
					totalCompletions: 2
				})
			);
			const stats = getStats(puzzleId);
			expect(stats?.schemaVersion).toBe(1);
			expect(stats?.standardBestTime).toBe(90);
			expect(stats?.totalCompletions).toBe(2);
			expect(stats?.lastRecordedRunId).toBeNull();
		});

		it('getBestTime returns the standard best', () => {
			recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 90 }));
			expect(getBestTime(puzzleId)).toBe(90);
		});

		it('getBestTime returns null when no standard best exists', () => {
			recordLocalCompletion(puzzleId, makeSeal({ resultClass: 'rotation_timed' }));
			expect(getBestTime(puzzleId)).toBeNull();
		});
	});

	describe('recordLocalCompletion eligibility', () => {
		it('records an eligible standard-timed run as the standard best', () => {
			const result = recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 100 }));
			expect(result.status).toBe('recorded');
			expect(result.isNewStandardBest).toBe(true);
			expect(getStats(puzzleId)?.standardBestTime).toBe(100);
			expect(getStats(puzzleId)?.totalCompletions).toBe(1);
		});

		it('improves the standard best when the new time is faster', () => {
			recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 100, runId: 'r1' }));
			const result = recordLocalCompletion(
				puzzleId,
				makeSeal({ elapsedActiveSeconds: 80, runId: 'r2' })
			);
			expect(result.isNewStandardBest).toBe(true);
			expect(getStats(puzzleId)?.standardBestTime).toBe(80);
			expect(getStats(puzzleId)?.totalCompletions).toBe(2);
		});

		it('keeps the standard best when the new time is slower', () => {
			recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 80, runId: 'r1' }));
			const result = recordLocalCompletion(
				puzzleId,
				makeSeal({ elapsedActiveSeconds: 120, runId: 'r2' })
			);
			expect(result.isNewStandardBest).toBe(false);
			expect(getStats(puzzleId)?.standardBestTime).toBe(80);
		});

		it('counts a rotation_timed run toward totals but never the best', () => {
			recordLocalCompletion(puzzleId, makeSeal({ resultClass: 'rotation_timed', runId: 'r1' }));
			expect(getStats(puzzleId)?.standardBestTime).toBeNull();
			expect(getStats(puzzleId)?.totalCompletions).toBe(1);
		});

		it('counts an assisted/relaxed/legacy-unknown run without touching the best', () => {
			recordLocalCompletion(puzzleId, makeSeal({ resultClass: 'assisted_timed', runId: 'r1' }));
			recordLocalCompletion(puzzleId, makeSeal({ resultClass: 'relaxed', runId: 'r2' }));
			recordLocalCompletion(
				puzzleId,
				makeSeal({ timingQuality: 'legacy_unknown', elapsedActiveSeconds: null, runId: 'r3' })
			);
			expect(getStats(puzzleId)?.standardBestTime).toBeNull();
			expect(getStats(puzzleId)?.totalCompletions).toBe(3);
		});

		it('is idempotent per run id (replay does not increment totals)', () => {
			recordLocalCompletion(puzzleId, makeSeal({ runId: 'r1' }));
			const replay = recordLocalCompletion(puzzleId, makeSeal({ runId: 'r1' }));
			expect(replay.status).toBe('replayed');
			expect(getStats(puzzleId)?.totalCompletions).toBe(1);
		});

		it('reports failure but preserves the in-memory new-best verdict when storage throws', () => {
			recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 100, runId: 'r1' }));
			const real = localStorage;
			vi.stubGlobal('localStorage', {
				getItem: (k: string) => real.getItem(k),
				setItem: () => {
					throw new DOMException('QuotaExceededError');
				},
				removeItem: (k: string) => real.removeItem(k),
				clear: () => real.clear(),
				length: 0,
				key: () => null
			});
			try {
				const result = recordLocalCompletion(
					puzzleId,
					makeSeal({ elapsedActiveSeconds: 50, runId: 'r2' })
				);
				expect(result.status).toBe('failed');
				expect(result.isNewStandardBest).toBe(true);
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});

	describe('saveCompletionTime (compat shim)', () => {
		it('returns the new-best boolean for the legacy caller', () => {
			expect(saveCompletionTime(puzzleId, 100)).toBe(true);
			expect(saveCompletionTime(puzzleId, 80)).toBe(true);
			expect(saveCompletionTime(puzzleId, 200)).toBe(false);
		});
	});

	describe('clearStats', () => {
		it('removes stats from localStorage', () => {
			recordLocalCompletion(puzzleId, makeSeal());
			clearStats(puzzleId);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('does not throw when stats do not exist', () => {
			expect(() => clearStats('nonexistent-puzzle')).not.toThrow();
		});
	});

	describe('parseStoredStats / validateV1 rejection branches', () => {
		it('returns null and cleans up for a legacy record with a non-numeric bestTime', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					puzzleId,
					bestTime: 'not-a-number',
					completedAt: '2024-01-01T00:00:00.000Z',
					totalCompletions: 2
				})
			);
			expect(getStats(puzzleId)).toBeNull();
			// The invalid record should have been cleaned up.
			expect(localStorage.getItem(`puzzle-stats-${puzzleId}`)).toBeNull();
		});

		it('returns null for a v1 record with an invalid standardBestTime', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: 'bad',
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: null
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for a v1 record with a negative standardBestCompletedAt', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: -5,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: null
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for a v1 record with a non-integer totalCompletions', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1.5,
					lastCompletedAt: 1000,
					lastRecordedRunId: null
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for a v1 record with a non-numeric lastCompletedAt', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 'not-a-number',
					lastRecordedRunId: null
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for a v1 record with a non-string lastRecordedRunId', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: 123
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for a v1 record with a puzzleId mismatch', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId: 'different-puzzle',
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: null
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null and cleans up when parseStoredStats rejects a JSON array', () => {
			localStorage.setItem(`puzzle-stats-${puzzleId}`, '[1, 2, 3]');
			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(`puzzle-stats-${puzzleId}`)).toBeNull();
		});

		it('returns null but leaves the key in place for a JSON primitive (typeof !== "object")', () => {
			localStorage.setItem(`puzzle-stats-${puzzleId}`, '42');
			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(`puzzle-stats-${puzzleId}`)).toBe('42');
		});
	});

	describe('defensive branches', () => {
		it('coerces an unparseable legacy completedAt to a zero timestamp', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					puzzleId,
					bestTime: 90,
					completedAt: 'not-a-real-date',
					totalCompletions: 2
				})
			);
			const stats = getStats(puzzleId);
			expect(stats?.schemaVersion).toBe(1);
			expect(stats?.standardBestTime).toBe(90);
			expect(stats?.standardBestCompletedAt).toBe(0);
			expect(stats?.lastCompletedAt).toBe(0);
			expect(stats?.totalCompletions).toBe(2);
		});

		it('loads a valid v1 record with all nullable best fields set to null', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: null
				})
			);
			const stats = getStats(puzzleId);
			expect(stats).not.toBeNull();
			expect(stats?.standardBestTime).toBeNull();
			expect(stats?.standardBestCompletedAt).toBeNull();
			expect(stats?.lastRecordedRunId).toBeNull();
			expect(stats?.totalCompletions).toBe(1);
		});

		it('returns null when localStorage.getItem throws (e.g. sandboxed origin)', () => {
			const real = localStorage;
			vi.stubGlobal('localStorage', {
				getItem: () => {
					throw new DOMException('The operation is insecure');
				},
				setItem: (key: string, value: string) => real.setItem(key, value),
				removeItem: (key: string) => real.removeItem(key),
				clear: () => real.clear(),
				length: 0,
				key: () => null
			});
			try {
				expect(getStats(puzzleId)).toBeNull();
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});
});
