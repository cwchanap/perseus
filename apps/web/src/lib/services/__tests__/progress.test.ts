// Unit tests for progress service
import { describe, it, expect, beforeEach } from 'vitest';
import { getProgress, saveProgress, clearProgress, hasProgress } from '../progress';
import type { PlacedPiece } from '$lib/types/puzzle';

describe('Progress Service', () => {
  const puzzleId = 'test-puzzle-123';

  beforeEach(() => {
    localStorage.clear();
  });

  describe('getProgress', () => {
    it('should return null when no progress exists', () => {
      const result = getProgress(puzzleId);
      expect(result).toBeNull();
    });

    it('should return saved progress', () => {
      const placedPieces: PlacedPiece[] = [{ pieceId: 0, x: 0, y: 0 }];
      saveProgress(puzzleId, placedPieces);

      const result = getProgress(puzzleId);
      expect(result).not.toBeNull();
      expect(result?.puzzleId).toBe(puzzleId);
      expect(result?.placedPieces).toEqual(placedPieces);
    });
  });

  describe('saveProgress', () => {
    it('should save progress to localStorage', () => {
      const placedPieces: PlacedPiece[] = [
        { pieceId: 0, x: 0, y: 0 },
        { pieceId: 1, x: 1, y: 0 }
      ];

      saveProgress(puzzleId, placedPieces);

      const result = getProgress(puzzleId);
      expect(result?.placedPieces).toHaveLength(2);
    });

    it('should include lastUpdated timestamp', () => {
      saveProgress(puzzleId, []);

      const result = getProgress(puzzleId);
      expect(result?.lastUpdated).toBeDefined();
      expect(new Date(result!.lastUpdated).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('clearProgress', () => {
    it('should remove progress from localStorage', () => {
      saveProgress(puzzleId, [{ pieceId: 0, x: 0, y: 0 }]);
      expect(hasProgress(puzzleId)).toBe(true);

      clearProgress(puzzleId);
      expect(hasProgress(puzzleId)).toBe(false);
    });
  });

  describe('hasProgress', () => {
    it('should return false when no progress exists', () => {
      expect(hasProgress(puzzleId)).toBe(false);
    });

    it('should return true when progress exists', () => {
      saveProgress(puzzleId, []);
      expect(hasProgress(puzzleId)).toBe(true);
    });
  });
});
