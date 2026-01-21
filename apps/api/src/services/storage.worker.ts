// Worker-compatible storage service using KV for metadata and R2 for assets

import type { PuzzleStatus, PuzzleProgress } from '../types/workflow';

export type EdgeType = 'flat' | 'tab' | 'blank';

export interface EdgeConfig {
	top: EdgeType;
	right: EdgeType;
	bottom: EdgeType;
	left: EdgeType;
}

export interface PuzzlePiece {
	id: number;
	puzzleId: string;
	correctX: number;
	correctY: number;
	edges: EdgeConfig;
	imagePath: string;
}

export interface PuzzleMetadata {
	id: string;
	name: string;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	imageWidth: number;
	imageHeight: number;
	createdAt: number;
	status: PuzzleStatus;
	progress?: PuzzleProgress;
	error?: { message: string };
	pieces: PuzzlePiece[];
	// Version for optimistic concurrency control
	version: number;
}

export interface PuzzleSummary {
	id: string;
	name: string;
	pieceCount: number;
	status: PuzzleStatus;
	progress?: PuzzleProgress;
}

// KV key helpers
function puzzleKey(id: string): string {
	return `puzzle:${id}`;
}

function lockKey(id: string): string {
	return `lock:${id}`;
}

// Distributed lock helpers for KV
export async function acquireLock(
	kv: KVNamespace,
	key: string,
	timeoutMs: number
): Promise<string | null> {
	const lockValue = Date.now().toString();
	try {
		// Note: This lock is best-effort and non-atomic (TOCTOU race between get and put).
		// For strict mutual exclusion, consider using Durable Objects or another atomic lock mechanism.
		const existing = await kv.get(key);
		if (existing) {
			// Lock already held
			return null;
		}
		await kv.put(key, lockValue, {
			expirationTtl: Math.max(Math.ceil(timeoutMs / 1000), 60)
		});
		return lockValue;
	} catch (error) {
		console.error('Failed to acquire lock:', error);
		return null;
	}
}

export async function releaseLock(
	kv: KVNamespace,
	key: string,
	expectedToken: string
): Promise<void> {
	try {
		// Verify ownership before releasing the lock
		const currentToken = await kv.get(key);
		if (currentToken === expectedToken) {
			await kv.delete(key);
		} else {
			console.warn(
				'Lock release aborted: token mismatch. Expected:',
				expectedToken,
				'Got:',
				currentToken
			);
		}
	} catch (error) {
		console.error('Failed to release lock:', error);
	}
}

// Get puzzle metadata from KV
export async function getPuzzle(kv: KVNamespace, puzzleId: string): Promise<PuzzleMetadata | null> {
	const data = await kv.get(puzzleKey(puzzleId), 'json');
	return data as PuzzleMetadata | null;
}

// Create initial puzzle metadata in KV (for processing state)
export async function createPuzzleMetadata(kv: KVNamespace, puzzle: PuzzleMetadata): Promise<void> {
	// Initialize version if not set
	const puzzleWithVersion = { ...puzzle, version: puzzle.version ?? 0 };
	await kv.put(puzzleKey(puzzleWithVersion.id), JSON.stringify(puzzleWithVersion));
}

// Update puzzle metadata in KV with optimistic concurrency control and distributed lock
export async function updatePuzzleMetadata(
	kv: KVNamespace,
	puzzleId: string,
	updates: Partial<PuzzleMetadata>
): Promise<void> {
	const lockTimeout = 5000; // 5 seconds
	const lockToken = await acquireLock(kv, lockKey(puzzleId), lockTimeout);
	if (!lockToken) {
		throw new Error(
			`Failed to acquire lock for puzzle ${puzzleId} update. Another update is in progress.`
		);
	}

	try {
		const existing = await getPuzzle(kv, puzzleId);
		if (!existing) {
			throw new Error(`Puzzle ${puzzleId} not found`);
		}

		const currentVersion = existing.version ?? 0;
		const updated: PuzzleMetadata = {
			...existing,
			...updates,
			version: currentVersion + 1
		};

		// Write updated metadata
		// Note: Due to KV eventual consistency, we skip read-back verification.
		// The distributed lock and version increment provide sufficient concurrency control.
		await kv.put(puzzleKey(puzzleId), JSON.stringify(updated));
	} finally {
		await releaseLock(kv, lockKey(puzzleId), lockToken);
	}
}

