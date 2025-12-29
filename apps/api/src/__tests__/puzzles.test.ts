// Unit tests for puzzle API endpoints
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import type { PuzzleListResponse, PuzzleSummary, ErrorResponse } from '../types/index';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DATA_DIR = join(tmpdir(), `perseus-api-tests-${process.pid}`);
const TEST_PUZZLES_DIR = join(TEST_DATA_DIR, 'puzzles');

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ADMIN_PASSKEY = 'test-admin-passkey';

let app: typeof import('../index').default;

async function seedPuzzle(puzzleId: string): Promise<void> {
	const puzzleDir = join(TEST_PUZZLES_DIR, puzzleId);
	await mkdir(join(puzzleDir, 'pieces'), { recursive: true });
	await writeFile(
		join(puzzleDir, 'metadata.json'),
		JSON.stringify(
			{
				id: puzzleId,
				name: 'Test Puzzle',
				pieceCount: 9,
				gridCols: 3,
				gridRows: 3,
				imageWidth: 300,
				imageHeight: 300,
				createdAt: Date.now(),
				pieces: []
			},
			null,
			2
		),
		'utf-8'
	);
}

beforeAll(async () => {
	await rm(TEST_DATA_DIR, { recursive: true, force: true });
	await mkdir(TEST_PUZZLES_DIR, { recursive: true });

	app = (await import('../index')).default;
});

beforeEach(async () => {
	await rm(TEST_PUZZLES_DIR, { recursive: true, force: true });
	await mkdir(TEST_PUZZLES_DIR, { recursive: true });
});

afterAll(async () => {
	await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('GET /api/puzzles', () => {
	it('should return empty array when no puzzles exist', async () => {
		const response = await app.fetch(new Request('http://localhost/api/puzzles'));
		expect(response.status).toBe(200);

		const data = (await response.json()) as PuzzleListResponse;
		expect(data).toHaveProperty('puzzles');
		expect(Array.isArray(data.puzzles)).toBe(true);
		expect(data.puzzles.length).toBe(0);
	});

	it('should return puzzles array with correct structure', async () => {
		await seedPuzzle('test-puzzle-1');

		const response = await app.fetch(new Request('http://localhost/api/puzzles'));
		expect(response.status).toBe(200);

		const data = (await response.json()) as PuzzleListResponse;
		expect(data.puzzles).toBeDefined();
		expect(Array.isArray(data.puzzles)).toBe(true);
		expect(data.puzzles.length).toBeGreaterThan(0);
		expect(data.puzzles.length).toBe(1);
		// Each puzzle should have id, name, pieceCount
		for (const puzzle of data.puzzles as PuzzleSummary[]) {
			expect(puzzle).toHaveProperty('id');
			expect(puzzle).toHaveProperty('name');
			expect(puzzle).toHaveProperty('pieceCount');
		}
	});
});

describe('GET /api/puzzles/:id', () => {
	it('should return 404 for non-existent puzzle', async () => {
		const response = await app.fetch(new Request('http://localhost/api/puzzles/non-existent-id'));
		expect(response.status).toBe(404);

		const data = (await response.json()) as ErrorResponse;
		expect(data.error).toBe('not_found');
	});
});

describe('GET /api/puzzles/:id/thumbnail', () => {
	it('should return 404 for non-existent puzzle thumbnail', async () => {
		const response = await app.fetch(
			new Request('http://localhost/api/puzzles/non-existent-id/thumbnail')
		);
		expect(response.status).toBe(404);
	});
});

describe('GET /api/puzzles/:id/pieces/:pieceId/image', () => {
	it('should return 404 for non-existent puzzle piece', async () => {
		const response = await app.fetch(
			new Request('http://localhost/api/puzzles/non-existent-id/pieces/0/image')
		);
		expect(response.status).toBe(404);
	});

	it('should return 400 for invalid piece ID', async () => {
		const response = await app.fetch(
			new Request('http://localhost/api/puzzles/some-id/pieces/invalid/image')
		);
		expect(response.status).toBe(400);
	});

	it('should return 400 for negative piece ID', async () => {
		const response = await app.fetch(
			new Request('http://localhost/api/puzzles/some-id/pieces/-1/image')
		);
		expect(response.status).toBe(400);
	});
});
