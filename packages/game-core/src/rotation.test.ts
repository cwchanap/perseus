// Unit tests for rotation helper
import { describe, it, expect } from 'vitest';
import {
	type Rotation,
	normalizeRotation,
	rotateClockwise,
	rotateCounterClockwise,
	isUpright,
	generateRandomRotations
} from './rotation';

describe('Rotation Helper', () => {
	describe('normalizeRotation', () => {
		it('should keep valid rotations unchanged', () => {
			expect(normalizeRotation(0)).toBe(0);
			expect(normalizeRotation(90)).toBe(90);
			expect(normalizeRotation(180)).toBe(180);
			expect(normalizeRotation(270)).toBe(270);
		});

		it('should normalize 360 to 0', () => {
			expect(normalizeRotation(360)).toBe(0);
		});

		it('should normalize negative values', () => {
			expect(normalizeRotation(-90)).toBe(270);
			expect(normalizeRotation(-180)).toBe(180);
			expect(normalizeRotation(-270)).toBe(90);
		});

		it('should normalize values beyond 360', () => {
			expect(normalizeRotation(450)).toBe(90);
			expect(normalizeRotation(720)).toBe(0);
		});

		it('should normalize arbitrary angles to nearest 90deg', () => {
			expect(normalizeRotation(45)).toBe(0);
			expect(normalizeRotation(135)).toBe(90);
			expect(normalizeRotation(225)).toBe(180);
			expect(normalizeRotation(315)).toBe(270);
		});
	});

	describe('rotateClockwise', () => {
		it('should rotate 0 -> 90', () => {
			expect(rotateClockwise(0)).toBe(90);
		});

		it('should rotate 90 -> 180', () => {
			expect(rotateClockwise(90)).toBe(180);
		});

		it('should rotate 180 -> 270', () => {
			expect(rotateClockwise(180)).toBe(270);
		});

		it('should rotate 270 -> 0', () => {
			expect(rotateClockwise(270)).toBe(0);
		});
	});

	describe('rotateCounterClockwise', () => {
		it('should rotate 0 -> 270', () => {
			expect(rotateCounterClockwise(0)).toBe(270);
		});

		it('should rotate 270 -> 180', () => {
			expect(rotateCounterClockwise(270)).toBe(180);
		});

		it('should rotate 180 -> 90', () => {
			expect(rotateCounterClockwise(180)).toBe(90);
		});

		it('should rotate 90 -> 0', () => {
			expect(rotateCounterClockwise(90)).toBe(0);
		});
	});

	describe('isUpright', () => {
		it('should return true for 0 degrees', () => {
			expect(isUpright(0)).toBe(true);
		});

		it('should return false for non-zero rotations', () => {
			expect(isUpright(90)).toBe(false);
			expect(isUpright(180)).toBe(false);
			expect(isUpright(270)).toBe(false);
		});
	});

	describe('generateRandomRotations', () => {
		it('should generate rotations for all piece IDs', () => {
			const pieceIds = [0, 1, 2, 3];
			const rotations = generateRandomRotations(pieceIds);

			expect(Object.keys(rotations).length).toBe(4);
			expect(rotations[0]).toBeDefined();
			expect(rotations[3]).toBeDefined();
		});

		it('should only contain valid rotation values', () => {
			const pieceIds = [0, 1, 2, 3, 4, 5];
			const rotations = generateRandomRotations(pieceIds);
			const validRotations: Rotation[] = [0, 90, 180, 270];

			Object.values(rotations).forEach((rotation) => {
				expect(validRotations).toContain(rotation);
			});
		});

		it('should use seed for deterministic output', () => {
			const pieceIds = [0, 1, 2, 3, 4];
			const rotations1 = generateRandomRotations(pieceIds, 12345);
			const rotations2 = generateRandomRotations(pieceIds, 12345);

			expect(rotations1).toEqual(rotations2);
		});

		it('should produce different results with different seeds', () => {
			const pieceIds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
			const rotations1 = generateRandomRotations(pieceIds, 111);
			const rotations2 = generateRandomRotations(pieceIds, 222);

			expect(rotations1).not.toEqual(rotations2);
		});

		it('should handle empty array', () => {
			const rotations = generateRandomRotations([]);
			expect(rotations).toEqual({});
		});

		it('should only produce valid rotations with any seed', () => {
			const validRotations: Rotation[] = [0, 90, 180, 270];
			const pieceIds = Array.from({ length: 100 }, (_, i) => i);

			// Test a wide range of seeds to catch normalization bugs
			// (dividing by 2^31 instead of 2^32 causes ~half the indices to be out of range)
			const seeds = [0, 1, 42, 12345, 999999, 2147483647, -1, -42];
			for (const seed of seeds) {
				const rotations = generateRandomRotations(pieceIds, seed);
				for (const [_id, rotation] of Object.entries(rotations)) {
					expect(validRotations).toContain(rotation);
				}
			}
		});

		it('should distribute seeded rotations across all four values', () => {
			const pieceIds = Array.from({ length: 200 }, (_, i) => i);
			const rotations = generateRandomRotations(pieceIds, 42);
			const counts: Record<number, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };

			for (const rotation of Object.values(rotations)) {
				counts[rotation]++;
			}

			// Each rotation value should appear at least once in 200 pieces
			expect(counts[0]).toBeGreaterThan(0);
			expect(counts[90]).toBeGreaterThan(0);
			expect(counts[180]).toBeGreaterThan(0);
			expect(counts[270]).toBeGreaterThan(0);
		});
	});
});
