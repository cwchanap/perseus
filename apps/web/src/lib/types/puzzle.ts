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
	PlayerUser,
	PlayerSessionResponse,
	PlayerAllowlistEntry,
	PlayerAllowlistResponse,
	PlayerAllowlistMutationResponse,
	PlayerProfile,
	PlayerProfileUpdate,
	PlayerPuzzleSummary,
	PlayerStatRow,
	PuzzleListResponse,
	ErrorResponse,
	PuzzleCategory,
	PuzzleAspectRatio,
	PuzzleFamilySummary,
	PuzzleVariantSummary,
	PuzzleFamilyMetadata,
	PuzzleFamilyListResponse,
	PlayerProgressionSummary,
	PuzzleLeaderboardResponse,
	OverallLeaderboardResponse,
	CompletionAwards
} from '@perseus/types';
import type { PlacedPiece, Rotation } from '@perseus/game-core';
import type { PuzzleDifficulty } from '@perseus/types';

// Re-export shared types for convenience
export type {
	EdgeType,
	EdgeConfig,
	PuzzlePiece,
	PuzzleStatus,
	PuzzleGenerationProgress,
	PuzzleMetadata,
	PuzzleSummary,
	PlayerUser,
	PlayerSessionResponse,
	PlayerAllowlistEntry,
	PlayerAllowlistResponse,
	PlayerAllowlistMutationResponse,
	PlayerProfile,
	PlayerProfileUpdate,
	PlayerPuzzleSummary,
	PlayerStatRow,
	PuzzleListResponse,
	ErrorResponse,
	PuzzleCategory,
	PuzzleAspectRatio,
	PuzzleFamilySummary,
	PuzzleVariantSummary,
	PuzzleFamilyMetadata,
	PuzzleFamilyListResponse,
	PlayerProgressionSummary,
	PuzzleLeaderboardResponse,
	OverallLeaderboardResponse,
	CompletionAwards
};

/** Player-owned family row from GET /api/player/puzzle-families (no variant ids). */
export interface PlayerOwnedFamilySummary {
	id: string;
	name: string;
	category?: PuzzleCategory;
	aspectRatio: PuzzleAspectRatio;
	status: PuzzleStatus;
	createdAt: number;
}

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
	category?: PuzzleCategory;
	hasReference?: boolean;
	familyId?: string;
	difficulty?: PuzzleDifficulty;
}

/** Game-play progress tracking (local to the web app). */
export interface GameProgress {
	puzzleId: string;
	placedPieces: PlacedPiece[];
	rotationEnabled: boolean;
	pieceRotations: Record<number, Rotation>;
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
