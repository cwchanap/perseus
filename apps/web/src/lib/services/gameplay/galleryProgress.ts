import {
	getGridDimensionsForAspectRatio,
	isPuzzleAspectRatio,
	isValidPieceCountForAspectRatio
} from '@perseus/types';
import type { PuzzleSummary } from '$lib/types/puzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
import { createSessionStorageAdapter } from './session/persistence';
import type {
	PuzzleSourceType,
	SessionStorageAdapter,
	SessionValidationContext
} from './session/types';

export interface GalleryProgress {
	puzzleId: string;
	name: string;
	source: PuzzleSourceType;
	placedCount: number;
	pieceCount: number;
	lastUpdated: number;
}

export interface GalleryProgressDiscovery {
	byPuzzleId: ReadonlyMap<string, GalleryProgress>;
	newest: GalleryProgress | null;
}

interface GalleryCandidate {
	puzzleId: string;
	name: string;
	source: PuzzleSourceType;
	pieceCount: number;
	context: SessionValidationContext;
}

function serverValidationContext(puzzle: PuzzleSummary): SessionValidationContext | null {
	if (puzzle.status !== 'ready') return null;
	if (!isPuzzleAspectRatio(puzzle.aspectRatio)) return null;
	if (!isValidPieceCountForAspectRatio(puzzle.pieceCount, puzzle.aspectRatio)) return null;

	const { rows, cols } = getGridDimensionsForAspectRatio(puzzle.pieceCount, puzzle.aspectRatio);
	const pieces = Array.from({ length: puzzle.pieceCount }, (_, id) => ({
		id,
		correctX: id % cols,
		correctY: Math.floor(id / cols)
	}));

	return {
		puzzleId: puzzle.id,
		source: 'api',
		pieceIds: pieces.map((piece) => piece.id),
		gridCols: cols,
		gridRows: rows,
		pieceCount: puzzle.pieceCount,
		pieces
	};
}

function quickValidationContext(puzzle: StoredQuickPuzzle): SessionValidationContext | null {
	if (!puzzle || typeof puzzle !== 'object') return null;
	if (
		typeof puzzle.id !== 'string' ||
		typeof puzzle.pieceCount !== 'number' ||
		!Number.isInteger(puzzle.pieceCount) ||
		puzzle.pieceCount <= 0 ||
		typeof puzzle.gridCols !== 'number' ||
		!Number.isInteger(puzzle.gridCols) ||
		puzzle.gridCols <= 0 ||
		typeof puzzle.gridRows !== 'number' ||
		!Number.isInteger(puzzle.gridRows) ||
		puzzle.gridRows <= 0 ||
		!Array.isArray(puzzle.pieces) ||
		puzzle.pieces.length !== puzzle.pieceCount
	) {
		return null;
	}

	const pieces: Array<{ id: number; correctX: number; correctY: number }> = [];
	const pieceIds = new Set<number>();
	const cells = new Set<string>();
	for (const piece of puzzle.pieces) {
		if (!piece || typeof piece !== 'object') return null;
		const { id, correctX, correctY } = piece;
		if (
			typeof id !== 'number' ||
			!Number.isInteger(id) ||
			id < 0 ||
			id >= puzzle.pieceCount ||
			pieceIds.has(id) ||
			typeof correctX !== 'number' ||
			!Number.isInteger(correctX) ||
			correctX < 0 ||
			correctX >= puzzle.gridCols ||
			typeof correctY !== 'number' ||
			!Number.isInteger(correctY) ||
			correctY < 0 ||
			correctY >= puzzle.gridRows
		) {
			return null;
		}

		const cell = `${correctX},${correctY}`;
		if (cells.has(cell)) return null;
		pieceIds.add(id);
		cells.add(cell);
		pieces.push({ id, correctX, correctY });
	}

	return {
		puzzleId: puzzle.id,
		source: 'local',
		pieceIds: pieces.map((piece) => piece.id),
		gridCols: puzzle.gridCols,
		gridRows: puzzle.gridRows,
		pieceCount: puzzle.pieceCount,
		pieces
	};
}

export function discoverGalleryProgress(options: {
	serverPuzzles: readonly PuzzleSummary[];
	quickPuzzles: readonly StoredQuickPuzzle[];
	sessionStorage?: SessionStorageAdapter;
}): GalleryProgressDiscovery {
	const sessionStorage = options.sessionStorage ?? createSessionStorageAdapter();
	const byPuzzleId = new Map<string, GalleryProgress>();
	let newest: GalleryProgress | null = null;

	const candidates: GalleryCandidate[] = [];
	for (const puzzle of options.serverPuzzles) {
		const context = serverValidationContext(puzzle);
		if (!context) continue;
		candidates.push({
			puzzleId: puzzle.id,
			name: puzzle.name,
			source: 'api',
			pieceCount: puzzle.pieceCount,
			context
		});
	}
	for (const puzzle of options.quickPuzzles) {
		const context = quickValidationContext(puzzle);
		if (!context) continue;
		candidates.push({
			puzzleId: puzzle.id,
			name: puzzle.name,
			source: 'local',
			pieceCount: puzzle.pieceCount,
			context
		});
	}

	for (const candidate of candidates) {
		const result = sessionStorage.peekSession(candidate.puzzleId, candidate.context);
		if (result.status !== 'loaded') continue;
		if (!sessionStorage.isResumable(result.snapshot)) continue;

		const progress: GalleryProgress = {
			puzzleId: candidate.puzzleId,
			name: candidate.name,
			source: candidate.source,
			placedCount: result.snapshot.placedPieces.length,
			pieceCount: candidate.pieceCount,
			lastUpdated: result.snapshot.lastUpdated
		};

		if (candidate.source === 'api') byPuzzleId.set(candidate.puzzleId, progress);
		if (newest === null || progress.lastUpdated > newest.lastUpdated) newest = progress;
	}

	return { byPuzzleId, newest };
}
