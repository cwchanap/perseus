// Unit tests for shuffle utility
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shuffleArray } from '../shuffle';

describe('shuffleArray', () => {
	it('should return an array of the same length', () => {
		const input = [1, 2, 3, 4, 5];
		const result = shuffleArray(input);

		expect(result.length).toBe(input.length);
	});

	it('should contain all original elements', () => {
		const input = [1, 2, 3, 4, 5];
		const result = shuffleArray(input);

		expect(result.sort()).toEqual(input.sort());
	});

	it('should not modify the original array', () => {
		const input = [1, 2, 3, 4, 5];
		const originalCopy = [...input];

		shuffleArray(input);

		expect(input).toEqual(originalCopy);
	});

	it('should return a new array instance', () => {
		const input = [1, 2, 3, 4, 5];
		const result = shuffleArray(input);

		expect(result).not.toBe(input);
	});

	it('should handle empty array', () => {
		const input: number[] = [];
		const result = shuffleArray(input);

		expect(result).toEqual([]);
	});

	it('should handle single element array', () => {
		const input = [42];
		const result = shuffleArray(input);

		expect(result).toEqual([42]);
	});

	it('should handle array with duplicate values', () => {
		const input = [1, 1, 2, 2, 3, 3];
		const result = shuffleArray(input);

		expect(result.length).toBe(input.length);
		expect(result.sort()).toEqual(input.sort());
	});

	it('should work with different types', () => {
		const stringInput = ['a', 'b', 'c', 'd'];
		const stringResult = shuffleArray(stringInput);
		expect(stringResult.sort()).toEqual(stringInput.sort());

		const objectInput = [{ id: 1 }, { id: 2 }, { id: 3 }];
		const objectResult = shuffleArray(objectInput);
		expect(objectResult.length).toBe(objectInput.length);
		// Check all objects are present (by reference)
		for (const obj of objectInput) {
			expect(objectResult).toContain(obj);
		}
	});

	describe('randomness verification', () => {
		let originalRandom: () => number;

		beforeEach(() => {
			originalRandom = Math.random;
		});

		afterEach(() => {
			Math.random = originalRandom;
		});

		it('should use Math.random for shuffling', () => {
			const mockRandom = vi.fn(() => 0.5);
			Math.random = mockRandom;

			shuffleArray([1, 2, 3, 4, 5]);

			expect(mockRandom).toHaveBeenCalled();
		});

		it('should produce deterministic results with seeded random', () => {
			// Mock Math.random to return predictable sequence
			let callCount = 0;
			const sequence = [0.1, 0.9, 0.5, 0.3, 0.7];
			Math.random = () => sequence[callCount++ % sequence.length];

			const result1 = shuffleArray([1, 2, 3, 4, 5]);

			// Reset counter
			callCount = 0;
			const result2 = shuffleArray([1, 2, 3, 4, 5]);

			expect(result1).toEqual(result2);
		});
	});

	describe('distribution test', () => {
		it('should produce different orderings over multiple runs', () => {
			const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
			const results = new Set<string>();

			// Run shuffle 50 times and collect unique results
			for (let i = 0; i < 50; i++) {
				const result = shuffleArray(input);
				results.add(JSON.stringify(result));
			}

			// With 10 elements, we should get multiple different orderings
			// The probability of getting the same order twice in 50 runs is extremely low
			expect(results.size).toBeGreaterThan(1);
		});

		it('should not always return the same first element', () => {
			const input = [1, 2, 3, 4, 5];
			const firstElements = new Set<number>();

			// Run shuffle 30 times
			for (let i = 0; i < 30; i++) {
				const result = shuffleArray(input);
				firstElements.add(result[0]);
			}

			// Should have multiple different first elements
			expect(firstElements.size).toBeGreaterThan(1);
		});
	});
});
