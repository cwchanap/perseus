// Storage service for puzzle CRUD operations
// Uses JSON files for metadata and filesystem for images

import { mkdir, readFile, writeFile, readdir, rm, access, link } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Puzzle, PuzzleSummary, PuzzleCategory } from '../types/index';

export class InvalidPuzzleIdError extends Error {
	constructor(message = 'Invalid puzzleId') {
		super(message);
		this.name = 'InvalidPuzzleIdError';
	}
}

const DATA_DIR = process.env.DATA_DIR || './data';
const PUZZLES_DIR = join(DATA_DIR, 'puzzles');
const PUZZLES_DIR_RESOLVED = resolve(PUZZLES_DIR);
// Sibling of puzzles/ so listPuzzles never treats reservation files as puzzles.
const IDEMPOTENCY_DIR = join(DATA_DIR, 'idempotency');
const IDEMPOTENCY_DIR_RESOLVED = resolve(IDEMPOTENCY_DIR);

// Per-key async mutex for idempotency reservation mutations. The atomic
// link() publish protects the write step, but the read-decide-write windows
// in reserveIdempotencyKey's claim loop (read → rm → retry publish) and
// releaseIdempotencyKey (read → verify owner → rm) can interleave under
// concurrent async calls in the same process. Serializing all mutations on
// the same key eliminates the race without relying on filesystem-level
// locking (unreliable across platforms). The DO version uses
// storage.transaction for the same guarantee.
const idempotencyKeyLocks = new Map<string, Promise<void>>();

async function withIdempotencyKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = idempotencyKeyLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	idempotencyKeyLocks.set(key, next);
	try {
		await previous;
		return await fn();
	} finally {
		release();
		if (idempotencyKeyLocks.get(key) === next) {
			idempotencyKeyLocks.delete(key);
		}
	}
}

function isValidPuzzleId(puzzleId: string): boolean {
	if (puzzleId.length === 0 || puzzleId.length > 128) {
		return false;
	}

	// Allow alphanumerics plus single underscores/hyphens (no leading/trailing or consecutive)
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|[-_](?=[A-Za-z0-9]))*$/.test(puzzleId)) {
		return false;
	}

	return true;
}

function resolvePuzzlePath(puzzleId: string, ...segments: string[]): string {
	if (!isValidPuzzleId(puzzleId)) {
		throw new InvalidPuzzleIdError();
	}

	const fullPath = resolve(PUZZLES_DIR, puzzleId, ...segments);
	const rel = relative(PUZZLES_DIR_RESOLVED, fullPath);

	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new InvalidPuzzleIdError();
	}

	return fullPath;
}

// Initialize data directory structure
export async function initializeStorage(): Promise<void> {
	try {
		await mkdir(PUZZLES_DIR, { recursive: true });
		await mkdir(IDEMPOTENCY_DIR, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
	}
}

function isValidIdempotencyKey(key: string): boolean {
	return key.length > 0 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key);
}

function resolveIdempotencyPath(key: string): string {
	if (!isValidIdempotencyKey(key)) {
		throw new Error('Invalid idempotency key');
	}
	const fullPath = resolve(IDEMPOTENCY_DIR, key);
	const rel = relative(IDEMPOTENCY_DIR_RESOLVED, fullPath);
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new Error('Invalid idempotency key');
	}
	return fullPath;
}

// Get puzzle directory path
export function getPuzzleDir(puzzleId: string): string {
	return resolvePuzzlePath(puzzleId);
}

// Get puzzle pieces directory path
export function getPiecesDir(puzzleId: string): string {
	return resolvePuzzlePath(puzzleId, 'pieces');
}

// Get metadata file path
function getMetadataPath(puzzleId: string): string {
	return resolvePuzzlePath(puzzleId, 'metadata.json');
}

// Get original image path
export function getOriginalImagePath(puzzleId: string, mimeType?: string): string {
	const ext = mimeTypeToExt(mimeType ?? 'image/jpeg');
	return resolvePuzzlePath(puzzleId, `original${ext}`);
}

// Find original image path by probing supported extensions
export function findOriginalImagePath(puzzleId: string): string | null {
	for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
		const p = resolvePuzzlePath(puzzleId, `original${ext}`);
		if (existsSync(p)) return p;
	}
	return null;
}

function mimeTypeToExt(mimeType: string): string {
	if (mimeType === 'image/png') return '.png';
	if (mimeType === 'image/webp') return '.webp';
	return '.jpg';
}

