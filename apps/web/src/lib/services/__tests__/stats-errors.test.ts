import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getStats, clearStats } from '../stats';

describe('Stats Service - error handling', () => {
	const puzzleId = 'test-stats-err-789';

	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('getStats - non-SyntaxError from localStorage', () => {
		it('returns null when localStorage.getItem throws a DOMException (non-SyntaxError path)', () => {
			vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
				throw new DOMException('access denied', 'SecurityError');
			});

			expect(getStats(puzzleId)).toBeNull();
		});

		it('returns null when localStorage.getItem throws a generic Error', () => {
			vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
				throw new Error('Unexpected error');
			});

			expect(getStats(puzzleId)).toBeNull();
		});
	});

	describe('getStats - SyntaxError with cleanup failure', () => {
		it('still returns null when SyntaxError occurs but removeItem also throws', () => {
			localStorage.setItem(`puzzle-stats-${puzzleId}`, 'invalid json{{{');
			vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
				throw new Error('Cannot remove item');
			});

			expect(getStats(puzzleId)).toBeNull();
		});
	});

	describe('clearStats - localStorage errors', () => {
		it('does not throw when localStorage.removeItem throws a DOMException', () => {
			vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
				throw new DOMException('access denied', 'SecurityError');
			});

			expect(() => clearStats(puzzleId)).not.toThrow();
		});

		it('does not throw when localStorage.removeItem throws a generic Error', () => {
			vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
				throw new Error('Storage unavailable');
			});

			expect(() => clearStats(puzzleId)).not.toThrow();
		});
	});
});
