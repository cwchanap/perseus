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
			vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
				throw new Error('Unexpected storage error');
			});

			expect(getProgress(puzzleId)).toBeNull();
		});

		it('returns null when stored JSON is invalid', () => {
			localStorage.setItem(`puzzle-progress-${puzzleId}`, 'not-valid-json{{{');

			expect(getProgress(puzzleId)).toBeNull();
		});

		it('returns null when localStorage.getItem throws a DOMException', () => {
			vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
				throw new DOMException('SecurityError: access denied');
			});

			expect(getProgress(puzzleId)).toBeNull();
		});
	});

	describe('saveProgress - localStorage errors', () => {
		it('does not throw when localStorage.setItem throws QuotaExceededError', () => {
			vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
				throw new DOMException('QuotaExceededError');
			});

			expect(() => saveProgress(puzzleId, [])).not.toThrow();
		});

		it('does not throw when localStorage.setItem throws a generic Error', () => {
			vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
				throw new Error('Storage unavailable');
			});

			expect(() => saveProgress(puzzleId, [], true, {})).not.toThrow();
		});
	});

	describe('clearProgress - localStorage errors', () => {
		it('does not throw when localStorage.removeItem throws a DOMException', () => {
			vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
				throw new DOMException('SecurityError');
			});

			expect(() => clearProgress(puzzleId)).not.toThrow();
		});

		it('does not throw when localStorage.removeItem throws a generic Error', () => {
			vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
				throw new Error('Cannot remove');
			});

			expect(() => clearProgress(puzzleId)).not.toThrow();
		});
	});
});
