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
