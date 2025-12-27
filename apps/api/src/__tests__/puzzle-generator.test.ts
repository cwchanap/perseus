// Unit tests for puzzle generator
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import {
	generatePuzzle,
	ALLOWED_PIECE_COUNTS,
	isValidPieceCount
} from '../services/puzzle-generator';

const TEST_OUTPUT_DIR = join(tmpdir(), `perseus-puzzle-gen-tests-${process.pid}`);

// Create a simple test image buffer
async function createTestImage(width: number, height: number): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 128, g: 128, b: 128 }
		}
	})
		.jpeg()
		.toBuffer();
}

beforeAll(async () => {
	await rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
	await mkdir(TEST_OUTPUT_DIR, { recursive: true });
});

afterAll(async () => {
	await rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
});

describe('ALLOWED_PIECE_COUNTS', () => {
	it('should contain expected piece counts', () => {
		expect(ALLOWED_PIECE_COUNTS).toContain(9);
		expect(ALLOWED_PIECE_COUNTS).toContain(16);
		expect(ALLOWED_PIECE_COUNTS).toContain(25);
		expect(ALLOWED_PIECE_COUNTS).toContain(36);
		expect(ALLOWED_PIECE_COUNTS).toContain(49);
		expect(ALLOWED_PIECE_COUNTS).toContain(64);
		expect(ALLOWED_PIECE_COUNTS).toContain(100);
	});

	it('should only contain perfect squares', () => {
		for (const count of ALLOWED_PIECE_COUNTS) {
			const sqrt = Math.sqrt(count);
			expect(Number.isInteger(sqrt)).toBe(true);
		}
	});
});

describe('isValidPieceCount', () => {
	it('should return true for valid piece counts', () => {
		expect(isValidPieceCount(9)).toBe(true);
		expect(isValidPieceCount(16)).toBe(true);
		expect(isValidPieceCount(25)).toBe(true);
		expect(isValidPieceCount(36)).toBe(true);
		expect(isValidPieceCount(49)).toBe(true);
		expect(isValidPieceCount(64)).toBe(true);
		expect(isValidPieceCount(100)).toBe(true);
	});

	it('should return false for invalid piece counts', () => {
		expect(isValidPieceCount(0)).toBe(false);
		expect(isValidPieceCount(1)).toBe(false);
		expect(isValidPieceCount(10)).toBe(false);
		expect(isValidPieceCount(15)).toBe(false);
		expect(isValidPieceCount(50)).toBe(false);
		expect(isValidPieceCount(99)).toBe(false);
		expect(isValidPieceCount(101)).toBe(false);
		expect(isValidPieceCount(-1)).toBe(false);
	});
});

