// Shared types for Perseus monorepo
// Eliminates duplication between api and workflows packages

import {
	isPuzzleAspectRatio,
	isValidPieceCountForAspectRatio,
	getGridDimensionsForAspectRatio
} from './grid';
import type { PuzzleAspectRatio } from './grid';

export type EdgeType = 'flat' | 'tab' | 'blank';

export type { PuzzleAspectRatio } from './grid';

export {
	PUZZLE_ASPECT_RATIOS,
	DEFAULT_PUZZLE_ASPECT_RATIO,
	getGridDimensionsForAspectRatio,
	isValidPieceCountForAspectRatio,
	getAllowedPieceCountsForAspectRatio
} from './grid';
export { isPuzzleAspectRatio };

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

// Puzzle categories
export const PUZZLE_CATEGORIES = [
	'Animals',
	'Nature',
	'Art',
	'Architecture',
	'Abstract',
	'Food',
	'Travel'
] as const;

export type PuzzleCategory = (typeof PUZZLE_CATEGORIES)[number];

export interface PuzzleProgress {
	totalPieces: number;
	generatedPieces: number;
	updatedAt: number;
}

interface PuzzleMetadataBase {
	id: string;
	name: string;
	category?: PuzzleCategory;
	aspectRatio?: PuzzleAspectRatio;
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

export interface PuzzleSummary {
	id: string;
	name: string;
	pieceCount: number;
	status: PuzzleStatus;
	progress?: PuzzleProgress;
	category?: PuzzleCategory;
	aspectRatio?: PuzzleAspectRatio;
}

// API response types shared between API and web
export interface LoginResponse {
	success: boolean;
	error?: string;
}

export interface SessionResponse {
	authenticated: boolean;
}

export interface PlayerUser {
	id: string;
	email: string;
	name?: string;
	picture?: string;
	createdAt: number;
	lastLoginAt: number;
}

export type PlayerSessionResponse =
	| { authenticated: true; user: PlayerUser }
	| { authenticated: false; user?: undefined };

export interface PlayerAllowlistEntry {
	email: string;
	createdAt: number;
	addedBy: string;
	player?: PlayerUser;
}

export interface PlayerAllowlistResponse {
	entries: PlayerAllowlistEntry[];
}

export interface PlayerAllowlistMutationResponse {
	entry: PlayerAllowlistEntry;
}

export interface PlayerProfileSummary {
	puzzlesUploaded: number;
	puzzlesSolved: number;
	totalCompletions: number;
}

export interface PlayerProfile {
	id: string;
	email: string;
	name: string;
	picture: string | null;
	createdAt: number;
	lastLoginAt: number;
	summary: PlayerProfileSummary;
}

export interface PlayerProfileUpdate {
	displayName: string | null;
}

export interface PlayerPuzzleSummary {
	id: string;
	name: string;
	pieceCount: number;
	category?: string;
	status: string;
	createdAt: number;
}

export interface PlayerStatRow {
	puzzleId: string;
	bestTimeSeconds: number;
	totalCompletions: number;
	firstCompletedAt: number;
	lastCompletedAt: number;
}

export interface PuzzleListResponse {
	puzzles: PuzzleSummary[];
	total: number;
	offset: number;
	limit: number;
	nextCursor?: string;
}

export interface ErrorResponse {
	error: string;
	message: string;
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

// Validation functions

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function isPlayerUser(value: unknown): value is PlayerUser {
	if (typeof value !== 'object' || value === null) return false;
	const user = value as Record<string, unknown>;
	if (!isNonEmptyString(user.id)) return false;
	if (!isNonEmptyString(user.email) || !SIMPLE_EMAIL_PATTERN.test(user.email)) return false;
	if (!isFiniteNumber(user.createdAt)) return false;
	if (!isFiniteNumber(user.lastLoginAt)) return false;
	if (user.name !== undefined && !isNonEmptyString(user.name)) return false;
	if (user.picture !== undefined && !isNonEmptyString(user.picture)) return false;
	return true;
}

export function isPlayerSessionResponse(value: unknown): value is PlayerSessionResponse {
	if (typeof value !== 'object' || value === null) return false;
	const response = value as Record<string, unknown>;
	if (typeof response.authenticated !== 'boolean') return false;
	if (response.authenticated) return isPlayerUser(response.user);
	return response.user === undefined;
}

export function isPlayerAllowlistEntry(value: unknown): value is PlayerAllowlistEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	if (!isNonEmptyString(entry.email) || !SIMPLE_EMAIL_PATTERN.test(entry.email)) return false;
	if (!isFiniteNumber(entry.createdAt)) return false;
	if (!isNonEmptyString(entry.addedBy)) return false;
	if (entry.player !== undefined && !isPlayerUser(entry.player)) return false;
	return true;
}

export function isPlayerProfile(value: unknown): value is PlayerProfile {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if (!isNonEmptyString(v.id)) return false;
	if (!isNonEmptyString(v.email)) return false;
	if (!isNonEmptyString(v.name)) return false;
	if (v.picture !== null && !isNonEmptyString(v.picture)) return false;
	if (!isFiniteNumber(v.createdAt)) return false;
	if (!isFiniteNumber(v.lastLoginAt)) return false;
	if (typeof v.summary !== 'object' || v.summary === null) return false;
	const s = v.summary as Record<string, unknown>;
	return (
		isFiniteNumber(s.puzzlesUploaded) &&
		isFiniteNumber(s.puzzlesSolved) &&
		isFiniteNumber(s.totalCompletions)
	);
}

export function isPlayerPuzzleSummary(value: unknown): value is PlayerPuzzleSummary {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isNonEmptyString(v.id) &&
		isNonEmptyString(v.name) &&
		isFiniteNumber(v.pieceCount) &&
		isFiniteNumber(v.createdAt) &&
		isNonEmptyString(v.status) &&
		(v.category === undefined || isNonEmptyString(v.category))
	);
}

