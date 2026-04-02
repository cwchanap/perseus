// Unit tests for hint helper
import { describe, it, expect } from 'vitest';
import { getHintPieceId } from './hints';

describe('Hints Helper', () => {
	describe('getHintPieceId', () => {
		it('should return selected piece if unplaced', () => {
			const trayOrder = [0, 1, 2, 3, 4];
			const placedPieceIds = new Set([1, 3]);
			const selectedPieceId = 2;

			const result = getHintPieceId(trayOrder, placedPieceIds, selectedPieceId);
			expect(result).toBe(2);
		});

		it('should return first unplaced piece if selected is placed', () => {
			const trayOrder = [0, 1, 2, 3, 4];
			const placedPieceIds = new Set([0, 2]);
			const selectedPieceId = 0;

			const result = getHintPieceId(trayOrder, placedPieceIds, selectedPieceId);
			expect(result).toBe(1);
		});

		it('should return first unplaced piece if no selection', () => {
			const trayOrder = [5, 3, 1, 2, 4];
			const placedPieceIds = new Set([5, 3]);

			const result = getHintPieceId(trayOrder, placedPieceIds, null);
			expect(result).toBe(1);
		});

		it('should return null if all pieces are placed', () => {
			const trayOrder = [0, 1, 2];
			const placedPieceIds = new Set([0, 1, 2]);

			const result = getHintPieceId(trayOrder, placedPieceIds, null);
			expect(result).toBeNull();
		});

		it('should return null if all pieces placed even with selection', () => {
			const trayOrder = [0, 1, 2];
			const placedPieceIds = new Set([0, 1, 2]);
			const selectedPieceId = 1;

			const result = getHintPieceId(trayOrder, placedPieceIds, selectedPieceId);
			expect(result).toBeNull();
		});

		it('should handle empty tray', () => {
			const result = getHintPieceId([], new Set(), null);
			expect(result).toBeNull();
		});

		it('should respect tray order for first unplaced', () => {
			const trayOrder = [9, 2, 5, 1, 7];
			const placedPieceIds = new Set([9, 5]);

			const result = getHintPieceId(trayOrder, placedPieceIds, null);
			expect(result).toBe(2);
		});
	});
});
