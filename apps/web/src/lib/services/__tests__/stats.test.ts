import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getStats, getBestTime, saveCompletionTime, clearStats } from '../stats';

describe('Stats Service', () => {
	const puzzleId = 'test-puzzle-stats-123';

	beforeEach(() => {
		localStorage.clear();
	});

	describe('getStats', () => {
		it('returns null when no stats exist', () => {
			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns parsed stats when they exist', () => {
			saveCompletionTime(puzzleId, 120);
			const stats = getStats(puzzleId);
			expect(stats).not.toBeNull();
			expect(stats?.puzzleId).toBe(puzzleId);
			expect(stats?.bestTime).toBe(120);
		});

		it('returns null for malformed JSON in localStorage', () => {
			localStorage.setItem(`puzzle-stats-${puzzleId}`, 'invalid json{{{');
			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(`puzzle-stats-${puzzleId}`)).toBeNull();
		});

		it('returns null and removes stats for valid JSON with invalid structure', () => {
			const storageKey = `puzzle-stats-${puzzleId}`;
			localStorage.setItem(storageKey, JSON.stringify({ puzzleId }));

			expect(getStats(puzzleId)).toBeNull();
			expect(localStorage.getItem(storageKey)).toBeNull();
		});
	});

	describe('getBestTime', () => {
		it('returns null when no stats exist', () => {
			expect(getBestTime(puzzleId)).toBeNull();
		});

		it('returns the best time from existing stats', () => {
			saveCompletionTime(puzzleId, 90);
			expect(getBestTime(puzzleId)).toBe(90);
		});
	});

	describe('saveCompletionTime', () => {
		it('returns true and saves stats on first completion', () => {
			const isNewBest = saveCompletionTime(puzzleId, 100);
			expect(isNewBest).toBe(true);
			const stats = getStats(puzzleId);
			expect(stats?.bestTime).toBe(100);
			expect(stats?.totalCompletions).toBe(1);
		});

		it('returns true and updates best time when new time is faster', () => {
			saveCompletionTime(puzzleId, 100);
			const isNewBest = saveCompletionTime(puzzleId, 80);
			expect(isNewBest).toBe(true);
			expect(getStats(puzzleId)?.bestTime).toBe(80);
		});

		it('returns false and keeps best time when new time is slower', () => {
			saveCompletionTime(puzzleId, 80);
			const isNewBest = saveCompletionTime(puzzleId, 120);
			expect(isNewBest).toBe(false);
			expect(getStats(puzzleId)?.bestTime).toBe(80);
		});

		it('increments totalCompletions on each save', () => {
			saveCompletionTime(puzzleId, 100);
			saveCompletionTime(puzzleId, 90);
			saveCompletionTime(puzzleId, 110);
			expect(getStats(puzzleId)?.totalCompletions).toBe(3);
		});

		it('preserves original completedAt when time is not a new best', () => {
			saveCompletionTime(puzzleId, 80);
			const firstStats = getStats(puzzleId);
			saveCompletionTime(puzzleId, 120);
			const secondStats = getStats(puzzleId);
			expect(secondStats?.completedAt).toBe(firstStats?.completedAt);
		});

		it('returns correct isNewBest even when localStorage.setItem throws', () => {
			// Set up a previous best
			localStorage.setItem(
				`puzzle-stats-${puzzleId}`,
				JSON.stringify({
					puzzleId,
					bestTime: 100,
					completedAt: new Date().toISOString(),
					totalCompletions: 1
				})
			);

			// Make setItem throw
			vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
				throw new DOMException('QuotaExceededError');
			});

			// A new best time (faster) should still return true
			const result = saveCompletionTime(puzzleId, 50);
			expect(result).toBe(true);

			// Not a new best (slower) should still return false
			vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
				throw new DOMException('QuotaExceededError');
			});
			const result2 = saveCompletionTime(puzzleId, 200);
			expect(result2).toBe(false);
		});
	});

	describe('clearStats', () => {
		it('removes stats from localStorage', () => {
			saveCompletionTime(puzzleId, 100);
			clearStats(puzzleId);
			expect(getStats(puzzleId)).toBeNull();
		});

		it('does not throw when stats do not exist', () => {
			expect(() => clearStats('nonexistent-puzzle')).not.toThrow();
		});
	});
});
