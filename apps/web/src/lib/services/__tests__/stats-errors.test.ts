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
		it('returns null and logs when localStorage.getItem throws a non-SyntaxError', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
				throw new DOMException('SecurityError: access denied');
			});

			const result = getStats(puzzleId);

			expect(result).toBeNull();
			expect(consoleSpy).toHaveBeenCalledWith(
				'Failed to read puzzle stats from localStorage:',
				expect.any(DOMException)
			);
		});

		it('returns null when localStorage.getItem throws a generic Error', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
				throw new Error('Unexpected error');
			});

			const result = getStats(puzzleId);

			expect(result).toBeNull();
			expect(consoleSpy).toHaveBeenCalledWith(
				'Failed to read puzzle stats from localStorage:',
				expect.any(Error)
			);
		});
	});

	describe('getStats - SyntaxError with cleanup failure', () => {
		it('still returns null when SyntaxError occurs but removeItem also throws', () => {
			localStorage.setItem(`puzzle-stats-${puzzleId}`, 'invalid json{{{');
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
				throw new Error('Cannot remove item');
			});

			const result = getStats(puzzleId);

			expect(result).toBeNull();
			expect(consoleSpy).toHaveBeenCalledWith(
				'Failed to parse puzzle stats from localStorage:',
				expect.any(SyntaxError)
			);
		});
	});

	describe('clearStats - localStorage errors', () => {
		it('does not throw when localStorage.removeItem throws', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
				throw new DOMException('SecurityError');
			});

			expect(() => clearStats(puzzleId)).not.toThrow();
			expect(consoleSpy).toHaveBeenCalledWith(
				'Failed to clear puzzle stats:',
				expect.any(DOMException)
			);
		});

		it('does not throw when localStorage.removeItem throws a generic Error', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
				throw new Error('Storage unavailable');
			});

			expect(() => clearStats(puzzleId)).not.toThrow();
			expect(consoleSpy).toHaveBeenCalled();
		});
	});
});
