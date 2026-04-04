/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Extra coverage tests for storage.ts.
 * Covers: initializeStorage throwing a non-EEXIST error (line 53),
 * updatePuzzle when writeFile fails (lines 179-181).
 *
 * Uses vi.mock to wrap node:fs/promises functions so we can inject failures.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Wrap key node:fs/promises functions in vi.fn so tests can inject one-off failures.
// All functions forward to the real implementation by default.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		mkdir: vi.fn().mockImplementation(actual.mkdir.bind(actual)),
		readFile: vi
			.fn()
			.mockImplementation((...args: Parameters<typeof actual.readFile>) =>
				(actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args)
			),
		writeFile: vi
			.fn()
			.mockImplementation((...args: Parameters<typeof actual.writeFile>) =>
				(actual.writeFile as (...a: unknown[]) => Promise<void>)(...args)
			),
		rm: vi
			.fn()
			.mockImplementation((...args: Parameters<typeof actual.rm>) =>
				(actual.rm as (...a: unknown[]) => Promise<void>)(...args)
			)
	};
});

let tempDir: string;
let storageModule: typeof import('./storage');
let savedOriginalDataDir: string | undefined;

beforeAll(async () => {
	savedOriginalDataDir = process.env.DATA_DIR;
	tempDir = await mkdtemp(join(tmpdir(), 'perseus-storage-extra-test-'));
	process.env.DATA_DIR = tempDir;
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

describe('initializeStorage - non-EEXIST error is re-thrown (line 53)', () => {
	it('re-throws when mkdir fails with a non-EEXIST error code', async () => {
		const fsMock = await import('node:fs/promises');
		vi.mocked(fsMock.mkdir).mockRejectedValueOnce(
			Object.assign(new Error('Permission denied'), { code: 'EACCES' })
		);

		await expect(storageModule.initializeStorage()).rejects.toThrow('Permission denied');
	});

	it('silently ignores EEXIST errors (directory already exists)', async () => {
		const fsMock = await import('node:fs/promises');
		vi.mocked(fsMock.mkdir).mockRejectedValueOnce(
			Object.assign(new Error('File exists'), { code: 'EEXIST' })
		);

		await expect(storageModule.initializeStorage()).resolves.toBeUndefined();
	});
});

describe('updatePuzzle - writeFile failure returns false (lines 179-181)', () => {
	it('returns false and logs error when writeFile throws', async () => {
		const { createPuzzle, updatePuzzle } = storageModule;

		// Create puzzle so metadata file exists and access() succeeds
		const puzzle = {
			id: 'update-fail-test-puzzle',
			name: 'Update Fail Test',
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as any);

		// Inject a one-off failure into writeFile
		const fsMock = await import('node:fs/promises');
		vi.mocked(fsMock.writeFile).mockRejectedValueOnce(new Error('Disk full'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await updatePuzzle({ ...puzzle, name: 'Updated Name' } as any);
		expect(result).toBe(false);
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});

describe('createPuzzle - writeFile failure returns false (lines 132-134)', () => {
	it('returns false when writeFile fails during puzzle creation', async () => {
		const { createPuzzle } = storageModule;

		const fsMock = await import('node:fs/promises');
		vi.mocked(fsMock.writeFile).mockRejectedValueOnce(new Error('File exists already'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const puzzle = {
			id: 'create-fail-test',
			name: 'Create Fail',
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: Date.now(),
			pieces: []
		};
		const result = await createPuzzle(puzzle as any);
		expect(result).toBe(false);
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});

describe('getPuzzle - string createdAt is converted to timestamp (line 146)', () => {
	it('converts ISO string createdAt to a numeric timestamp', async () => {
		const { createPuzzle, getPuzzle } = storageModule;
		const { writeFile } = await import('node:fs/promises');
		const { join } = await import('node:path');

		// First create the puzzle normally (with numeric createdAt)
		const puzzle = {
			id: 'string-created-at-puzzle',
			name: 'String CreatedAt',
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as any);

		// Overwrite the metadata file to have a string createdAt (ISO format)
		const isoDate = new Date().toISOString();
		const metadataPath = join(tempDir, 'puzzles', 'string-created-at-puzzle', 'metadata.json');
		await writeFile(
			metadataPath,
			JSON.stringify({ ...puzzle, createdAt: isoDate }, null, 2),
			'utf-8'
		);

		// Read it back — should convert string to timestamp
		const result = await getPuzzle('string-created-at-puzzle');
		expect(result).not.toBeNull();
		expect(typeof result!.createdAt).toBe('number');
		expect(result!.createdAt).toBeGreaterThan(0);
	});
});

describe('getPuzzle - unexpected readFile error is re-thrown (lines 152-153)', () => {
	it('throws when readFile fails with an unexpected error', async () => {
		const { createPuzzle, getPuzzle } = storageModule;

		// Create the puzzle so the path is valid (access check passes)
		const puzzle = {
			id: 'readfile-error-puzzle',
			name: 'ReadFile Error',
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as any);

		// Make readFile throw an unexpected error (not ENOENT, not InvalidPuzzleIdError)
		const fsMock = await import('node:fs/promises');
		vi.mocked(fsMock.readFile).mockRejectedValueOnce(
			Object.assign(new Error('Permission denied'), { code: 'EACCES' })
		);

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(getPuzzle('readfile-error-puzzle')).rejects.toThrow('Permission denied');
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});

describe('deletePuzzle - outer catch returns false (line ~198)', () => {
	it('returns false when rm throws unexpectedly', async () => {
		const { createPuzzle, deletePuzzle } = storageModule;

		const puzzle = {
			id: 'delete-rm-fail-puzzle',
			name: 'Delete RM Fail Test',
			pieceCount: 9,
			gridCols: 3,
			gridRows: 3,
			imageWidth: 300,
			imageHeight: 300,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as any);

		// Inject a one-off rm failure to trigger the outer catch block
		const fsMock = await import('node:fs/promises');
		vi.mocked(fsMock.rm).mockRejectedValueOnce(new Error('Permission denied'));

		const result = await deletePuzzle('delete-rm-fail-puzzle');
		expect(result).toBe(false);
	});
});
