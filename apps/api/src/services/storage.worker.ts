// Worker-compatible storage service using KV for metadata and R2 for assets

import type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleMetadata,
	PuzzleStatus,
	PuzzleProgress
} from '@perseus/types';
import { validatePuzzleMetadata, validatePuzzleMetadataLight } from '@perseus/types';

// Re-export types so consumers don't need to import from @perseus/types directly
export type { EdgeType, EdgeConfig, PuzzlePiece, PuzzleMetadata, PuzzleStatus, PuzzleProgress };

export type LockResult =
	| { status: 'acquired'; token: string; ttlMs: number }
	| { status: 'held' }
	| { status: 'error'; error: Error };

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

// Distributed lock helpers for KV
export async function acquireLock(
	kv: KVNamespace,
	key: string,
	timeoutMs: number
): Promise<LockResult> {
	const lockValue = crypto.randomUUID();
	try {
		// Note: This lock is best-effort and non-atomic (TOCTOU race between get and put).
		// For strict mutual exclusion, consider using Durable Objects or another atomic lock mechanism.
		const existing = await kv.get(key);
		if (existing) {
			// Lock already held
			return { status: 'held' };
		}
		// KV enforces a minimum TTL of 60s; compute the actual TTL so callers know the real expiry
		const ttlSeconds = Math.max(Math.ceil(timeoutMs / 1000), 60);
		const ttlMs = ttlSeconds * 1000;
		await kv.put(key, lockValue, { expirationTtl: ttlSeconds });

		// Note: We intentionally skip verify-after-write here because KV is eventually
		// consistent — a read immediately after write may return stale data, causing
		// false negatives that make the lock permanently fail. The initial check-then-put
		// already has a TOCTOU window; an unreliable verify step only makes it worse.
		// For strict mutual exclusion, use Durable Objects.

		return { status: 'acquired', token: lockValue, ttlMs };
	} catch (error) {
		console.error('Failed to acquire lock:', error);
		return { status: 'error', error: error instanceof Error ? error : new Error(String(error)) };
	}
}

// Best-effort lock release. Returns true if the lock was deleted while our token was current,
// false otherwise. Note: KV does not support atomic compare-and-delete, so there is an
// inherent TOCTOU window between get and delete. For strict mutual exclusion, use Durable Objects.
export async function releaseLock(
	kv: KVNamespace,
	key: string,
	expectedToken: string
): Promise<boolean> {
	try {
		const currentToken = await kv.get(key);

		if (!currentToken) {
			console.warn(
				`Attempted to release lock ${key} but it doesn't exist (may have already expired)`
			);
			return false;
		}

		if (currentToken !== expectedToken) {
			console.warn(
				`Attempted to release lock ${key} but token doesn't match. Lock may have been taken over.`
			);
			return false;
		}

		await kv.delete(key);
		return true;
	} catch (error) {
		console.error('Failed to release lock:', error);
		// Re-throw to inform caller of lock release failure
		throw error;
	}
}

export async function getPuzzle(kv: KVNamespace, puzzleId: string): Promise<PuzzleMetadata | null> {
	const data = await kv.get(puzzleKey(puzzleId), 'json');
	if (data && !validatePuzzleMetadata(data)) {
		console.error(`Invalid puzzle metadata for ${puzzleId}:`, data);
		return null;
	}
	return data as PuzzleMetadata | null;
}

// Create initial puzzle metadata in KV (for processing state)
export async function createPuzzleMetadata(kv: KVNamespace, puzzle: PuzzleMetadata): Promise<void> {
	// Initialize version if not set
	const puzzleWithVersion = { ...puzzle, version: puzzle.version ?? 0 };
	await kv.put(puzzleKey(puzzleWithVersion.id), JSON.stringify(puzzleWithVersion));
}

// Update puzzle metadata via Durable Object for strong consistency
export async function updatePuzzleMetadata(
	metadataDO: DurableObjectNamespace,
	puzzleId: string,
	updates: Partial<PuzzleMetadata>
): Promise<void> {
	const id = metadataDO.idFromName(puzzleId);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/update', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ puzzleId, updates })
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(payload?.message ?? `Failed to update puzzle ${puzzleId}`);
	}
}

// Delete puzzle metadata from KV
export async function deletePuzzleMetadata(
	kv: KVNamespace,
	puzzleId: string
): Promise<{ success: boolean; error?: Error }> {
	try {
		await kv.delete(puzzleKey(puzzleId));
		return { success: true };
	} catch (error) {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		console.error(`Failed to delete puzzle metadata for ${puzzleId}:`, normalizedError);
		return { success: false, error: normalizedError };
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
	const nullCount = fetched.filter((p) => p === null).length;
	if (nullCount > 0) {
		console.warn(
			`listPuzzles: ${nullCount} keys returned null (data corruption or eventual consistency)`
		);
	}
	const puzzles: PuzzleMetadata[] = [];
	fetched.forEach((puzzle, index) => {
		if (puzzle === null) return;
		// Use lightweight validation for listing to avoid O(n*pieces) overhead
		if (!validatePuzzleMetadataLight(puzzle)) {
			console.warn(`Invalid puzzle metadata for ${keys[index].name}:`, puzzle);
			return;
		}
		puzzles.push(puzzle);
	});

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
export async function deleteOriginalImage(
	bucket: R2Bucket,
	puzzleId: string
): Promise<{ success: boolean; error?: Error }> {
	try {
		await bucket.delete(getOriginalKey(puzzleId));
		return { success: true };
	} catch (error) {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		console.error(`Failed to delete original image for puzzle ${puzzleId}:`, normalizedError);
		return { success: false, error: normalizedError };
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