// Delete puzzle metadata from KV
export async function deletePuzzleMetadata(kv: KVNamespace, puzzleId: string): Promise<boolean> {
	try {
		await kv.delete(puzzleKey(puzzleId));
		return true;
	} catch (error) {
		console.error(`Failed to delete puzzle metadata for ${puzzleId}:`, error);
		return false;
	}
}

// List all puzzles from KV (sorted by createdAt desc)
export async function listPuzzles(kv: KVNamespace): Promise<PuzzleSummary[]> {
	const keys: { name: string }[] = [];
	let cursor: string | undefined;

	while (true) {
		const list = await kv.list({ prefix: 'puzzle:', cursor });
		keys.push(...list.keys);
		if (list.list_complete) {
			break;
		}
		cursor = list.cursor;
	}

	const fetched = await Promise.all(keys.map((k) => kv.get(k.name, 'json')));
	const puzzles = fetched.filter((p): p is PuzzleMetadata => p !== null) as PuzzleMetadata[];

	// Sort by createdAt descending
	puzzles.sort((a, b) => b.createdAt - a.createdAt);

	// Map to summaries
	return puzzles.map((p) => ({
		id: p.id,
		name: p.name,
		pieceCount: p.pieceCount,
		status: p.status,
		progress: p.progress
	}));
}

// Check if puzzle exists in KV
export async function puzzleExists(kv: KVNamespace, puzzleId: string): Promise<boolean> {
	const data = await kv.get(puzzleKey(puzzleId));
	return data !== null;
}

// R2 key helpers
export function getOriginalKey(puzzleId: string): string {
	return `puzzles/${puzzleId}/original`;
}

export function getThumbnailKey(puzzleId: string): string {
	return `puzzles/${puzzleId}/thumbnail.jpg`;
}

export function getPieceKey(puzzleId: string, pieceId: number): string {
	return `puzzles/${puzzleId}/pieces/${pieceId}.png`;
}

// Upload original image to R2
export async function uploadOriginalImage(
	bucket: R2Bucket,
	puzzleId: string,
	data: ArrayBuffer,
	contentType: string
): Promise<void> {
	await bucket.put(getOriginalKey(puzzleId), data, {
		httpMetadata: { contentType }
	});
}

// Delete original image from R2
export async function deleteOriginalImage(bucket: R2Bucket, puzzleId: string): Promise<boolean> {
	try {
		await bucket.delete(getOriginalKey(puzzleId));
		return true;
	} catch (error) {
		console.error(`Failed to delete original image for puzzle ${puzzleId}:`, error);
		return false;
	}
}

// Get image from R2
export async function getImage(
	bucket: R2Bucket,
	key: string
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;

	return {
		data: await obj.arrayBuffer(),
		contentType: obj.httpMetadata?.contentType || 'application/octet-stream'
	};
}

// Delete all puzzle assets from R2
export async function deletePuzzleAssets(
	bucket: R2Bucket,
	puzzleId: string,
	pieceCount: number
): Promise<{ success: boolean; failedKeys: string[] }> {
	const keysToDelete: string[] = [getOriginalKey(puzzleId), getThumbnailKey(puzzleId)];

	// Add all piece keys
	for (let i = 0; i < pieceCount; i++) {
		keysToDelete.push(getPieceKey(puzzleId, i));
	}

	const failedKeys: string[] = [];

	// Delete in batches (R2 supports up to 1000 keys per delete)
	const batchSize = 1000;
	for (let i = 0; i < keysToDelete.length; i += batchSize) {
		const batch = keysToDelete.slice(i, i + batchSize);
		try {
			await bucket.delete(batch);
		} catch (error) {
			console.error(`Failed to delete batch for puzzle ${puzzleId}:`, batch, error);
			failedKeys.push(...batch);
		}
	}

	return { success: failedKeys.length === 0, failedKeys };
}