// Get thumbnail path
export function getThumbnailPath(puzzleId: string): string {
	return resolvePuzzlePath(puzzleId, 'thumbnail.jpg');
}

// Get piece image path
export function getPieceImagePath(puzzleId: string, pieceId: number): string {
	return resolvePuzzlePath(puzzleId, 'pieces', `${pieceId}.png`);
}

// Check if puzzle exists
export async function puzzleExists(puzzleId: string): Promise<boolean> {
	try {
		await access(getMetadataPath(puzzleId));
		return true;
	} catch {
		return false;
	}
}

// Create a new puzzle
export async function createPuzzle(puzzle: Puzzle): Promise<boolean> {
	let puzzleDir: string;
	let piecesDir: string;
	let metadataPath: string;

	try {
		puzzleDir = getPuzzleDir(puzzle.id);
		piecesDir = getPiecesDir(puzzle.id);
		metadataPath = getMetadataPath(puzzle.id);
	} catch (error) {
		console.error(`Refusing to create puzzle ${puzzle.id}: invalid puzzle id`);
		console.error(error);
		return false;
	}

	try {
		await access(metadataPath);
		console.error(`Refusing to create puzzle ${puzzle.id}: metadata already exists`);
		return false;
	} catch {
		// continue
	}

	try {
		await mkdir(puzzleDir, { recursive: true });
		await mkdir(piecesDir, { recursive: true });

		await writeFile(metadataPath, JSON.stringify(puzzle, null, 2), {
			encoding: 'utf-8',
			flag: 'wx'
		});
		return true;
	} catch (error) {
		console.error(`Failed to create puzzle ${puzzle.id}`);
		console.error(error);
		return false;
	}
}

// Get a puzzle by ID
export async function getPuzzle(puzzleId: string): Promise<Puzzle | null> {
	try {
		const data = await readFile(getMetadataPath(puzzleId), 'utf-8');
		const parsed = JSON.parse(data) as Puzzle;
		const createdAt =
			typeof parsed.createdAt === 'number'
				? parsed.createdAt
				: new Date(parsed.createdAt).getTime();
		return { ...parsed, createdAt };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') return null; // expected: puzzle doesn't exist
		if (error instanceof InvalidPuzzleIdError) return null; // invalid puzzle ID treated as not found
		console.error(`Failed to read puzzle metadata for ${puzzleId}:`, error);
		throw error; // propagate unexpected errors (corrupt file, permission denied, etc.)
	}
}

// Update puzzle metadata
export async function updatePuzzle(puzzle: Puzzle): Promise<boolean> {
	let metadataPath: string;

	try {
		metadataPath = getMetadataPath(puzzle.id);
	} catch (error) {
		console.error(`Failed to update puzzle metadata for ${puzzle.id}: invalid puzzle id`);
		console.error(error);
		return false;
	}

	try {
		await access(metadataPath);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== 'ENOENT') {
			console.error(`Unexpected error accessing metadata for puzzle ${puzzle.id}:`, error);
		}
		return false;
	}

	try {
		await writeFile(metadataPath, JSON.stringify(puzzle, null, 2), 'utf-8');
		return true;
	} catch (error) {
		console.error(`Failed to update puzzle metadata for ${puzzle.id}`);
		console.error(error);
		return false;
	}
}

// Delete a puzzle and all its files
export async function deletePuzzle(puzzleId: string): Promise<boolean> {
	try {
		const puzzleDir = getPuzzleDir(puzzleId);
		try {
			await access(puzzleDir);
		} catch {
			return false;
		}

		await rm(puzzleDir, { recursive: true, force: true });
		return true;
	} catch (error) {
		console.error(`Failed to delete puzzle directory for ${puzzleId}:`, error);
		return false;
	}
}

/**
 * Find an existing puzzle by its idempotency key via linear metadata scan.
 * Prefer reserveIdempotencyKey for create paths — this is a fallback for
 * legacy puzzles reserved only in metadata, not the atomic reservation file.
 */
export async function findPuzzleByIdempotencyKey(key: string): Promise<Puzzle | null> {
	if (!key) return null;
	const entries = await readdir(PUZZLES_DIR, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const puzzle = await getPuzzle(entry.name);
			if (puzzle && puzzle.idempotencyKey === key) return puzzle;
		} catch (err) {
			console.error(`Skipping corrupt puzzle entry '${entry.name}' during idempotency scan:`, err);
		}
	}
	return null;
}

