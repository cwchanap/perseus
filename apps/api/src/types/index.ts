// Shared types for Jigsaw Puzzle API
// Based on data-model.md specification

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

export interface PuzzleSummary {
	id: string;
	name: string;
	pieceCount: number;
}

export interface AdminSession {
	sessionId: string;
	createdAt: number;
	expiresAt: number;
}

// API request/response types
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

export interface ErrorResponse {
	error: string;
	message: string;
}

// Allowed piece counts for puzzle creation
export const ALLOWED_PIECE_COUNTS = [9, 16, 25, 36, 49, 64, 100] as const;
export type AllowedPieceCount = (typeof ALLOWED_PIECE_COUNTS)[number];

// File upload constraints
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
