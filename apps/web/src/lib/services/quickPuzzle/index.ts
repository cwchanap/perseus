import type { PuzzlePiece } from '$lib/types/puzzle';

import { TAB_RATIO, generateJigsawSvgMask } from '@perseus/types';

import { generateQuickPuzzle, type GenerateOptions } from './generator';
import { saveQuick, getQuick, listQuick as listQuickFromStorage, deleteQuick } from './storage';
import { QuickPuzzleValidationError, type QuickPieceMeta, type StoredQuickPuzzle } from './types';

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
		for (const piece of stored.pieces) {
			const bounds = computePieceBoundsFromMeta(piece, stored);
			urls.set(piece.id, await renderPieceFromBitmap(bitmap, piece, bounds));
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

interface PieceBounds {
	extractLeft: number;
	extractTop: number;
	extractWidth: number;
	extractHeight: number;
	targetWidth: number;
	targetHeight: number;
	offsetX: number;
	offsetY: number;
}

function computePieceBoundsFromMeta(piece: QuickPieceMeta, stored: StoredQuickPuzzle): PieceBounds {
	const rows = stored.gridRows;
	const cols = stored.gridCols;
	const srcW = stored.imageWidth;
	const srcH = stored.imageHeight;
	const row = piece.correctY;
	const col = piece.correctX;

	const basePieceWidth = Math.floor(srcW / cols);
	const extraWidth = srcW % cols;
	const basePieceHeight = Math.floor(srcH / rows);
	const extraHeight = srcH % rows;

	const baseWidth = basePieceWidth + (col === cols - 1 ? extraWidth : 0);
	const baseHeight = basePieceHeight + (row === rows - 1 ? extraHeight : 0);

	const overlapX = Math.floor(baseWidth * TAB_RATIO);
	const overlapY = Math.floor(baseHeight * TAB_RATIO);

	const targetWidth = baseWidth + 2 * overlapX;
	const targetHeight = baseHeight + 2 * overlapY;

	const baseLeft = col * basePieceWidth;
	const baseTop = row * basePieceHeight;
	const idealLeft = baseLeft - overlapX;
	const idealTop = baseTop - overlapY;

	const extractLeft = Math.max(0, idealLeft);
	const extractTop = Math.max(0, idealTop);
	const extractRight = Math.min(srcW, idealLeft + targetWidth);
	const extractBottom = Math.min(srcH, idealTop + targetHeight);

	const extractWidth = extractRight - extractLeft;
	const extractHeight = extractBottom - extractTop;
	const offsetX = extractLeft - idealLeft;
	const offsetY = extractTop - idealTop;

	return {
		extractLeft,
		extractTop,
		extractWidth,
		extractHeight,
		targetWidth,
		targetHeight,
		offsetX,
		offsetY
	};
}

function svgStringToImage(svg: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const blob = new Blob([svg], { type: 'image/svg+xml' });
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Failed to load SVG mask'));
		};
		img.src = url;
	});
}

async function renderPieceFromBitmap(
	source: ImageBitmap,
	piece: QuickPieceMeta,
	bounds: PieceBounds
): Promise<string> {
	const canvas = new OffscreenCanvas(bounds.targetWidth, bounds.targetHeight);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new QuickPuzzleValidationError(
			'unsupported-browser',
			"Your browser doesn't support quick puzzles."
		);
	}

	ctx.drawImage(
		source,
		bounds.extractLeft,
		bounds.extractTop,
		bounds.extractWidth,
		bounds.extractHeight,
		bounds.offsetX,
		bounds.offsetY,
		bounds.extractWidth,
		bounds.extractHeight
	);

	const svg = generateJigsawSvgMask(piece.edges, bounds.targetWidth, bounds.targetHeight);
	const maskImg = await svgStringToImage(svg);
	ctx.globalCompositeOperation = 'destination-in';
	ctx.drawImage(maskImg, 0, 0, bounds.targetWidth, bounds.targetHeight);
	ctx.globalCompositeOperation = 'source-over';

	const blob = await canvas.convertToBlob({ type: 'image/png' });
	return URL.createObjectURL(blob);
}
