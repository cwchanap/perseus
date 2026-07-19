import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Puzzle } from '../types/index';

let tempDir: string;
let storageModule: typeof import('./storage');
let savedOriginalDataDir: string | undefined;

function makePuzzle(id: string, overrides: Partial<Puzzle> = {}): Puzzle {
	return {
		id,
		name: `Puzzle ${id}`,
		pieceCount: 9,
		gridCols: 3,
		gridRows: 3,
		imageWidth: 300,
		imageHeight: 300,
		createdAt: Date.now(),
		pieces: [],
		...overrides
	};
}

beforeAll(async () => {
	savedOriginalDataDir = process.env.DATA_DIR;
	tempDir = await mkdtemp(join(tmpdir(), 'perseus-storage-idempotency-coverage-'));
	process.env.DATA_DIR = tempDir;
	vi.resetModules();
	storageModule = await import('./storage');
	await storageModule.initializeStorage();
});

afterAll(async () => {
	await rm(tempDir, { recursive: true, force: true });
	if (savedOriginalDataDir === undefined) {
		delete process.env.DATA_DIR;
	} else {
		process.env.DATA_DIR = savedOriginalDataDir;
	}
});

beforeEach(async () => {
	await rm(join(tempDir, 'puzzles'), { recursive: true, force: true });
	await rm(join(tempDir, 'idempotency'), { recursive: true, force: true });
	await storageModule.initializeStorage();
});

describe('filesystem idempotency coverage', () => {
	it('finds a legacy puzzle and publishes its durable reservation', async () => {
		await storageModule.createPuzzle(
			makePuzzle('legacy-puzzle', {
				idempotencyKey: 'legacy-key'
			})
		);

		const found = await storageModule.findPuzzleByIdempotencyKey('legacy-key');
		expect(found?.id).toBe('legacy-puzzle');

		const reservation = await storageModule.reserveIdempotencyKey('legacy-key', 'replacement');
		expect(reservation).toEqual({ existing: true, puzzleId: 'legacy-puzzle' });

		const fastPath = await storageModule.reserveIdempotencyKey('legacy-key', 'another-puzzle');
		expect(fastPath).toEqual({ existing: true, puzzleId: 'legacy-puzzle' });
	});

	it('serializes concurrent claims for the same idempotency key', async () => {
		const results = await Promise.all([
			storageModule.reserveIdempotencyKey('concurrent-key', 'puzzle-a'),
			storageModule.reserveIdempotencyKey('concurrent-key', 'puzzle-b')
		]);

		const winner = results.find((result) => !result.existing);
		const follower = results.find((result) => result.existing);
		expect(winner).toBeDefined();
		expect(follower).toBeDefined();
		expect(follower?.puzzleId).toBe(winner?.puzzleId);
	});

	it('skips corrupt and non-directory entries during the legacy scan', async () => {
		await writeFile(join(tempDir, 'puzzles', 'not-a-directory'), 'ignored');
		const corruptDir = join(tempDir, 'puzzles', 'corrupt-puzzle');
		await mkdir(corruptDir, { recursive: true });
		await writeFile(join(corruptDir, 'metadata.json'), 'not-json');
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const found = await storageModule.findPuzzleByIdempotencyKey('missing-key');

		expect(found).toBeNull();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipping corrupt puzzle entry 'corrupt-puzzle'"),
			expect.any(Error)
		);
		consoleSpy.mockRestore();
	});

	it('returns null immediately for an empty legacy lookup key', async () => {
		await expect(storageModule.findPuzzleByIdempotencyKey('')).resolves.toBeNull();
	});

	it('rejects invalid reservation inputs', async () => {
		await expect(storageModule.reserveIdempotencyKey('', 'puzzle-1')).rejects.toThrow(
			'Invalid idempotency key'
		);
		await expect(storageModule.reserveIdempotencyKey('bad key', 'puzzle-1')).rejects.toThrow(
			'Invalid idempotency key'
		);
		await expect(storageModule.reserveIdempotencyKey('valid-key', '')).rejects.toThrow(
			'proposedPuzzleId is required'
		);
	});

	it('treats invalid or already-missing releases as no-ops', async () => {
		await expect(
			storageModule.releaseIdempotencyKey('bad key', 'puzzle-1')
		).resolves.toBeUndefined();
		await expect(storageModule.releaseIdempotencyKey('valid-key', '')).resolves.toBeUndefined();
		await expect(
			storageModule.releaseIdempotencyKey('missing-reservation', 'puzzle-1')
		).resolves.toBeUndefined();
	});
});