describe('generatePuzzle', () => {
	it('should throw error for invalid piece count', async () => {
		const imageBuffer = await createTestImage(300, 300);

		await expect(
			generatePuzzle({
				id: 'test-invalid',
				name: 'Test Puzzle',
				pieceCount: 10, // Invalid
				imageBuffer,
				outputDir: TEST_OUTPUT_DIR
			})
		).rejects.toThrow('Invalid piece count');
	});

	it('should generate puzzle with correct metadata for 9 pieces', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-9-pieces',
			name: 'Test 9 Pieces',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		expect(result.puzzle.id).toBe('test-9-pieces');
		expect(result.puzzle.name).toBe('Test 9 Pieces');
		expect(result.puzzle.pieceCount).toBe(9);
		expect(result.puzzle.gridCols).toBe(3);
		expect(result.puzzle.gridRows).toBe(3);
		expect(result.puzzle.pieces.length).toBe(9);
	});

	it('should generate puzzle with correct metadata for 16 pieces', async () => {
		const imageBuffer = await createTestImage(400, 400);

		const result = await generatePuzzle({
			id: 'test-16-pieces',
			name: 'Test 16 Pieces',
			pieceCount: 16,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		expect(result.puzzle.pieceCount).toBe(16);
		expect(result.puzzle.gridCols).toBe(4);
		expect(result.puzzle.gridRows).toBe(4);
		expect(result.puzzle.pieces.length).toBe(16);
	});

	it('should generate correct number of piece files', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-piece-files',
			name: 'Test Piece Files',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		expect(result.piecePaths.length).toBe(9);
	});

	it('should generate thumbnail', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-thumbnail',
			name: 'Test Thumbnail',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		expect(result.thumbnailPath).toContain('thumbnail.jpg');
	});

	it('should assign correct position to each piece', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-positions',
			name: 'Test Positions',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		// Check that all positions are assigned correctly
		const positions = new Set<string>();
		for (const piece of result.puzzle.pieces) {
			const posKey = `${piece.correctX},${piece.correctY}`;
			expect(positions.has(posKey)).toBe(false); // No duplicates
			positions.add(posKey);

			expect(piece.correctX).toBeGreaterThanOrEqual(0);
			expect(piece.correctX).toBeLessThan(3);
			expect(piece.correctY).toBeGreaterThanOrEqual(0);
			expect(piece.correctY).toBeLessThan(3);
		}

		expect(positions.size).toBe(9);
	});

	it('should assign piece IDs sequentially', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-ids',
			name: 'Test IDs',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		const ids = result.puzzle.pieces.map((p) => p.id).sort((a, b) => a - b);
		expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

describe('Edge type determination', () => {
	it('should assign flat edges to border pieces', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-border-edges',
			name: 'Test Border Edges',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		for (const piece of result.puzzle.pieces) {
			// Top row should have flat top
			if (piece.correctY === 0) {
				expect(piece.edges.top).toBe('flat');
			}
			// Bottom row should have flat bottom
			if (piece.correctY === 2) {
				expect(piece.edges.bottom).toBe('flat');
			}
			// Left column should have flat left
			if (piece.correctX === 0) {
				expect(piece.edges.left).toBe('flat');
			}
			// Right column should have flat right
			if (piece.correctX === 2) {
				expect(piece.edges.right).toBe('flat');
			}
		}
	});

	it('should assign non-flat edges to interior connections', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-interior-edges',
			name: 'Test Interior Edges',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		// Center piece (1,1) should have no flat edges
		const centerPiece = result.puzzle.pieces.find((p) => p.correctX === 1 && p.correctY === 1);

		expect(centerPiece).toBeDefined();
		expect(centerPiece!.edges.top).not.toBe('flat');
		expect(centerPiece!.edges.right).not.toBe('flat');
		expect(centerPiece!.edges.bottom).not.toBe('flat');
		expect(centerPiece!.edges.left).not.toBe('flat');
	});

	it('should have matching edges between adjacent pieces', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-matching-edges',
			name: 'Test Matching Edges',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		const pieces = result.puzzle.pieces;
		const getPiece = (x: number, y: number) =>
			pieces.find((p) => p.correctX === x && p.correctY === y);

		// Check horizontal adjacency (right edge of piece matches left edge of neighbor)
		for (let y = 0; y < 3; y++) {
			for (let x = 0; x < 2; x++) {
				const left = getPiece(x, y);
				const right = getPiece(x + 1, y);

				expect(left).toBeDefined();
				expect(right).toBeDefined();

				// If left has tab on right, right should have blank on left (and vice versa)
				if (left!.edges.right === 'tab') {
					expect(right!.edges.left).toBe('blank');
				} else if (left!.edges.right === 'blank') {
					expect(right!.edges.left).toBe('tab');
				}
			}
		}

		// Check vertical adjacency (bottom edge of piece matches top edge of neighbor)
		for (let y = 0; y < 2; y++) {
			for (let x = 0; x < 3; x++) {
				const top = getPiece(x, y);
				const bottom = getPiece(x, y + 1);

				expect(top).toBeDefined();
				expect(bottom).toBeDefined();

				// If top has tab on bottom, bottom should have blank on top (and vice versa)
				if (top!.edges.bottom === 'tab') {
					expect(bottom!.edges.top).toBe('blank');
				} else if (top!.edges.bottom === 'blank') {
					expect(bottom!.edges.top).toBe('tab');
				}
			}
		}
	});
});

describe('Image dimensions', () => {
	it('should preserve original image dimensions in metadata', async () => {
		const imageBuffer = await createTestImage(640, 480);

		const result = await generatePuzzle({
			id: 'test-dimensions',
			name: 'Test Dimensions',
			pieceCount: 16,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		expect(result.puzzle.imageWidth).toBe(640);
		expect(result.puzzle.imageHeight).toBe(480);
	});

	it('should handle non-square images', async () => {
		const imageBuffer = await createTestImage(800, 600);

		const result = await generatePuzzle({
			id: 'test-non-square',
			name: 'Test Non Square',
			pieceCount: 16,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		expect(result.puzzle.imageWidth).toBe(800);
		expect(result.puzzle.imageHeight).toBe(600);
		expect(result.puzzle.pieces.length).toBe(16);
	});
});

describe('Piece image paths', () => {
	it('should set correct image paths for pieces', async () => {
		const imageBuffer = await createTestImage(300, 300);

		const result = await generatePuzzle({
			id: 'test-paths',
			name: 'Test Paths',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		for (const piece of result.puzzle.pieces) {
			expect(piece.imagePath).toBe(`pieces/${piece.id}.png`);
		}
	});

	it('should set puzzleId on each piece', async () => {
		const imageBuffer = await createTestImage(300, 300);
		const puzzleId = 'test-puzzle-id-ref';

		const result = await generatePuzzle({
			id: puzzleId,
			name: 'Test Puzzle ID',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		for (const piece of result.puzzle.pieces) {
			expect(piece.puzzleId).toBe(puzzleId);
		}
	});
});

describe('createdAt timestamp', () => {
	it('should set createdAt to current time', async () => {
		const imageBuffer = await createTestImage(300, 300);
		const beforeTime = Date.now();

		const result = await generatePuzzle({
			id: 'test-timestamp',
			name: 'Test Timestamp',
			pieceCount: 9,
			imageBuffer,
			outputDir: TEST_OUTPUT_DIR
		});

		const afterTime = Date.now();

		expect(result.puzzle.createdAt).toBeGreaterThanOrEqual(beforeTime);
		expect(result.puzzle.createdAt).toBeLessThanOrEqual(afterTime);
	});
});
