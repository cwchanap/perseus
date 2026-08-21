import {
	getGridDimensionsForAspectRatio,
	isPuzzleAspectRatio,
	isValidPieceCountForAspectRatio
} from '@perseus/types';
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
import { QUICK_PUZZLE_ID_PREFIX } from '$lib/services/quickPuzzle/types';
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

export interface GalleryProgressDiscoveryResult {
	rows: GalleryProgress[];
	/** `false` when at least one off-page detail fetch failed transiently (network/5xx). */
	complete: boolean;
}

/**
 * Determines whether a failed detail fetch is authoritative (permanent) rather
 * than transient. Only 400 (malformed puzzle id) qualifies — id format is
 * locally verifiable and permanent. 404 does NOT: the public detail endpoint
 * reads puzzle metadata from KV, which is eventually consistent. The same 404
 * is returned for a missing record, a non-ready record, and a stale KV read
 * where the metadata DO has already committed `ready` (the reaper uses a
 * separate strongly consistent DO lookup for exactly this reason). Purging a
 * persisted session on 404 would irreversibly delete a valid local save over
 * a stale read, so 404 is treated as retryable: the session is kept and
 * discovery is marked incomplete.
 */
function isAuthoritativeFetchFailure(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const status = (error as { status?: unknown }).status;
	return status === 400;
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

function explicitValidationContext(input: {
	puzzleId: string;
	source: PuzzleSourceType;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	pieces: readonly unknown[];
}): SessionValidationContext | null {
	if (!input.puzzleId) return null;
	if (!Number.isInteger(input.pieceCount) || input.pieceCount <= 0) return null;
	if (!Number.isInteger(input.gridCols) || input.gridCols <= 0) return null;
	if (!Number.isInteger(input.gridRows) || input.gridRows <= 0) return null;
	if (input.gridCols * input.gridRows !== input.pieceCount) return null;
	if (!Array.isArray(input.pieces) || input.pieces.length !== input.pieceCount) return null;

	const pieces: Array<{ id: number; correctX: number; correctY: number }> = [];
	const ids = new Set<number>();
	const cells = new Set<string>();
	for (const rawPiece of input.pieces) {
		if (!rawPiece || typeof rawPiece !== 'object') return null;
		const { id, correctX, correctY } = rawPiece as Record<string, unknown>;
		if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= input.pieceCount) {
			return null;
		}
		if (ids.has(id)) return null;
		if (
			typeof correctX !== 'number' ||
			!Number.isInteger(correctX) ||
			correctX < 0 ||
			correctX >= input.gridCols
		) {
			return null;
		}
		if (
			typeof correctY !== 'number' ||
			!Number.isInteger(correctY) ||
			correctY < 0 ||
			correctY >= input.gridRows
		) {
			return null;
		}
		const cell = `${correctX},${correctY}`;
		if (cells.has(cell)) return null;
		ids.add(id);
		cells.add(cell);
		pieces.push({ id, correctX, correctY });
	}

	return {
		puzzleId: input.puzzleId,
		source: input.source,
		pieceIds: pieces.map((piece) => piece.id),
		gridCols: input.gridCols,
		gridRows: input.gridRows,
		pieceCount: input.pieceCount,
		pieces
	};
}

function quickValidationContext(puzzle: StoredQuickPuzzle): SessionValidationContext | null {
	if (!puzzle || typeof puzzle !== 'object') return null;
	if (typeof puzzle.id !== 'string' || !puzzle.id.startsWith(QUICK_PUZZLE_ID_PREFIX)) return null;

	return explicitValidationContext({
		puzzleId: puzzle.id,
		source: 'local',
		pieceCount: puzzle.pieceCount,
		gridCols: puzzle.gridCols,
		gridRows: puzzle.gridRows,
		pieces: puzzle.pieces
	});
}

function progressFromCandidate(
	candidate: GalleryCandidate,
	sessionStorage: SessionStorageAdapter
): GalleryProgress | null {
	const result = sessionStorage.peekSession(candidate.puzzleId, candidate.context);
	if (result.status !== 'loaded' || !sessionStorage.isResumable(result.snapshot)) return null;
	return {
		puzzleId: candidate.puzzleId,
		name: candidate.name,
		source: candidate.source,
		placedCount: result.snapshot.placedPieces.length,
		pieceCount: candidate.pieceCount,
		lastUpdated: result.snapshot.lastUpdated
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
		const progress = progressFromCandidate(candidate, sessionStorage);
		if (!progress) continue;

		if (candidate.source === 'api') byPuzzleId.set(candidate.puzzleId, progress);
		if (newest === null || progress.lastUpdated > newest.lastUpdated) newest = progress;
	}

	return { byPuzzleId, newest };
}

