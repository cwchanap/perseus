// Shared types for Jigsaw Puzzle Web App
// Types shared with the API are imported from @perseus/types

import type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleStatus,
	PuzzleProgress as PuzzleGenerationProgress,
	PuzzleMetadata,
	PuzzleSummary,
	LoginResponse,
	SessionResponse,
	PuzzleListResponse,
	ErrorResponse
} from '@perseus/types';

// Re-export shared types for convenience
export type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleStatus,
	PuzzleGenerationProgress,
	PuzzleMetadata,
	PuzzleSummary,
	LoginResponse,
	SessionResponse,
	PuzzleListResponse,
	ErrorResponse
};

/**
 * Flat puzzle shape for component props (no status/version fields).
 */
export interface Puzzle {
	id: string;
	name: string;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	imageWidth: number;
	imageHeight: number;
	createdAt: number;
	pieces: PuzzlePiece[];
}

export interface PlacedPiece {
	pieceId: number;
	x: number;
	y: number;
}

/** Game-play progress tracking (local to the web app). */
export interface GameProgress {
	puzzleId: string;
	placedPieces: PlacedPiece[];
	lastUpdated: string;
}

// API request/response types (web-only)
export interface CreatePuzzleRequest {
	name: string;
	pieceCount: number;
	image: File;
}

export interface CreatePuzzleResponse {
	puzzle: PuzzleMetadata;
}

// Discriminated union for delete puzzle response
export interface DeletePuzzleSuccess {
	success: true;
	deletedIds: string[];
}

export interface DeletePuzzlePartialSuccess {
	success: false;
	partialSuccess: true;
	warning: string;
	failedAssets: string[];
}

export interface DeletePuzzleFailure {
	success: false;
	partialSuccess: false;
	error: string;
}

export type DeletePuzzleResponse =
	| DeletePuzzleSuccess
	| DeletePuzzlePartialSuccess
	| DeletePuzzleFailure;
