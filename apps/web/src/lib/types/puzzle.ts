// Shared types for Jigsaw Puzzle Web App
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
  thumbnailUrl: string;
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
  puzzle: Puzzle;
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

export interface ErrorResponse {
  error: string;
  message: string;
}
