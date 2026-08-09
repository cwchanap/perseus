import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getStats, getBestTime, recordLocalCompletion, clearStats } from '../stats';
import type { SealedCompletion } from '../gameplay/session/types';

function makeSeal(overrides: Partial<SealedCompletion> = {}): SealedCompletion {
	return {
		runId: '11111111-1111-4111-8111-111111111111',
		resultClass: 'standard_timed',
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
			const key = `puzzle-stats-${puzzleId}`;
			localStorage.setItem(key, 'invalid json{{{');
			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(key)).toBeNull();
		});

		it('deletes an unversioned record', () => {
			const key = `puzzle-stats-${puzzleId}`;
			localStorage.setItem(
				key,
				JSON.stringify({
					puzzleId,
					bestTime: 90,
					completedAt: '2024-01-01T00:00:00.000Z',
					totalCompletions: 2
				})
			);
			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(key)).toBeNull();
		});

		it('deletes a JSON primitive instead of reparsing it forever', () => {
			const key = `puzzle-stats-${puzzleId}`;
			localStorage.setItem(key, '42');

			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(key)).toBeNull();
		});

		it('deletes an empty stored string', () => {
			const key = `puzzle-stats-${puzzleId}`;
			localStorage.setItem(key, '');

			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(key)).toBeNull();
		});

		it('deletes a higher-schema record', () => {
			const key = `puzzle-stats-${puzzleId}`;
			localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, puzzleId }));

			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(key)).toBeNull();
		});

		it('getBestTime returns the standard best', async () => {
			await recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 90 }));
			expect(getBestTime(puzzleId)).toBe(90);
		});

		it('getBestTime returns null when no standard best exists', async () => {
			await recordLocalCompletion(puzzleId, makeSeal({ resultClass: 'rotation_timed' }));
			expect(getBestTime(puzzleId)).toBeNull();
		});
	});

	describe('recordLocalCompletion eligibility', () => {
		it('records an eligible standard-timed run as the standard best', async () => {
			const result = await recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 100 }));
			expect(result.status).toBe('recorded');
			expect(result.isNewStandardBest).toBe(true);
			expect(getStats(puzzleId)?.standardBestTime).toBe(100);
			expect(getStats(puzzleId)?.totalCompletions).toBe(1);
		});

		it('improves the standard best when the new time is faster', async () => {
			await recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 100, runId: 'r1' }));
			const result = await recordLocalCompletion(
				puzzleId,
				makeSeal({ elapsedActiveSeconds: 80, runId: 'r2' })
			);
			expect(result.isNewStandardBest).toBe(true);
			expect(getStats(puzzleId)?.standardBestTime).toBe(80);
			expect(getStats(puzzleId)?.totalCompletions).toBe(2);
		});

		it('keeps the standard best when the new time is slower', async () => {
			await recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 80, runId: 'r1' }));
			const result = await recordLocalCompletion(
				puzzleId,
				makeSeal({ elapsedActiveSeconds: 120, runId: 'r2' })
			);
			expect(result.isNewStandardBest).toBe(false);
			expect(getStats(puzzleId)?.standardBestTime).toBe(80);
		});

		it('counts a rotation_timed run toward totals but never the best', async () => {
			await recordLocalCompletion(
				puzzleId,
				makeSeal({ resultClass: 'rotation_timed', runId: 'r1' })
			);
			expect(getStats(puzzleId)?.standardBestTime).toBeNull();
			expect(getStats(puzzleId)?.totalCompletions).toBe(1);
		});

		it('counts assisted and relaxed runs without touching the best', async () => {
			await recordLocalCompletion(
				puzzleId,
				makeSeal({ resultClass: 'assisted_timed', runId: 'r1' })
			);
			await recordLocalCompletion(puzzleId, makeSeal({ resultClass: 'relaxed', runId: 'r2' }));
			expect(getStats(puzzleId)?.standardBestTime).toBeNull();
			expect(getStats(puzzleId)?.totalCompletions).toBe(2);
		});

		it('is idempotent per run id (replay does not increment totals)', async () => {
			await recordLocalCompletion(puzzleId, makeSeal({ runId: 'r1' }));
			const replay = await recordLocalCompletion(puzzleId, makeSeal({ runId: 'r1' }));
			expect(replay.status).toBe('replayed');
			expect(getStats(puzzleId)?.totalCompletions).toBe(1);
		});

		it('is idempotent per run id across an intervening completion (A -> B -> A)', async () => {
			// Stale pending sessions from different tabs can replay an older run
			// after a newer completion has already been recorded. Dedup must be
			// per-run-id, not just against the most recent run.
			await recordLocalCompletion(puzzleId, makeSeal({ runId: 'A' }));
			await recordLocalCompletion(puzzleId, makeSeal({ runId: 'B' }));
			const replay = await recordLocalCompletion(puzzleId, makeSeal({ runId: 'A' }));
			expect(replay.status).toBe('replayed');
			expect(getStats(puzzleId)?.totalCompletions).toBe(2);
		});

		it('reports failure but preserves the in-memory new-best verdict when storage throws', async () => {
			await recordLocalCompletion(puzzleId, makeSeal({ elapsedActiveSeconds: 100, runId: 'r1' }));
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
				const result = await recordLocalCompletion(
					puzzleId,
					makeSeal({ elapsedActiveSeconds: 50, runId: 'r2' })
				);
				expect(result.status).toBe('failed');
				expect(result.isNewStandardBest).toBe(true);
				// A transient storage failure is retryable, distinct from a
				// transient storage failure.
				if (result.status === 'failed') {
					expect(result.reason).toBe('storage_error');
				}
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});

	describe('recorded-run-id ring consistency', () => {
		function putV1(overrides: Record<string, unknown>) {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 2,
					lastCompletedAt: 1000,
					lastRecordedRunId: 'A',
					recordedRunIds: ['A', 'B'],
					...overrides
				})
			);
		}

		it('rejects a record whose lastRecordedRunId disagrees with the ring head', () => {
			// lastRecordedRunId 'A' but ring head 'B': contradictory. Because
			// recording dedups against the ring, run A would count again on
			// replay. Such a corrupt record must be rejected, not salvaged.
			putV1({ lastRecordedRunId: 'A', recordedRunIds: ['B', 'A'] });
			expect(getStats(puzzleId)).toBeNull();
		});

		it('rejects a record with duplicate run ids in the ring', () => {
			// Silent dedup would mask corruption. Reject instead.
			putV1({ lastRecordedRunId: 'A', recordedRunIds: ['A', 'A'] });
			expect(getStats(puzzleId)).toBeNull();
		});

		it('rejects a record where totalCompletions is less than the retained run-id count', () => {
			putV1({ totalCompletions: 1, lastRecordedRunId: 'A', recordedRunIds: ['A', 'B', 'C'] });
			expect(getStats(puzzleId)).toBeNull();
		});

		it('rejects a record with a null lastRecordedRunId but a non-empty ring', () => {
			putV1({ lastRecordedRunId: null, recordedRunIds: ['A', 'B'] });
			expect(getStats(puzzleId)).toBeNull();
		});

		it('rejects a record with a set lastRecordedRunId but an empty ring', () => {
			putV1({ lastRecordedRunId: 'A', recordedRunIds: [] });
			expect(getStats(puzzleId)).toBeNull();
		});

		it('accepts a consistent record whose lastRecordedRunId matches the ring head', () => {
			putV1({ totalCompletions: 2, lastRecordedRunId: 'A', recordedRunIds: ['A', 'B'] });
			const stats = getStats(puzzleId);
			expect(stats).not.toBeNull();
			expect(stats?.lastRecordedRunId).toBe('A');
			expect(stats?.recordedRunIds).toEqual(['A', 'B']);
		});

		it('accepts a record with both lastRecordedRunId and ring empty together', () => {
			putV1({ totalCompletions: 0, lastRecordedRunId: null, recordedRunIds: [] });
			const stats = getStats(puzzleId);
			expect(stats).not.toBeNull();
			expect(stats?.lastRecordedRunId).toBeNull();
			expect(stats?.recordedRunIds).toEqual([]);
		});
	});

	describe('clearStats', () => {
		it('removes stats from localStorage', async () => {
			await recordLocalCompletion(puzzleId, makeSeal());
			clearStats(puzzleId);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('does not throw when stats do not exist', () => {
			expect(() => clearStats('nonexistent-puzzle')).not.toThrow();
		});
	});

	describe('parseStoredStats / validateV1 rejection branches', () => {
		it('returns null and cleans up for an unversioned record with invalid fields', () => {
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
					lastRecordedRunId: null,
					recordedRunIds: []
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
					lastRecordedRunId: null,
					recordedRunIds: []
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
					lastRecordedRunId: null,
					recordedRunIds: []
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
					lastRecordedRunId: null,
					recordedRunIds: []
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
					lastRecordedRunId: 123,
					recordedRunIds: []
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for an unversioned record with a negative totalCompletions', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					puzzleId,
					bestTime: 90,
					completedAt: '2024-01-01T00:00:00.000Z',
					totalCompletions: -1
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for a v1 record with a non-array recordedRunIds', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: 'r1',
					recordedRunIds: 'r1'
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null for a v1 record with a recordedRunIds array containing non-strings', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: 'r1',
					recordedRunIds: ['r1', 123]
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('rejects a v1 record when recordedRunIds is absent', () => {
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					schemaVersion: 1,
					puzzleId,
					standardBestTime: null,
					standardBestCompletedAt: null,
					totalCompletions: 1,
					lastCompletedAt: 1000,
					lastRecordedRunId: 'r1'
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
					lastRecordedRunId: null,
					recordedRunIds: []
				})
			);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null and cleans up when parseStoredStats rejects a JSON array', () => {
			localStorage.setItem(`puzzle-stats-${puzzleId}`, '[1, 2, 3]');
			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(`puzzle-stats-${puzzleId}`)).toBeNull();
		});
	});

	describe('defensive branches', () => {
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
					lastRecordedRunId: null,
					recordedRunIds: []
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

describe('Stats Service - Web Locks unavailable fallback', () => {
	const puzzleId = 'test-stats-locks-fallback';
	let originalDescriptor: PropertyDescriptor | undefined;

	function disableWebLocks() {
		originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
		Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
	}

	function restoreWebLocks() {
		if (originalDescriptor) {
			Object.defineProperty(navigator, 'locks', originalDescriptor);
		} else {
			// 'locks' was inherited, not an own property: remove the shadowing
			// own property we added so the inherited accessor is visible again.
			delete (navigator as unknown as Record<string, unknown>).locks;
		}
	}

	beforeEach(() => {
		localStorage.clear();
		disableWebLocks();
	});

	afterEach(() => {
		restoreWebLocks();
	});

	it('returns a retryable failure and does NOT perform the lossy unlocked write', async () => {
		const seal = makeSeal({ elapsedActiveSeconds: 100, runId: 'r1' });
		const result = await recordLocalCompletion(puzzleId, seal);

		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			expect(result.reason).toBe('storage_error');
		}
		// No unlocked read-modify-write occurred: storage stays empty.
		expect(getStats(puzzleId)).toBeNull();
	});

	it('still computes the in-memory new-best verdict for display without writing', async () => {
		// Seed a prior best of 200 directly in storage.
		localStorage.setItem(
			`puzzle-stats-${puzzleId}`,
			JSON.stringify({
				schemaVersion: 1,
				puzzleId,
				standardBestTime: 200,
				standardBestCompletedAt: 500,
				totalCompletions: 1,
				lastCompletedAt: 500,
				lastRecordedRunId: 'prior',
				recordedRunIds: ['prior']
			})
		);
		const seal = makeSeal({ elapsedActiveSeconds: 100, runId: 'new-run' });
		const result = await recordLocalCompletion(puzzleId, seal);

		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			// The would-be next stats are reported for accurate badge display.
			expect(result.isNewStandardBest).toBe(true);
			expect(result.inMemoryStats.standardBestTime).toBe(100);
			expect(result.inMemoryStats.totalCompletions).toBe(2);
		}
		// The stored record is unchanged: no lossy write.
		expect(getStats(puzzleId)?.standardBestTime).toBe(200);
		expect(getStats(puzzleId)?.totalCompletions).toBe(1);
	});

	it('returns replayed (no write) for an already-recorded run', async () => {
		localStorage.setItem(
			`puzzle-stats-${puzzleId}`,
			JSON.stringify({
				schemaVersion: 1,
				puzzleId,
				standardBestTime: 100,
				standardBestCompletedAt: 500,
				totalCompletions: 1,
				lastCompletedAt: 500,
				lastRecordedRunId: 'dup-run',
				recordedRunIds: ['dup-run']
			})
		);
		const seal = makeSeal({ elapsedActiveSeconds: 50, runId: 'dup-run' });
		const result = await recordLocalCompletion(puzzleId, seal);

		// Replay needs no write, so it is safe even without a lock.
		expect(result.status).toBe('replayed');
		expect(getStats(puzzleId)?.totalCompletions).toBe(1);
		expect(getStats(puzzleId)?.standardBestTime).toBe(100);
	});
});

describe('Stats Service - Web Locks rejection', () => {
	const puzzleId = 'test-stats-locks-reject';
	let requestSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		localStorage.clear();
		requestSpy = vi
			.spyOn(navigator.locks, 'request')
			.mockImplementation(() => Promise.reject(new Error('lock resource exhausted')));
	});

	afterEach(() => {
		requestSpy.mockRestore();
	});

	it('converts a rejected navigator.locks.request into a retryable failure without an uncaught rejection', async () => {
		const seal = makeSeal({ elapsedActiveSeconds: 100, runId: 'r1' });
		const result = await recordLocalCompletion(puzzleId, seal);

		// The rejection is caught and surfaced as a failed result rather than
		// propagating as an unhandled promise rejection (the route fires the
		// handler with `void`).
		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			expect(result.reason).toBe('storage_error');
		}
		expect(getStats(puzzleId)).toBeNull();
	});
});
