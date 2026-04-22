import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getProgress, saveProgress, clearProgress } from '../progress';

describe('Progress Service - error handling', () => {
	const puzzleId = 'test-progress-err-456';

	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('getProgress - localStorage errors', () => {
		it('returns null when localStorage.getItem throws', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
				throw new DOMException('SecurityError: access denied');
			});

			const result = getProgress(puzzleId);

			expect(result).toBeNull();
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('returns null and logs error when stored JSON is invalid', () => {
			localStorage.setItem(`puzzle-progress-${puzzleId}`, 'not-valid-json{{{');
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = getProgress(puzzleId);

			expect(result).toBeNull();
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('returns null when localStorage.getItem throws a generic Error', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
				throw new Error('Unexpected storage error');
			});

			const result = getProgress(puzzleId);

			expect(result).toBeNull();
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(puzzleId), expect.any(Error));
		});
	});

	describe('saveProgress - localStorage errors', () => {
		it('does not throw when localStorage.setItem throws QuotaExceededError', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
				throw new DOMException('QuotaExceededError');
			});

			expect(() => saveProgress(puzzleId, [])).not.toThrow();
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('does not throw when localStorage.setItem throws a generic Error', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
				throw new Error('Storage unavailable');
			});

			expect(() => saveProgress(puzzleId, [], true, {})).not.toThrow();
			expect(consoleSpy).toHaveBeenCalledWith('Failed to save puzzle progress:', expect.any(Error));
		});
	});

	describe('clearProgress - localStorage errors', () => {
		it('does not throw when localStorage.removeItem throws', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
				throw new DOMException('SecurityError');
			});

			expect(() => clearProgress(puzzleId)).not.toThrow();
			expect(consoleSpy).toHaveBeenCalledWith(
				'Failed to clear puzzle progress:',
				expect.any(DOMException)
			);
		});

		it('does not throw when localStorage.removeItem throws a generic Error', () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
				throw new Error('Cannot remove');
			});

			expect(() => clearProgress(puzzleId)).not.toThrow();
			expect(consoleSpy).toHaveBeenCalled();
		});
	});
});
