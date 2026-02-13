// Shared types for Jigsaw Puzzle Web App
// Based on data-model.md specification

import type { PuzzleProgress as PuzzleGenerationProgress } from '@perseus/types';

export type { PuzzleGenerationProgress };

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

export type PuzzleStatus = 'processing' | 'ready' | 'failed';

/**
 * Full puzzle metadata including status fields.
 * Used for admin operations like createPuzzle which returns processing status.
 */
export interface PuzzleMetadata extends Puzzle {
	status: PuzzleStatus;
	progress?: PuzzleGenerationProgress;
	version: number;
	error?: { message: string };
}

export interface PuzzleSummary {
	id: string;
	name: string;
	pieceCount: number;
	status: PuzzleStatus;
	progress?: PuzzleGenerationProgress;
}

export interface PlacedPiece {
	pieceId: number;
	x: number;
	y: number;
}

export interface PuzzleProgress {
	puzzleId: string;
	placedPieces: PlacedPiece[];
	lastUpdated: string;
}

// API request/response types
export interface CreatePuzzleRequest {
	name: string;
	pieceCount: number;
	image: File;
}

export interface CreatePuzzleResponse {
	puzzle: PuzzleMetadata;
}

export interface LoginRequest {
	passkey: string;
}

export interface LoginResponse {
	success: boolean;
	error?: string;
}

export interface PuzzleListResponse {
	puzzles: PuzzleSummary[];
}

export interface SessionResponse {
	authenticated: boolean;
}

export interface DeletePuzzleResponse {
	success: false;
	partialSuccess: true;
	warning: string;
	failedAssets: string[];
}

export interface ErrorResponse {
	error: string;
	message: string;
}