export function isPlayerStatRow(value: unknown): value is PlayerStatRow {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isNonEmptyString(v.puzzleId) &&
		isFiniteNumber(v.bestTimeSeconds) &&
		isFiniteNumber(v.totalCompletions) &&
		isFiniteNumber(v.firstCompletedAt) &&
		isFiniteNumber(v.lastCompletedAt)
	);
}

export function isPuzzlePiece(piece: unknown): piece is PuzzlePiece {
	if (typeof piece !== 'object' || piece === null) return false;
	const p = piece as Record<string, unknown>;
	if (typeof p.id !== 'number' || !Number.isFinite(p.id)) return false;
	if (typeof p.puzzleId !== 'string') return false;
	if (typeof p.correctX !== 'number' || !Number.isFinite(p.correctX)) return false;
	if (typeof p.correctY !== 'number' || !Number.isFinite(p.correctY)) return false;
	if (typeof p.imagePath !== 'string') return false;
	return validateEdgeConfig(p.edges);
}

export function validateEdgeConfig(edges: unknown): edges is EdgeConfig {
	if (typeof edges !== 'object' || edges === null) return false;
	const e = edges as Record<string, unknown>;
	const validTypes: EdgeType[] = ['flat', 'tab', 'blank'];
	return ['top', 'right', 'bottom', 'left'].every((dir) => {
		const val = e[dir];
		return typeof val === 'string' && validTypes.includes(val as EdgeType);
	});
}

function isValidOptionalCategory(category: unknown): category is PuzzleCategory | undefined {
	if (category === undefined) return true;
	if (typeof category !== 'string') return false;
	return PUZZLE_CATEGORIES.includes(category as PuzzleCategory);
}

function isValidOptionalAspectRatio(
	aspectRatio: unknown
): aspectRatio is PuzzleAspectRatio | undefined {
	if (aspectRatio === undefined) return true;
	return isPuzzleAspectRatio(aspectRatio);
}

// Puzzle IDs are UUIDv4 (crypto.randomUUID()). Centralized so route handlers
// across both runtimes validate the :id path param consistently, and so
// validateWorkflowParams doesn't keep its own copy of the regex.
const PUZZLE_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPuzzleId(value: unknown): value is string {
	return typeof value === 'string' && PUZZLE_ID_REGEX.test(value);
}

export function validateWorkflowParams(params: unknown): params is WorkflowParams {
	if (typeof params !== 'object' || params === null) return false;
	const p = params as Record<string, unknown>;
	return isPuzzleId(p.puzzleId);
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
	if (!Array.isArray(m.pieces) || !m.pieces.every(isPuzzlePiece)) return false;
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

	// Validate optional category field
	const categoryValue = (m as Record<string, unknown>).category;
	if (!isValidOptionalCategory(categoryValue)) return false;

	const aspectRatioValue = (m as Record<string, unknown>).aspectRatio;
	if (!isValidOptionalAspectRatio(aspectRatioValue)) return false;

	// Cross-validate aspectRatio consistency with pieceCount and grid dimensions
	if (aspectRatioValue) {
		if (!isValidPieceCountForAspectRatio(m.pieceCount, aspectRatioValue)) return false;
		const expected = getGridDimensionsForAspectRatio(m.pieceCount, aspectRatioValue);
		if (expected.rows !== m.gridRows || expected.cols !== m.gridCols) return false;
	}

	return true;
}

/**
 * Lightweight validation for listing operations.
 * Skips expensive piece-by-piece validation to improve performance on list operations.
 * Only validates core metadata fields and structure.
 */
export function validatePuzzleMetadataLight(meta: unknown): meta is PuzzleMetadata {
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

	// Check required fields exist (lightweight - no piece validation)
	if (typeof m.id !== 'string' || typeof m.name !== 'string') return false;
	if (!isNumber(m.pieceCount) || !isNumber(m.gridCols) || !isNumber(m.gridRows)) return false;
	if (!isNumber(m.imageWidth) || !isNumber(m.imageHeight)) return false;
	if (!isNumber(m.createdAt) || !isNumber(m.version)) return false;
	if (!Array.isArray(m.pieces)) return false; // Only check that pieces is an array
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
		// Light validation: just check pieces count matches, not each piece's structure
		if (m.pieces.length !== m.pieceCount) return false;
		const errorValue = (m as Record<string, unknown>).error;
		if (typeof errorValue !== 'undefined' && errorValue !== null) return false;
		const progressValue = (m as Record<string, unknown>).progress;
		if (typeof progressValue !== 'undefined' && progressValue !== null) return false;
	}

	// Validate optional category field
	const categoryValue = (m as Record<string, unknown>).category;
	if (!isValidOptionalCategory(categoryValue)) return false;

	const aspectRatioValue = (m as Record<string, unknown>).aspectRatio;
	if (!isValidOptionalAspectRatio(aspectRatioValue)) return false;

	// Cross-validate aspectRatio consistency with pieceCount and grid dimensions
	if (aspectRatioValue) {
		if (!isValidPieceCountForAspectRatio(m.pieceCount, aspectRatioValue)) return false;
		const expected = getGridDimensionsForAspectRatio(m.pieceCount, aspectRatioValue);
		if (expected.rows !== m.gridRows || expected.cols !== m.gridCols) return false;
	}

	return true;
}

// Jigsaw mask path geometry (used by workflow generation and browser-side quick-puzzle generation)
export { generateJigsawPath, generateJigsawSvgMask } from './jigsaw-path';

export { getGridDimensions, getTopEdge, getRightEdge, getBottomEdge, getLeftEdge } from './grid';
