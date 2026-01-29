import { describe, it, expect } from 'vitest';
import {
	TAB_RATIO,
	EXPANSION_FACTOR,
	MAX_IMAGE_DIMENSION,
	MAX_PIECES,
	DEFAULT_PIECE_COUNT,
	THUMBNAIL_SIZE
} from './types';

describe('Puzzle constants', () => {
	it('should have correct TAB_RATIO value', () => {
		expect(TAB_RATIO).toBe(0.2);
	});

	it('should have correct EXPANSION_FACTOR based on TAB_RATIO', () => {
		const expected = 1 + 2 * TAB_RATIO;
		expect(EXPANSION_FACTOR).toBe(expected);
		expect(EXPANSION_FACTOR).toBe(1.4);
	});

	it('should have correct MAX_IMAGE_DIMENSION', () => {
		expect(MAX_IMAGE_DIMENSION).toBe(4096);
	});

	it('should have correct MAX_PIECES', () => {
		expect(MAX_PIECES).toBe(250);
	});

	it('should have correct DEFAULT_PIECE_COUNT', () => {
		expect(DEFAULT_PIECE_COUNT).toBe(225);
		// 225 is 15x15 grid
		expect(Math.sqrt(DEFAULT_PIECE_COUNT)).toBe(15);
	});

	it('should have correct THUMBNAIL_SIZE', () => {
		expect(THUMBNAIL_SIZE).toBe(300);
	});

	it('should have DEFAULT_PIECE_COUNT within MAX_PIECES limit', () => {
		expect(DEFAULT_PIECE_COUNT).toBeLessThanOrEqual(MAX_PIECES);
	});
});