/**
 * Atomically publish a reservation file with content via temp-file + link().
 * link() is atomic on POSIX and fails with EEXIST if the target already
 * exists, so the final path only ever appears with full content — no
 * empty-file window that a concurrent reader could misinterpret as a
 * crashed writer and delete (the race that exclusive-create-then-write
 * has between open() and write()).
 */
async function atomicPublishReservation(
	reservationPath: string,
	content: string
): Promise<{ published: boolean; existingId: string | null }> {
	const tmpPath = `${reservationPath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmpPath, content);
	try {
		await link(tmpPath, reservationPath);
		return { published: true, existingId: null };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
		const existingId = (await readFile(reservationPath, 'utf-8')).trim();
		return { published: false, existingId: existingId || null };
	} finally {
		await rm(tmpPath, { force: true });
	}
}

/**
 * Atomically reserve an idempotency key → puzzleId mapping via temp-file +
 * link(). Concurrent creates for the same key cannot both win: link() fails
 * with EEXIST if the target exists. Subsequent callers read the existing
 * mapping and return existing: true.
 *
 * On create failure the caller must releaseIdempotencyKey so retries can reuse
 * the key. Success leaves the reservation file in place as the durable mapping.
 *
 * All reservation mutations on the same key are serialized via a per-key async
 * mutex so the read-decide-write windows in the claim loop and release cannot
 * interleave under concurrent async calls in the same process.
 */
export async function reserveIdempotencyKey(
	key: string,
	proposedPuzzleId: string
): Promise<{ existing: boolean; puzzleId: string }> {
	if (!isValidIdempotencyKey(key)) {
		throw new Error('Invalid idempotency key');
	}
	if (!proposedPuzzleId) {
		throw new Error('proposedPuzzleId is required');
	}

	return withIdempotencyKeyLock(key, async () => {
		await mkdir(IDEMPOTENCY_DIR, { recursive: true });
		const path = resolveIdempotencyPath(key);

		// Fast path: reservation file already exists.
		try {
			const existingId = (await readFile(path, 'utf-8')).trim();
			if (existingId) {
				return { existing: true, puzzleId: existingId };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}

		// Legacy: puzzle metadata may carry the key without a reservation file.
		const legacy = await findPuzzleByIdempotencyKey(key);
		if (legacy) {
			const result = await atomicPublishReservation(path, legacy.id);
			return { existing: true, puzzleId: result.existingId ?? legacy.id };
		}

		// Atomic claim: publish the proposed puzzleId via temp-file + link() so
		// the final path only appears with full content. An empty file can only
		// be a legacy crash leftover (the old wx approach had an open→write
		// window) — reclaim it and retry instead of permanently bricking the key.
		for (let claimAttempt = 0; claimAttempt < 2; claimAttempt++) {
			const result = await atomicPublishReservation(path, proposedPuzzleId);
			if (result.published) {
				return { existing: false, puzzleId: proposedPuzzleId };
			}
			if (result.existingId) {
				return { existing: true, puzzleId: result.existingId };
			}
			// Empty/corrupt reservation file — remove and retry the claim once.
			await rm(path, { force: true });
		}
		// Two empties in a row means a concurrent writer keeps failing its write;
		// surface it rather than looping indefinitely.
		throw new Error('Idempotency reservation file is empty after reclaim');
	});
}

/**
 * Owner-checked release of an idempotency reservation. Only deletes the file
 * when its content matches puzzleId, so a concurrent winner is never cleared.
 * Serialized via the same per-key mutex as reserveIdempotencyKey so the
 * read-verify-delete window cannot interleave with a concurrent reserve or
 * release on the same key.
 */
export async function releaseIdempotencyKey(key: string, puzzleId: string): Promise<void> {
	if (!isValidIdempotencyKey(key) || !puzzleId) return;
	return withIdempotencyKeyLock(key, async () => {
		const path = resolveIdempotencyPath(key);
		try {
			const existingId = (await readFile(path, 'utf-8')).trim();
			if (existingId !== puzzleId) return;
			await rm(path, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			// Re-throw non-ENOENT errors so callers can surface them (log,
			// retry, or return to client) instead of silently swallowing.
			console.error(`Failed to release idempotency key '${key}':`, error);
			throw error;
		}
	});
}

async function listPuzzlesWithDate(): Promise<
	Array<{ summary: PuzzleSummary; createdAt: number }>
> {
	const entries = await readdir(PUZZLES_DIR, { withFileTypes: true });
	const puzzlesWithDate: Array<{ summary: PuzzleSummary; createdAt: number }> = [];

	for (const entry of entries) {
		if (entry.isDirectory()) {
			try {
				const puzzle = await getPuzzle(entry.name);
				if (puzzle) {
					puzzlesWithDate.push({
						summary: {
							id: puzzle.id,
							name: puzzle.name,
							pieceCount: puzzle.pieceCount,
							status: 'ready',
							aspectRatio: puzzle.aspectRatio,
							category: puzzle.category
						},
						createdAt: puzzle.createdAt
					});
				}
			} catch (err) {
				console.error(`Skipping corrupt puzzle entry '${entry.name}':`, err);
			}
		}
	}

	return puzzlesWithDate;
}

// List all puzzles
export async function listPuzzles(): Promise<PuzzleSummary[]> {
	const puzzlesWithDate = await listPuzzlesWithDate();
	return puzzlesWithDate.map((p) => p.summary);
}

// Get puzzles sorted by creation date
export async function listPuzzlesSorted(): Promise<PuzzleSummary[]> {
	const puzzlesWithDate = await listPuzzlesWithDate();

	// Sort by creation date descending, tiebreak on id for deterministic order
	puzzlesWithDate.sort((a, b) => {
		const dateDiff = b.createdAt - a.createdAt;
		if (dateDiff !== 0) return dateDiff;
		return a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0;
	});

	return puzzlesWithDate.map((p) => p.summary);
}

export async function listPuzzlesPage(params: {
	q?: string;
	category?: PuzzleCategory;
	offset: number;
	limit: number;
	cursor?: string;
}): Promise<{
	puzzles: PuzzleSummary[];
	total: number;
	offset: number;
	limit: number;
	nextCursor?: string;
}> {
	const puzzlesWithDate = await listPuzzlesWithDate();
	puzzlesWithDate.sort((a, b) => {
		const dateDiff = b.createdAt - a.createdAt;
		if (dateDiff !== 0) return dateDiff;
		return a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0;
	});

	let filtered = puzzlesWithDate;

	if (params.category) {
		filtered = filtered.filter((p) => p.summary.category === params.category);
	}

	if (params.q) {
		const q = params.q.toLowerCase();
		filtered = filtered.filter((p) => p.summary.name.toLowerCase().includes(q));
	}

	const total = filtered.length;

	// Cursor-based pagination: skip to the item after the cursor position
	if (params.cursor) {
		let parsed: { createdAt: number; id: string } | null = null;
		try {
			// Convert Base64URL back to standard Base64 for atob
			let b64 = params.cursor.replace(/-/g, '+').replace(/_/g, '/');
			const pad = b64.length % 4;
			if (pad === 2) b64 += '==';
			else if (pad === 3) b64 += '=';
			const decoded = JSON.parse(atob(b64)) as { createdAt: number; id: string };
			if (typeof decoded?.createdAt === 'number' && typeof decoded?.id === 'string') {
				parsed = decoded;
			}
		} catch {
			// Invalid cursor, treat as offset 0
		}

		if (parsed) {
			const cursorIndex = filtered.findIndex(
				(e) => e.createdAt === parsed!.createdAt && e.summary.id === parsed!.id
			);
			if (cursorIndex >= 0) {
				filtered = filtered.slice(cursorIndex + 1);
			} else {
				filtered = filtered.filter((e) => {
					if (e.createdAt !== parsed!.createdAt) return e.createdAt < parsed!.createdAt;
					return e.summary.id > parsed!.id;
				});
			}
		}
	} else {
		filtered = filtered.slice(params.offset);
	}

	const page = filtered.slice(0, params.limit);
	const summaries = page.map((p) => p.summary);

	// Attach nextCursor only when more items remain beyond this page
	// Use Base64URL encoding (no +/=) so cursors are safe in query strings
	const nextCursor =
		filtered.length > params.limit
			? btoa(
					JSON.stringify({
						createdAt: page[page.length - 1].createdAt,
						id: page[page.length - 1].summary.id
					})
				)
					.replace(/\+/g, '-')
					.replace(/\//g, '_')
					.replace(/=+$/, '')
			: undefined;

	return {
		puzzles: summaries,
		total,
		offset: params.cursor ? 0 : params.offset,
		limit: params.limit,
		...(nextCursor ? { nextCursor } : {})
	};
}
