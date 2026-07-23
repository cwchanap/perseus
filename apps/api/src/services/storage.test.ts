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

	it('getOriginalImagePath returns .png extension for image/png mime type', () => {
		const { getOriginalImagePath } = storageModule;
		const path = getOriginalImagePath('my-puzzle', 'image/png');
		expect(path.endsWith('original.png')).toBe(true);
	});

	it('getOriginalImagePath returns .webp extension for image/webp mime type', () => {
		const { getOriginalImagePath } = storageModule;
		const path = getOriginalImagePath('my-puzzle', 'image/webp');
		expect(path.endsWith('original.webp')).toBe(true);
	});

	it('findOriginalImagePath returns null when no original image exists', () => {
		const { findOriginalImagePath } = storageModule;
		const result = findOriginalImagePath('nonexistent-puzzle');
		expect(result).toBeNull();
	});

	it('findOriginalImagePath discovers .jpeg extension', async () => {
		const { createPuzzle, getPuzzleDir, findOriginalImagePath } = storageModule;
		const puzzle = makePuzzle('find-jpeg-test');
		await createPuzzle(puzzle);
		// Write a file with .jpeg extension (legacy/migrated data scenario)
		const jpegPath = join(getPuzzleDir('find-jpeg-test'), 'original.jpeg');
		await writeFile(jpegPath, 'fake-jpeg-data');
		const result = findOriginalImagePath('find-jpeg-test');
		expect(result).toBe(jpegPath);
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
	// Wipe and re-create the puzzles directory before each test so the list
	// results are not polluted by puzzles created in other describe blocks.
	beforeEach(async () => {
		await rm(join(tempDir, 'puzzles'), { recursive: true, force: true });
		await storageModule.initializeStorage();
	});

	it('listPuzzles returns empty array when no puzzles exist', async () => {
		const result = await storageModule.listPuzzles();
		expect(result).toEqual([]);
	});

	it('listPuzzles returns summaries of created puzzles', async () => {
		await storageModule.createPuzzle(makePuzzle('list-a', { name: 'Alpha' }));
		await storageModule.createPuzzle(makePuzzle('list-b', { name: 'Beta' }));
		const result = await storageModule.listPuzzles();
		expect(result).toHaveLength(2);
		const names = result.map((p) => p.name).sort();
		expect(names).toEqual(['Alpha', 'Beta']);
	});

	it('listPuzzlesSorted returns puzzles ordered newest first', async () => {
		const now = Date.now();
		await storageModule.createPuzzle(
			makePuzzle('list-old', { name: 'Old', createdAt: now - 5000 })
		);
		await storageModule.createPuzzle(makePuzzle('list-new', { name: 'New', createdAt: now }));
		const result = await storageModule.listPuzzlesSorted();
		expect(result[0].name).toBe('New');
		expect(result[1].name).toBe('Old');
	});
});

