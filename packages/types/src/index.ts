// Shared types for Perseus monorepo
// Eliminates duplication between api and workflows packages

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

export type PuzzleStatus = 'processing' | 'ready' | 'failed';

export interface PuzzleProgress {
	totalPieces: number;
	generatedPieces: number;
	updatedAt: number;
}

interface PuzzleMetadataBase {
	id: string;
	name: string;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	imageWidth: number;
	imageHeight: number;
	createdAt: number;
	pieces: PuzzlePiece[];
	version: number;
}

export interface ProcessingPuzzle extends PuzzleMetadataBase {
	status: 'processing';
	progress: PuzzleProgress;
	error?: never;
}

export interface ReadyPuzzle extends PuzzleMetadataBase {
	status: 'ready';
	progress?: never;
	error?: never;
}

export interface FailedPuzzle extends PuzzleMetadataBase {
	status: 'failed';
	progress?: never;
	error: { message: string };
}

export type PuzzleMetadata = ProcessingPuzzle | ReadyPuzzle | FailedPuzzle;

export interface WorkflowParams {
	puzzleId: string;
}

// Puzzle piece sizing constants
export const TAB_RATIO = 0.2; // Tab depth as fraction of piece dimension (20% extension on each side)
export const EXPANSION_FACTOR = 1 + 2 * TAB_RATIO; // 1.4 (140%)

// Generation constraints
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_PIECES = 250;
export const DEFAULT_PIECE_COUNT = 225; // 15x15

// Thumbnail settings
export const THUMBNAIL_SIZE = 300;

// Validation functions

export function validateEdgeConfig(edges: unknown): edges is EdgeConfig {
	if (typeof edges !== 'object' || edges === null) return false;
	const e = edges as Record<string, unknown>;
	const validTypes: EdgeType[] = ['flat', 'tab', 'blank'];
	return ['top', 'right', 'bottom', 'left'].every((dir) => validTypes.includes(e[dir] as EdgeType));
}

export function validateWorkflowParams(params: unknown): params is WorkflowParams {
	if (typeof params !== 'object' || params === null) return false;
	const p = params as Record<string, unknown>;
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return typeof p.puzzleId === 'string' && uuidRegex.test(p.puzzleId);
}

export function createPuzzleProgress(totalPieces: number, generatedPieces: number): PuzzleProgress {
	if (!Number.isFinite(totalPieces) || !Number.isInteger(totalPieces)) {
		throw new Error('totalPieces must be a finite integer');
	}
	if (!Number.isFinite(generatedPieces) || !Number.isInteger(generatedPieces)) {
		throw new Error('generatedPieces must be a finite integer');
	}
	if (totalPieces <= 0) throw new Error('totalPieces must be positive');
	if (generatedPieces < 0) throw new Error('generatedPieces cannot be negative');
	if (generatedPieces > totalPieces) throw new Error('generatedPieces exceeds totalPieces');
	return { totalPieces, generatedPieces, updatedAt: Date.now() };
}

export function validatePuzzleMetadata(meta: unknown): meta is PuzzleMetadata {
	if (typeof meta !== 'object' || meta === null) return false;
	const m = meta as Partial<PuzzleMetadata>;
	const isNumber = (value: unknown): value is number =>
		typeof value === 'number' && Number.isFinite(value);
	const validStatuses: PuzzleStatus[] = ['processing', 'ready', 'failed'];

	const hasValidProgress = (value: unknown): value is PuzzleProgress => {
		if (typeof value !== 'object' || value === null) return false;
		const progress = value as Record<string, unknown>;
		return (
			isNumber(progress.totalPieces) &&
			isNumber(progress.generatedPieces) &&
			isNumber(progress.updatedAt)
		);
	};

	// Check required fields exist
	if (typeof m.id !== 'string' || typeof m.name !== 'string') return false;
	if (!isNumber(m.pieceCount) || !isNumber(m.gridCols) || !isNumber(m.gridRows)) return false;
	if (!isNumber(m.imageWidth) || !isNumber(m.imageHeight)) return false;
	if (!isNumber(m.createdAt) || !isNumber(m.version)) return false;
	if (!Array.isArray(m.pieces)) return false;
	if (!m.status || !validStatuses.includes(m.status)) return false;

	// Validate grid math
	if (m.gridCols * m.gridRows !== m.pieceCount) return false;

	// Validate status-field consistency
	if (m.status === 'processing') {
		if (!hasValidProgress(m.progress)) return false;
		const errorValue = (m as Record<string, unknown>).error;
		if (typeof errorValue !== 'undefined' && errorValue !== null) return false;
	}
	if (m.status === 'failed') {
		const progressValue = (m as Record<string, unknown>).progress;
		if (typeof progressValue !== 'undefined' && progressValue !== null) return false;
		if (typeof m.error !== 'object' || m.error === null) return false;
		const error = m.error as Record<string, unknown>;
		if (typeof error.message !== 'string') return false;
	}
	if (m.status === 'ready') {
		if (m.pieces.length !== m.pieceCount) return false;
		const errorValue = (m as Record<string, unknown>).error;
		if (typeof errorValue !== 'undefined' && errorValue !== null) return false;
		const progressValue = (m as Record<string, unknown>).progress;
		if (typeof progressValue !== 'undefined' && progressValue !== null) return false;
	}

	return true;
}
