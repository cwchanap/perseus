// Helper functions and constants for the workflows worker
// These are NOT exported from the main entry point to avoid workerd issues

import type { PuzzleMetadata } from './types';

// Maximum image size in bytes (50MB)
// This is a safety limit to prevent workflow step payload issues
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

// Helper to get puzzle metadata from KV
export async function getMetadata(
	kv: KVNamespace,
	puzzleId: string
): Promise<PuzzleMetadata | null> {
	const data = await kv.get(`puzzle:${puzzleId}`, 'json');
	if (data && !validatePuzzleMetadata(data)) {
		const diagnostics = getValidationDiagnostics(data);
		console.error(`Invalid puzzle metadata for ${puzzleId}: ${diagnostics}`);
		return null;
	}
	return data as PuzzleMetadata | null;
}

function getValidationDiagnostics(meta: unknown): string {
	const issues: string[] = [];
	if (typeof meta !== 'object' || meta === null) {
		return 'not an object';
	}
	const m = meta as Record<string, unknown>;
	if (typeof m.id !== 'string') issues.push('missing or invalid id');
	if (typeof m.name !== 'string') issues.push('missing or invalid name');
	if (typeof m.pieceCount !== 'number') issues.push('missing or invalid pieceCount');
	if (typeof m.gridCols !== 'number') issues.push('missing or invalid gridCols');
	if (typeof m.gridRows !== 'number') issues.push('missing or invalid gridRows');
	if (typeof m.imageWidth !== 'number') issues.push('missing or invalid imageWidth');
	if (typeof m.imageHeight !== 'number') issues.push('missing or invalid imageHeight');
	if (typeof m.createdAt !== 'number') issues.push('missing or invalid createdAt');
	if (typeof m.version !== 'number') issues.push('missing or invalid version');
	if (!Array.isArray(m.pieces)) issues.push('pieces is not an array');
	if (typeof m.status !== 'string') issues.push('missing or invalid status');
	if (
		typeof m.gridCols === 'number' &&
		typeof m.gridRows === 'number' &&
		typeof m.pieceCount === 'number' &&
		m.gridCols * m.gridRows !== m.pieceCount
	) {
		issues.push(`grid math mismatch: ${m.gridCols}x${m.gridRows} != ${m.pieceCount}`);
	}
	return issues.length > 0 ? issues.join(', ') : 'unknown validation failure';
}

// Import the validation function from types (needed for the helper)
import { validatePuzzleMetadata } from './types';

export async function updateMetadata(
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

export function padPixelsToTarget(
	sourcePixels: Uint8Array,
	sourceWidth: number,
	sourceHeight: number,
	targetWidth: number,
	targetHeight: number,
	offsetX: number,
	offsetY: number
): Uint8Array {
	const padded = new Uint8Array(targetWidth * targetHeight * 4);
	const rowBytes = sourceWidth * 4;
	for (let y = 0; y < sourceHeight; y += 1) {
		const sourceStart = y * rowBytes;
		const targetStart = ((y + offsetY) * targetWidth + offsetX) * 4;
		padded.set(sourcePixels.subarray(sourceStart, sourceStart + rowBytes), targetStart);
	}
	return padded;
}

export function applyMaskAlpha(piecePixels: Uint8Array, maskPixels: Uint8Array): void {
	for (let i = 0; i < piecePixels.length; i += 4) {
		piecePixels[i + 3] = maskPixels[i + 3];
	}
}
