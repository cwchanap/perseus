import type { PuzzlePiece } from '$lib/types/puzzle';

import { generateQuickPuzzle, type GenerateOptions } from './generator';
import { computePieceBounds, renderPiece } from './render';
import { saveQuick, getQuick, listQuick as listQuickFromStorage, deleteQuick } from './storage';
import type { QuickPieceMeta, StoredQuickPuzzle } from './types';

export interface OpenedQuickPuzzle {
	stored: StoredQuickPuzzle;
	/**
	 * Resolves a piece's image to its in-memory blob URL.
	 * Throws if `evictBlobUrls(stored.id)` or `removeQuick(stored.id)` has been called.
	 * Callers must avoid resolving piece images after triggering cache eviction.
	 */
	resolvePieceImage: (piece: Pick<PuzzlePiece | QuickPieceMeta, 'id'>) => string;
	resolveReferenceImage: () => string;
}

// Module-level caches:
//  - pieceUrlCache: puzzleId -> (pieceId -> object URL) — populated whenever piece bitmaps exist for this session.
//  - sessionOnlyMetadata: puzzleId -> StoredQuickPuzzle — for puzzles whose persist failed (quota), so the
//    play page can still find them via openQuick within the same session. Cleared when evictBlobUrls is called.
const pieceUrlCache = new Map<string, Map<number, string>>();
const sessionOnlyMetadata = new Map<string, StoredQuickPuzzle>();

function setCache(id: string, urls: Map<number, string>): void {
	const existing = pieceUrlCache.get(id);
	if (existing) {
		for (const url of existing.values()) URL.revokeObjectURL(url);
	}
	pieceUrlCache.set(id, urls);
}

export function evictBlobUrls(id: string): void {
	const urls = pieceUrlCache.get(id);
	if (urls) {
		for (const url of urls.values()) URL.revokeObjectURL(url);
		pieceUrlCache.delete(id);
	}
	// NOTE: session-only metadata is intentionally preserved here.
	// The play page calls this on unmount; the puzzle must remain reopenable
	// for the rest of the session until removeQuick or page reload.
}

function buildResolver(stored: StoredQuickPuzzle) {
	return (piece: Pick<PuzzlePiece | QuickPieceMeta, 'id'>): string => {
		const urls = pieceUrlCache.get(stored.id);
		const url = urls?.get(piece.id);
		if (!url) {
			throw new Error(
				`Quick puzzle ${stored.id} piece ${piece.id} unavailable (cache evicted or not rendered)`
			);
		}
		return url;
	};
}

/**
 * Create + persist a new quick puzzle. Returns the stored record, whether it was
 * persisted to localStorage, and its in-memory piece blob-URL map (already cached).
 */
export async function createQuick(
	file: File,
	pieceCount: number,
	name: string,
	options: GenerateOptions = {}
): Promise<{ stored: StoredQuickPuzzle; persisted: boolean }> {
	const { stored, pieceBlobUrls } = await generateQuickPuzzle(file, pieceCount, name, options);
	setCache(stored.id, pieceBlobUrls);

	const { persisted } = saveQuick(stored);
	if (!persisted) {
		// Keep metadata in memory so openQuick can find this puzzle for the rest of the session.
		sessionOnlyMetadata.set(stored.id, stored);
	}
	return { stored, persisted };
}

/**
 * Re-open a stored quick puzzle. Returns null if not found or expired.
 * Lazily re-renders piece bitmaps from the stored data URL if the in-memory cache is empty.
 * Falls back to in-memory session-only metadata for puzzles that failed to persist.
 */
export async function openQuick(id: string): Promise<OpenedQuickPuzzle | null> {
	const stored = getQuick(id) ?? sessionOnlyMetadata.get(id) ?? null;
	if (!stored) return null;

	let urls = pieceUrlCache.get(id);
	if (!urls) {
		urls = await renderPiecesFromStored(stored);
		setCache(id, urls);
	}

	return {
		stored,
		resolvePieceImage: buildResolver(stored),
		resolveReferenceImage: () => stored.imageDataUrl
	};
}

/**
 * Direct accessor for the reference image. Checks both persisted storage and the
 * session-only metadata cache.
 */
export function getReferenceImage(id: string): string | null {
	const stored = getQuick(id) ?? sessionOnlyMetadata.get(id) ?? null;
	return stored ? stored.imageDataUrl : null;
}

export function listQuick(): StoredQuickPuzzle[] {
	return listQuickFromStorage();
}

export function removeQuick(id: string): void {
	evictBlobUrls(id);
	sessionOnlyMetadata.delete(id);
	deleteQuick(id);
}

// ---------------------------------------------------------------------------
// Lazy piece re-rendering (used on reopen)
// ---------------------------------------------------------------------------

async function renderPiecesFromStored(stored: StoredQuickPuzzle): Promise<Map<number, string>> {
	const bitmap = await loadDataUrlAsBitmap(stored.imageDataUrl);
	try {
		const urls = new Map<number, string>();
		const grid = {
			rows: stored.gridRows,
			cols: stored.gridCols,
			srcWidth: stored.imageWidth,
			srcHeight: stored.imageHeight
		};
		for (const piece of stored.pieces) {
			const bounds = computePieceBounds(piece.correctY, piece.correctX, grid);
			urls.set(piece.id, await renderPiece(bitmap, piece, bounds));
		}
		return urls;
	} finally {
		bitmap.close?.();
	}
}

async function loadDataUrlAsBitmap(dataUrl: string): Promise<ImageBitmap> {
	const res = await fetch(dataUrl);
	const blob = await res.blob();
	return createImageBitmap(blob);
}