describe('listPuzzlesPage', () => {
	beforeEach(async () => {
		await rm(join(tempDir, 'puzzles'), { recursive: true, force: true });
		await storageModule.initializeStorage();
	});

	it('returns empty result when no puzzles exist', async () => {
		const result = await storageModule.listPuzzlesPage({ offset: 0, limit: 20 });
		expect(result).toEqual({ puzzles: [], total: 0, offset: 0, limit: 20 });
		expect(result).not.toHaveProperty('nextCursor');
	});

	it('returns the correct page slice', async () => {
		await storageModule.createPuzzle(makePuzzle('page-a', { name: 'A', createdAt: 3000 }));
		await storageModule.createPuzzle(makePuzzle('page-b', { name: 'B', createdAt: 2000 }));
		await storageModule.createPuzzle(makePuzzle('page-c', { name: 'C', createdAt: 1000 }));

		const result = await storageModule.listPuzzlesPage({ offset: 1, limit: 1 });

		expect(result.total).toBe(3);
		expect(result.offset).toBe(1);
		expect(result.limit).toBe(1);
		expect(result.puzzles).toHaveLength(1);
		expect(result.puzzles[0].name).toBe('B');
	});

	it('filters by q', async () => {
		await storageModule.createPuzzle(makePuzzle('page-cat', { name: 'Cat Puzzle' }));
		await storageModule.createPuzzle(makePuzzle('page-dog', { name: 'Dog Puzzle' }));

		const result = await storageModule.listPuzzlesPage({
			q: 'cat',
			offset: 0,
			limit: 20
		});

		expect(result.total).toBe(1);
		expect(result.puzzles).toHaveLength(1);
		expect(result.puzzles[0].name).toBe('Cat Puzzle');
	});

	it('filters by category', async () => {
		await storageModule.createPuzzle(
			makePuzzle('page-animals', { name: 'Animals', category: 'Animals' })
		);
		await storageModule.createPuzzle(makePuzzle('page-art', { name: 'Art', category: 'Art' }));

		const result = await storageModule.listPuzzlesPage({
			category: 'Animals',
			offset: 0,
			limit: 20
		});

		expect(result.total).toBe(1);
		expect(result.puzzles).toHaveLength(1);
		expect(result.puzzles[0].category).toBe('Animals');
	});

	it('breaks ties deterministically by id when createdAt is equal', async () => {
		const sharedTimestamp = 5000;
		await storageModule.createPuzzle(
			makePuzzle('page-beta', { name: 'Beta', createdAt: sharedTimestamp })
		);
		await storageModule.createPuzzle(
			makePuzzle('page-alpha', { name: 'Alpha', createdAt: sharedTimestamp })
		);
		await storageModule.createPuzzle(
			makePuzzle('page-gamma', { name: 'Gamma', createdAt: sharedTimestamp })
		);

		const result = await storageModule.listPuzzlesPage({ offset: 0, limit: 20 });

		expect(result.total).toBe(3);
		expect(result.puzzles[0].id).toBe('page-alpha');
		expect(result.puzzles[1].id).toBe('page-beta');
		expect(result.puzzles[2].id).toBe('page-gamma');
	});

	it('does not return nextCursor when result count equals limit', async () => {
		await storageModule.createPuzzle(makePuzzle('cursor-a', { name: 'A', createdAt: 3000 }));
		await storageModule.createPuzzle(makePuzzle('cursor-b', { name: 'B', createdAt: 2000 }));

		const result = await storageModule.listPuzzlesPage({ offset: 0, limit: 2 });

		expect(result.puzzles).toHaveLength(2);
		expect(result).not.toHaveProperty('nextCursor');
	});

	it('returns nextCursor when more items remain beyond page', async () => {
		await storageModule.createPuzzle(makePuzzle('cursor-a', { name: 'A', createdAt: 3000 }));
		await storageModule.createPuzzle(makePuzzle('cursor-b', { name: 'B', createdAt: 2000 }));
		await storageModule.createPuzzle(makePuzzle('cursor-c', { name: 'C', createdAt: 1000 }));

		const result = await storageModule.listPuzzlesPage({ offset: 0, limit: 2 });

		expect(result.puzzles).toHaveLength(2);
		expect(result.nextCursor).toBeDefined();
	});

	it('does not return nextCursor on last page via cursor', async () => {
		await storageModule.createPuzzle(makePuzzle('cursor-a', { name: 'A', createdAt: 3000 }));
		await storageModule.createPuzzle(makePuzzle('cursor-b', { name: 'B', createdAt: 2000 }));
		await storageModule.createPuzzle(makePuzzle('cursor-c', { name: 'C', createdAt: 1000 }));

		const page1 = await storageModule.listPuzzlesPage({ offset: 0, limit: 2 });
		expect(page1.nextCursor).toBeDefined();

		const page2 = await storageModule.listPuzzlesPage({
			offset: 0,
			limit: 2,
			cursor: page1.nextCursor
		});

		expect(page2.puzzles).toHaveLength(1);
		expect(page2).not.toHaveProperty('nextCursor');
	});

	it('does not return nextCursor when filtered results equal limit', async () => {
		await storageModule.createPuzzle(
			makePuzzle('cursor-cat', { name: 'Cat', createdAt: 3000, category: 'Animals' })
		);
		await storageModule.createPuzzle(
			makePuzzle('cursor-dog', { name: 'Dog', createdAt: 2000, category: 'Animals' })
		);
		await storageModule.createPuzzle(
			makePuzzle('cursor-art', { name: 'Art', createdAt: 1000, category: 'Art' })
		);

		const result = await storageModule.listPuzzlesPage({
			category: 'Animals',
			offset: 0,
			limit: 2
		});

		expect(result.puzzles).toHaveLength(2);
		expect(result).not.toHaveProperty('nextCursor');
	});

	it('returns good puzzles and skips corrupt entries without throwing', async () => {
		await storageModule.createPuzzle(makePuzzle('good-puzzle', { name: 'Good Puzzle' }));
		await storageModule.createPuzzle(makePuzzle('corrupt-puzzle', { name: 'Will be corrupted' }));

		const metadataPath = join(storageModule.getPuzzleDir('corrupt-puzzle'), 'metadata.json');
		await writeFile(metadataPath, 'not-valid-json', 'utf-8');

		const result = await storageModule.listPuzzlesPage({ offset: 0, limit: 20 });

		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('good-puzzle');
	});
});

