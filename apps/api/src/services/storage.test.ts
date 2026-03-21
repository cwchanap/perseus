import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Puzzle } from '../types/index';

// storage.ts reads DATA_DIR at module load time.
// We set it before the dynamic import so it points to a temp directory.
let tempDir: string;
let storageModule: typeof import('./storage');
let savedOriginalDataDir: string | undefined;

beforeAll(async () => {
	savedOriginalDataDir = process.env.DATA_DIR;
	tempDir = await mkdtemp(join(tmpdir(), 'perseus-storage-test-'));
	process.env.DATA_DIR = tempDir;
	// Dynamic import so DATA_DIR is set before the module initializes
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

// ─── isValidPuzzleId (via resolvePuzzlePath) ──────────────────────────────────

describe('InvalidPuzzleIdError', () => {
	it('is thrown for an empty id', async () => {
		const { InvalidPuzzleIdError, getPuzzleDir } = storageModule;
		expect(() => getPuzzleDir('')).toThrow(InvalidPuzzleIdError);
	});

	it('is thrown for an id that is too long (>128 chars)', async () => {
		const { InvalidPuzzleIdError, getPuzzleDir } = storageModule;
		expect(() => getPuzzleDir('a'.repeat(129))).toThrow(InvalidPuzzleIdError);
	});

	it('is thrown for ids with path traversal characters', async () => {
		const { InvalidPuzzleIdError, getPuzzleDir } = storageModule;
		expect(() => getPuzzleDir('../evil')).toThrow(InvalidPuzzleIdError);
		expect(() => getPuzzleDir('foo/../bar')).toThrow(InvalidPuzzleIdError);
	});

	it('is thrown for ids with spaces', async () => {
		const { InvalidPuzzleIdError, getPuzzleDir } = storageModule;
		expect(() => getPuzzleDir('hello world')).toThrow(InvalidPuzzleIdError);
	});

	it('accepts valid alphanumeric ids', () => {
		const { getPuzzleDir } = storageModule;
		expect(() => getPuzzleDir('valid-puzzle-1')).not.toThrow();
		expect(() => getPuzzleDir('puzzle_abc123')).not.toThrow();
	});
});

// ─── Path helpers ─────────────────────────────────────────────────────────────

describe('path helpers', () => {
	it('getPuzzleDir returns a path ending in the puzzle id', () => {
		const { getPuzzleDir } = storageModule;
		const path = getPuzzleDir('my-puzzle');
		expect(path.endsWith('my-puzzle')).toBe(true);
	});

	it('getPiecesDir returns a path ending in pieces/', () => {
		const { getPiecesDir } = storageModule;
		const path = getPiecesDir('my-puzzle');
		expect(path.endsWith('pieces')).toBe(true);
	});

	it('getOriginalImagePath returns a path ending in original.jpg', () => {
		const { getOriginalImagePath } = storageModule;
		const path = getOriginalImagePath('my-puzzle');
		expect(path.endsWith('original.jpg')).toBe(true);
	});

	it('getThumbnailPath returns a path ending in thumbnail.jpg', () => {
		const { getThumbnailPath } = storageModule;
		const path = getThumbnailPath('my-puzzle');
		expect(path.endsWith('thumbnail.jpg')).toBe(true);
	});

	it('getPieceImagePath returns correct filename for piece id', () => {
		const { getPieceImagePath } = storageModule;
		const path = getPieceImagePath('my-puzzle', 42);
		expect(path.endsWith('42.png')).toBe(true);
	});
});

// ─── puzzleExists ─────────────────────────────────────────────────────────────

describe('puzzleExists', () => {
	it('returns false for a puzzle that has never been created', async () => {
		const { puzzleExists } = storageModule;
		expect(await puzzleExists('nonexistent-puzzle')).toBe(false);
	});

	it('returns true after a puzzle is created', async () => {
		const { createPuzzle, puzzleExists } = storageModule;
		const puzzle = makePuzzle('exists-test-1');
		await createPuzzle(puzzle);
		expect(await puzzleExists('exists-test-1')).toBe(true);
	});
});

// ─── createPuzzle ─────────────────────────────────────────────────────────────

describe('createPuzzle', () => {
	it('returns true and creates the puzzle', async () => {
		const { createPuzzle, puzzleExists } = storageModule;
		const puzzle = makePuzzle('create-test-1');
		const result = await createPuzzle(puzzle);
		expect(result).toBe(true);
		expect(await puzzleExists('create-test-1')).toBe(true);
	});

	it('returns false if the puzzle already exists', async () => {
		const { createPuzzle } = storageModule;
		const puzzle = makePuzzle('create-duplicate');
		await createPuzzle(puzzle);
		const result = await createPuzzle(puzzle);
		expect(result).toBe(false);
	});

	it('returns false for an invalid puzzle id', async () => {
		const { createPuzzle } = storageModule;
		const puzzle = makePuzzle('../evil');
		const result = await createPuzzle(puzzle);
		expect(result).toBe(false);
	});
});

// ─── getPuzzle ────────────────────────────────────────────────────────────────

describe('getPuzzle', () => {
	it('returns null for a nonexistent puzzle', async () => {
		const { getPuzzle } = storageModule;
		expect(await getPuzzle('never-created')).toBeNull();
	});

	it('returns the puzzle data that was created', async () => {
		const { createPuzzle, getPuzzle } = storageModule;
		const puzzle = makePuzzle('get-test-1', { name: 'My Great Puzzle', pieceCount: 16 });
		await createPuzzle(puzzle);
		const retrieved = await getPuzzle('get-test-1');
		expect(retrieved).not.toBeNull();
		expect(retrieved?.name).toBe('My Great Puzzle');
		expect(retrieved?.pieceCount).toBe(16);
	});

	it('returns null for an invalid puzzle id', async () => {
		const { getPuzzle } = storageModule;
		expect(await getPuzzle('../evil')).toBeNull();
	});

	it('normalises createdAt to a number even if stored as string', async () => {
		const { createPuzzle, getPuzzle, getPuzzleDir } = storageModule;
		const puzzle = makePuzzle('get-date-test', { createdAt: 1700000000000 });
		await createPuzzle(puzzle);

		// Overwrite the metadata file so createdAt is a JSON string instead of a number,
		// exercising the `new Date(parsed.createdAt).getTime()` branch in getPuzzle.
		const metadataPath = join(getPuzzleDir('get-date-test'), 'metadata.json');
		const raw = JSON.parse(await readFile(metadataPath, 'utf-8')) as Record<string, unknown>;
		raw.createdAt = '2023-11-15T00:00:00.000Z'; // ISO string representation
		await writeFile(metadataPath, JSON.stringify(raw), 'utf-8');

		const retrieved = await getPuzzle('get-date-test');
		expect(typeof retrieved?.createdAt).toBe('number');
		expect(retrieved?.createdAt).toBe(new Date('2023-11-15T00:00:00.000Z').getTime());
	});
});

// ─── updatePuzzle ─────────────────────────────────────────────────────────────

describe('updatePuzzle', () => {
	it('returns false for a puzzle that does not exist', async () => {
		const { updatePuzzle } = storageModule;
		const puzzle = makePuzzle('update-missing');
		expect(await updatePuzzle(puzzle)).toBe(false);
	});

	it('returns true and persists changes', async () => {
		const { createPuzzle, updatePuzzle, getPuzzle } = storageModule;
		const puzzle = makePuzzle('update-test-1');
		await createPuzzle(puzzle);

		const updated = { ...puzzle, name: 'Updated Name' };
		const result = await updatePuzzle(updated);
		expect(result).toBe(true);

		const retrieved = await getPuzzle('update-test-1');
		expect(retrieved?.name).toBe('Updated Name');
	});

	it('returns false for an invalid puzzle id', async () => {
		const { updatePuzzle } = storageModule;
		const puzzle = makePuzzle('../evil');
		expect(await updatePuzzle(puzzle)).toBe(false);
	});
});

// ─── deletePuzzle ─────────────────────────────────────────────────────────────

describe('deletePuzzle', () => {
	it('returns false when the puzzle does not exist', async () => {
		const { deletePuzzle } = storageModule;
		expect(await deletePuzzle('delete-nonexistent')).toBe(false);
	});

	it('returns true and removes the puzzle', async () => {
		const { createPuzzle, deletePuzzle, puzzleExists } = storageModule;
		const puzzle = makePuzzle('delete-test-1');
		await createPuzzle(puzzle);
		expect(await puzzleExists('delete-test-1')).toBe(true);

		const result = await deletePuzzle('delete-test-1');
		expect(result).toBe(true);
		expect(await puzzleExists('delete-test-1')).toBe(false);
	});
});

// ─── listPuzzles / listPuzzlesSorted ──────────────────────────────────────────

describe('listPuzzles and listPuzzlesSorted', () => {
	// Use a fresh storage module import with a dedicated sub-dir to avoid
	// interference from other tests creating puzzles in the same temp dir.
	let listModule: typeof import('./storage');
	let listTempDir: string;

	beforeAll(async () => {
		listTempDir = await mkdtemp(join(tmpdir(), 'perseus-list-test-'));
		const prevDataDir = process.env.DATA_DIR;
		process.env.DATA_DIR = listTempDir;
		// Force a fresh module with the new DATA_DIR
		listModule = await import('./storage?list-test');
		await listModule.initializeStorage();
		process.env.DATA_DIR = prevDataDir;
	});

	afterAll(async () => {
		await rm(listTempDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		// Clean up by removing and re-initialising puzzles dir
		const { rm: rmFs } = await import('node:fs/promises');
		const { join: joinPath } = await import('node:path');
		await rmFs(joinPath(listTempDir, 'puzzles'), { recursive: true, force: true });
		await listModule.initializeStorage();
	});

	it('listPuzzles returns empty array when no puzzles exist', async () => {
		const result = await listModule.listPuzzles();
		expect(result).toEqual([]);
	});

	it('listPuzzles returns summaries of created puzzles', async () => {
		await listModule.createPuzzle(makePuzzle('list-a', { name: 'Alpha' }));
		await listModule.createPuzzle(makePuzzle('list-b', { name: 'Beta' }));
		const result = await listModule.listPuzzles();
		expect(result).toHaveLength(2);
		const names = result.map((p) => p.name).sort();
		expect(names).toEqual(['Alpha', 'Beta']);
	});

	it('listPuzzlesSorted returns puzzles ordered newest first', async () => {
		const now = Date.now();
		await listModule.createPuzzle(makePuzzle('list-old', { name: 'Old', createdAt: now - 5000 }));
		await listModule.createPuzzle(makePuzzle('list-new', { name: 'New', createdAt: now }));
		const result = await listModule.listPuzzlesSorted();
		expect(result[0].name).toBe('New');
		expect(result[1].name).toBe('Old');
	});
});
