import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let storageModule: typeof import('./storage');
let savedOriginalDataDir: string | undefined;

beforeAll(async () => {
	savedOriginalDataDir = process.env.DATA_DIR;
	tempDir = await mkdtemp(join(tmpdir(), 'perseus-storage-find-test-'));
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

describe('findOriginalImagePath - extension discovery', () => {
	it('discovers .jpg extension', async () => {
		const { createPuzzle, getPuzzleDir, findOriginalImagePath } = storageModule;
		const puzzle = {
			id: 'find-jpg-test',
			name: 'JPG Test',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as Parameters<typeof createPuzzle>[0]);
		await writeFile(join(getPuzzleDir('find-jpg-test'), 'original.jpg'), Buffer.from([0xff]));

		const result = findOriginalImagePath('find-jpg-test');
		expect(result).not.toBeNull();
		expect(result).toContain('original.jpg');
	});

	it('discovers .png extension when no .jpg or .jpeg exists', async () => {
		const { createPuzzle, getPuzzleDir, findOriginalImagePath } = storageModule;
		const puzzle = {
			id: 'find-png-test',
			name: 'PNG Test',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as Parameters<typeof createPuzzle>[0]);
		await writeFile(join(getPuzzleDir('find-png-test'), 'original.png'), Buffer.from([0x89]));

		const result = findOriginalImagePath('find-png-test');
		expect(result).not.toBeNull();
		expect(result).toContain('original.png');
	});

	it('discovers .webp extension when no .jpg, .jpeg, or .png exists', async () => {
		const { createPuzzle, getPuzzleDir, findOriginalImagePath } = storageModule;
		const puzzle = {
			id: 'find-webp-test',
			name: 'WebP Test',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as Parameters<typeof createPuzzle>[0]);
		await writeFile(join(getPuzzleDir('find-webp-test'), 'original.webp'), Buffer.from([0x52]));

		const result = findOriginalImagePath('find-webp-test');
		expect(result).not.toBeNull();
		expect(result).toContain('original.webp');
	});

	it('returns the first matching extension (.jpg) even when .png also exists', async () => {
		const { createPuzzle, getPuzzleDir, findOriginalImagePath } = storageModule;
		const puzzle = {
			id: 'find-first-ext-test',
			name: 'First Extension Test',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: Date.now(),
			pieces: []
		};
		await createPuzzle(puzzle as Parameters<typeof createPuzzle>[0]);
		const dir = getPuzzleDir('find-first-ext-test');
		await writeFile(join(dir, 'original.jpg'), Buffer.from([0xff]));
		await writeFile(join(dir, 'original.png'), Buffer.from([0x89]));

		const result = findOriginalImagePath('find-first-ext-test');
		expect(result).not.toBeNull();
		expect(result).toContain('original.jpg');
	});
});