describe('idempotency reservation', () => {
	beforeEach(async () => {
		const { readdir, rm } = await import('node:fs/promises');
		const entries = await readdir(tempDir, { withFileTypes: true });
		for (const entry of entries) {
			await rm(join(tempDir, entry.name), { recursive: true, force: true });
		}
		await storageModule.initializeStorage();
	});

	it('reserves a key for the first caller and returns existing for the second', async () => {
		const first = await storageModule.reserveIdempotencyKey('key-a', 'puzzle-1');
		expect(first).toEqual({ existing: false, puzzleId: 'puzzle-1' });

		const second = await storageModule.reserveIdempotencyKey('key-a', 'puzzle-2');
		expect(second).toEqual({ existing: true, puzzleId: 'puzzle-1' });
	});

	it('releases only when the owner matches', async () => {
		await storageModule.reserveIdempotencyKey('key-b', 'puzzle-1');
		await storageModule.releaseIdempotencyKey('key-b', 'wrong-owner');
		const stillHeld = await storageModule.reserveIdempotencyKey('key-b', 'puzzle-2');
		expect(stillHeld).toEqual({ existing: true, puzzleId: 'puzzle-1' });

		await storageModule.releaseIdempotencyKey('key-b', 'puzzle-1');
		const reclaimed = await storageModule.reserveIdempotencyKey('key-b', 'puzzle-3');
		expect(reclaimed).toEqual({ existing: false, puzzleId: 'puzzle-3' });
	});

	it('reclaims a corrupt empty reservation file instead of bricking the key', async () => {
		const { mkdir } = await import('node:fs/promises');
		// A mid-write crash can leave a zero-byte reservation file. Without
		// recovery this permanently 500s the key (and release() cannot clear an
		// ownerless file). reserve() should detect the empty file and reclaim it.
		const reservationPath = join(tempDir, 'idempotency', 'key-empty');
		await mkdir(join(tempDir, 'idempotency'), { recursive: true });
		await writeFile(reservationPath, '', { flag: 'wx' });
		expect(await readFile(reservationPath, 'utf-8')).toBe('');

		const result = await storageModule.reserveIdempotencyKey('key-empty', 'puzzle-1');
		expect(result).toEqual({ existing: false, puzzleId: 'puzzle-1' });
		expect(await readFile(reservationPath, 'utf-8')).toBe('puzzle-1');
	});

	it('concurrent reserves for the same key award exactly one winner (link atomicity)', async () => {
		// Two reserves race for the same key. The atomic temp-file + link()
		// publish must guarantee only one caller wins the claim; the loser
		// reads the winner's puzzleId back. This mirrors the DO concurrency
		// test and guards against a regression that drops the link() step (a
		// plain writeFile would let both callers "win" and clobber each other).
		const [r1, r2] = await Promise.all([
			storageModule.reserveIdempotencyKey('key-race', 'puzzle-a'),
			storageModule.reserveIdempotencyKey('key-race', 'puzzle-b')
		]);
		const winners = [r1, r2].filter((r) => r.existing === false);
		expect(winners.length).toBe(1);
		const winnerId = winners[0].puzzleId;
		expect(['puzzle-a', 'puzzle-b']).toContain(winnerId);

		const loser = [r1, r2].find((r) => r.existing === true)!;
		expect(loser.puzzleId).toBe(winnerId);
	});

	it('concurrent release and replacement reserve serialize via per-key lock', async () => {
		// Reserve a key, then concurrently release it (owner-checked) and
		// reserve a replacement puzzleId. Without the per-key lock, the
		// release's read-verify-delete window can interleave with the reserve's
		// read: reserve sees the old puzzleId (returns existing), then release
		// deletes the file — leaving the key unowned even though the reserve
		// caller thinks it's still held. With the lock, the operations
		// serialize: either release completes first (file gone, reserve creates
		// fresh) or reserve completes first (returns existing, then release
		// deletes). Either way, a follow-up reserve sees a consistent state.
		await storageModule.reserveIdempotencyKey('key-rel-race', 'puzzle-a');

		await Promise.all([
			storageModule.releaseIdempotencyKey('key-rel-race', 'puzzle-a'),
			storageModule.reserveIdempotencyKey('key-rel-race', 'puzzle-b')
		]);

		// Follow-up reserve must see a consistent state: either puzzle-b won
		// the race (file exists with puzzle-b) or the release deleted the file
		// and the follow-up creates puzzle-c fresh. No stale/corrupt state.
		const followUp = await storageModule.reserveIdempotencyKey('key-rel-race', 'puzzle-c');
		if (followUp.existing) {
			// puzzle-b won — file should contain puzzle-b.
			expect(followUp.puzzleId).toBe('puzzle-b');
		} else {
			// Release won — file was deleted, follow-up created puzzle-c.
			expect(followUp.puzzleId).toBe('puzzle-c');
		}
	});

	it('concurrent release by wrong owner does not clear a winner reservation', async () => {
		// A wrong-owner release must not delete the file even when it
		// interleaves with a concurrent reserve. The per-key lock serializes
		// the operations, and the owner check prevents the wrong-owner release
		// from clearing a reservation it doesn't own.
		await storageModule.reserveIdempotencyKey('key-wrong-owner', 'puzzle-a');

		await Promise.all([
			storageModule.releaseIdempotencyKey('key-wrong-owner', 'wrong-owner'),
			storageModule.reserveIdempotencyKey('key-wrong-owner', 'puzzle-b')
		]);

		// The wrong-owner release is a no-op. The reserve either sees
		// puzzle-a (existing) or creates puzzle-b if the file was somehow
		// gone. The key invariant: the wrong-owner release did NOT delete
		// the file, so the reservation still maps to puzzle-a.
		const followUp = await storageModule.reserveIdempotencyKey('key-wrong-owner', 'puzzle-c');
		expect(followUp.existing).toBe(true);
		expect(followUp.puzzleId).toBe('puzzle-a');
	});

	it('concurrent releases for the same key serialize and do not corrupt the file', async () => {
		// Two concurrent releases for the same key and owner. The per-key
		// lock serializes them: the first deletes the file, the second finds
		// it gone (ENOENT) and returns. No error, no corruption.
		await storageModule.reserveIdempotencyKey('key-double-release', 'puzzle-a');

		await Promise.all([
			storageModule.releaseIdempotencyKey('key-double-release', 'puzzle-a'),
			storageModule.releaseIdempotencyKey('key-double-release', 'puzzle-a')
		]);

		// File should be gone — a follow-up reserve creates fresh.
		const followUp = await storageModule.reserveIdempotencyKey('key-double-release', 'puzzle-b');
		expect(followUp).toEqual({ existing: false, puzzleId: 'puzzle-b' });
	});

	it('re-throws non-ENOENT errors from release so callers can surface them', async () => {
		// releaseIdempotencyKey must re-throw non-ENOENT errors (e.g. EISDIR,
		// EACCES, EIO) instead of silently swallowing them, so callers can
		// log, retry, or return an error to the client. ENOENT is still
		// swallowed (the file is already gone — not an error).
		//
		// To simulate a non-ENOENT error without mocking the frozen
		// node:fs/promises module, replace the reservation file with a
		// directory — readFile on a directory throws EISDIR.
		const { mkdir, rm, rmdir } = await import('node:fs/promises');
		const reservationPath = join(tempDir, 'idempotency', 'key-release-throw');
		await mkdir(join(tempDir, 'idempotency'), { recursive: true });
		await writeFile(reservationPath, 'puzzle-a', { flag: 'wx' });
		// Replace the file with a directory of the same name.
		await rm(reservationPath, { force: true });
		await mkdir(reservationPath, { recursive: true });

		await expect(
			storageModule.releaseIdempotencyKey('key-release-throw', 'puzzle-a')
		).rejects.toThrow();

		// Cleanup: remove the directory so it doesn't interfere with other tests.
		await rmdir(reservationPath, { recursive: true }).catch(() => {});
	});

	it('finds a legacy puzzle by idempotency key when no reservation file exists', async () => {
		// Legacy path: a puzzle was created with an idempotency key but the
		// reservation file was lost (e.g. migrated from before reservations
		// existed). reserveIdempotencyKey should scan puzzles and find the
		// matching one, returning existing: true.
		const { unlink } = await import('node:fs/promises');

		// Create a puzzle with an idempotency key.
		const legacyPuzzle = makePuzzle('puzzle-legacy', {
			idempotencyKey: 'key-legacy-find'
		});
		await storageModule.createPuzzle(legacyPuzzle);

		// Also create a second puzzle with a different key so the scan
		// encounters a non-matching puzzle (covers the false branch of
		// the idempotencyKey comparison in findPuzzleByIdempotencyKey).
		const otherPuzzle = makePuzzle('puzzle-other-idem', {
			idempotencyKey: 'key-different'
		});
		await storageModule.createPuzzle(otherPuzzle);

		// Ensure no reservation file exists for 'key-legacy-find'.
		const reservationPath = join(tempDir, 'idempotency', 'key-legacy-find');
		await unlink(reservationPath).catch(() => {});

		const result = await storageModule.reserveIdempotencyKey('key-legacy-find', 'puzzle-new');
		expect(result).toEqual({ existing: true, puzzleId: 'puzzle-legacy' });

		// The reservation file should now be populated with the legacy puzzle's ID.
		expect(await readFile(reservationPath, 'utf-8')).toBe('puzzle-legacy');
	});

	it('returns existing when atomic claim loses a race to a concurrent writer', async () => {
		// Race condition path (line 378): the fast path readFile fails (file
		// doesn't exist), the legacy check finds nothing, and the atomic
		// claim's link() fails with EEXIST because another process created
		// the file with content between the readFile and the link. The code
		// reads the existing content and returns { existing: true, ... }.
		const { writeFile, unlink } = await import('node:fs/promises');
		const reservationPath = join(tempDir, 'idempotency', 'key-race-378');

		// Ensure the file does not exist so the fast path hits ENOENT.
		await unlink(reservationPath).catch(() => {});

		// Concurrently: write the file with content while the reserve is
		// in progress (between the fast-path readFile and the atomic link).
		// The reserve's atomic claim will get EEXIST and read our content.
		const raceWriter = (async () => {
			// Small delay so the reserve's fast path has already missed.
			await new Promise((resolve) => setTimeout(resolve, 5));
			await writeFile(reservationPath, 'puzzle-race-winner', { flag: 'wx' }).catch(() => {});
		})();

		const result = await storageModule.reserveIdempotencyKey('key-race-378', 'puzzle-race-loser');
		await raceWriter;

		// Either we won the race (existing: false) or lost it (existing: true).
		// Both outcomes are valid; the test exercises the atomic claim path.
		if (result.existing) {
			expect(result.puzzleId).toBe('puzzle-race-winner');
		} else {
			expect(result.puzzleId).toBe('puzzle-race-loser');
		}
	});
});
