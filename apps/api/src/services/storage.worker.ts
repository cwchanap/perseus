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

// Get puzzle metadata from KV
export async function getPuzzle(kv: KVNamespace, puzzleId: string): Promise<PuzzleMetadata | null> {
	const data = await kv.get(puzzleKey(puzzleId), 'json');
	return data as PuzzleMetadata | null;
}

// Create initial puzzle metadata in KV (for processing state)
export async function createPuzzleMetadata(kv: KVNamespace, puzzle: PuzzleMetadata): Promise<void> {
	await kv.put(puzzleKey(puzzle.id), JSON.stringify(puzzle));
}

// Update puzzle metadata in KV
export async function updatePuzzleMetadata(
	kv: KVNamespace,
	puzzleId: string,
	updates: Partial<PuzzleMetadata>
): Promise<void> {
	const existing = await getPuzzle(kv, puzzleId);
	if (!existing) {
		throw new Error(`Puzzle ${puzzleId} not found`);
	}
	const updated = { ...existing, ...updates };
	await kv.put(puzzleKey(puzzleId), JSON.stringify(updated));
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
	const list = await kv.list({ prefix: 'puzzle:' });
	const puzzles: PuzzleMetadata[] = [];

	// Fetch all puzzle metadata
	for (const key of list.keys) {
		const data = await kv.get(key.name, 'json');
		if (data) {
			puzzles.push(data as PuzzleMetadata);
		}
	}

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
): Promise<void> {
	const keysToDelete: string[] = [getOriginalKey(puzzleId), getThumbnailKey(puzzleId)];

	// Add all piece keys
	for (let i = 0; i < pieceCount; i++) {
		keysToDelete.push(getPieceKey(puzzleId, i));
	}

	// Delete in batches (R2 supports up to 1000 keys per delete)
	const batchSize = 1000;
	for (let i = 0; i < keysToDelete.length; i += batchSize) {
		const batch = keysToDelete.slice(i, i + batchSize);
		await bucket.delete(batch);
	}
}