export async function discoverAllSavedProgress(options: {
	puzzleIds: readonly string[];
	serverPuzzles: readonly PuzzleSummary[];
	quickPuzzles: readonly StoredQuickPuzzle[];
	fetchPuzzleById: (puzzleId: string, signal?: AbortSignal) => Promise<Puzzle>;
	sessionStorage?: SessionStorageAdapter;
	signal?: AbortSignal;
}): Promise<GalleryProgressDiscoveryResult> {
	const sessionStorage = options.sessionStorage ?? createSessionStorageAdapter();
	const serverById = new Map(options.serverPuzzles.map((puzzle) => [puzzle.id, puzzle] as const));
	const quickById = new Map(options.quickPuzzles.map((puzzle) => [puzzle.id, puzzle] as const));
	const signal = options.signal;

	let hadFetchFailure = false;

	const candidates = await Promise.all(
		[...new Set(options.puzzleIds)].map(async (puzzleId): Promise<GalleryCandidate | null> => {
			if (signal?.aborted) return null;
			if (puzzleId.startsWith(QUICK_PUZZLE_ID_PREFIX)) {
				const puzzle = quickById.get(puzzleId);
				if (!puzzle) return null;
				const context = quickValidationContext(puzzle);
				return context
					? { puzzleId, name: puzzle.name, source: 'local', pieceCount: puzzle.pieceCount, context }
					: null;
			}

			const summary = serverById.get(puzzleId);
			if (summary) {
				const context = serverValidationContext(summary);
				return context
					? {
							puzzleId,
							name: summary.name,
							source: 'api',
							pieceCount: summary.pieceCount,
							context
						}
					: null;
			}

			try {
				const puzzle = await options.fetchPuzzleById(puzzleId, signal);
				if (signal?.aborted) return null;
				if (puzzle.id !== puzzleId) return null;
				const context = explicitValidationContext({
					puzzleId: puzzle.id,
					source: 'api',
					pieceCount: puzzle.pieceCount,
					gridCols: puzzle.gridCols,
					gridRows: puzzle.gridRows,
					pieces: puzzle.pieces
				});
				return context
					? { puzzleId, name: puzzle.name, source: 'api', pieceCount: puzzle.pieceCount, context }
					: null;
			} catch (error) {
				// 400 (malformed id) is authoritative: purge the dead persisted
				// session and keep discovery complete. Everything else — network
				// errors, 5xx, and 404 — is retryable. A 404 can be a stale
				// eventually-consistent KV read (detail endpoint serves both
				// missing and non-ready records as 404), so it must not delete
				// the save; it marks discovery incomplete so the caller retries.
				if (isAuthoritativeFetchFailure(error)) {
					sessionStorage.clearSession(puzzleId);
				} else {
					hadFetchFailure = true;
				}
				return null;
			}
		})
	);

	if (signal?.aborted) return { rows: [], complete: true };

	const rows = candidates
		.flatMap((candidate) => {
			if (!candidate) return [];
			const result = sessionStorage.peekSession(candidate.puzzleId, candidate.context);
			// Structurally corrupt snapshot (malformed tray order, counters,
			// result-class, geometry, etc.). Unlike a valid-but-non-resumable
			// snapshot (e.g. a completed session), an invalid record can
			// never be resumed and would re-surface on every shallow mount
			// probe via listResumableSessionCandidateIds. Purge it during
			// authoritative discovery so the shallow probe stays cheap and
			// the dead VIEW SAVED PROGRESS affordance does not reappear
			// after reload. Valid-but-non-resumable snapshots (status
			// 'loaded' + !isResumable, e.g. completed sessions) are kept.
			if (result.status === 'invalid') {
				sessionStorage.clearSession(candidate.puzzleId);
				return [];
			}
			if (result.status !== 'loaded' || !sessionStorage.isResumable(result.snapshot)) {
				return [];
			}
			return [
				{
					puzzleId: candidate.puzzleId,
					name: candidate.name,
					source: candidate.source,
					placedCount: result.snapshot.placedPieces.length,
					pieceCount: candidate.pieceCount,
					lastUpdated: result.snapshot.lastUpdated
				}
			];
		})
		.sort((a, b) => b.lastUpdated - a.lastUpdated || a.puzzleId.localeCompare(b.puzzleId));

	return { rows, complete: !hadFetchFailure };
}
