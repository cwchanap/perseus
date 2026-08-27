import {
	getDifficultyPieceCount,
	isPuzzleAspectRatio,
	PUZZLE_DIFFICULTIES,
	type PuzzleAspectRatio,
	type PuzzleDifficulty
} from './grid';
import { isPuzzleId, PUZZLE_CATEGORIES, type PuzzleCategory, type PuzzleStatus } from './core';

export interface PuzzleVariantSummary {
	id: string;
	difficulty: PuzzleDifficulty;
	pieceCount: number;
	status: PuzzleStatus;
}

export interface PuzzleFamilyMetadata {
	id: string;
	name: string;
	category?: PuzzleCategory;
	aspectRatio: PuzzleAspectRatio;
	createdAt: number;
	status: PuzzleStatus;
	variants: Record<PuzzleDifficulty, string>;
	imageWidth?: number;
	imageHeight?: number;
}

export interface PuzzleFamilySummary {
	id: string;
	name: string;
	category?: PuzzleCategory;
	aspectRatio: PuzzleAspectRatio;
	status: PuzzleStatus;
	createdAt: number;
	variants: Record<PuzzleDifficulty, PuzzleVariantSummary>;
}

export interface PuzzleFamilyListResponse {
	families: PuzzleFamilySummary[];
	total: number;
	offset: number;
	limit: number;
	nextCursor?: string;
}

const VALID_PUZZLE_STATUSES: readonly PuzzleStatus[] = ['processing', 'ready', 'failed'];

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isValidPuzzleStatus(value: unknown): value is PuzzleStatus {
	return typeof value === 'string' && VALID_PUZZLE_STATUSES.includes(value as PuzzleStatus);
}

function isValidOptionalCategory(category: unknown): category is PuzzleCategory | undefined {
	if (category === undefined) return true;
	if (typeof category !== 'string') return false;
	return PUZZLE_CATEGORIES.includes(category as PuzzleCategory);
}

function isPuzzleDifficulty(value: unknown): value is PuzzleDifficulty {
	return typeof value === 'string' && (PUZZLE_DIFFICULTIES as readonly string[]).includes(value);
}

function hasExactDifficultyKeys(variants: unknown): variants is Record<PuzzleDifficulty, unknown> {
	if (typeof variants !== 'object' || variants === null) return false;
	const keys = Object.keys(variants);
	if (keys.length !== PUZZLE_DIFFICULTIES.length) return false;
	return PUZZLE_DIFFICULTIES.every((difficulty) => keys.includes(difficulty));
}

export function isPuzzleVariantSummary(
	value: unknown,
	aspectRatio: PuzzleAspectRatio
): value is PuzzleVariantSummary {
	if (typeof value !== 'object' || value === null) return false;
	const variant = value as Record<string, unknown>;
	if (!isPuzzleId(variant.id)) return false;
	if (!isPuzzleDifficulty(variant.difficulty)) return false;
	if (!isFiniteNumber(variant.pieceCount)) return false;
	if (!isValidPuzzleStatus(variant.status)) return false;
	return variant.pieceCount === getDifficultyPieceCount(aspectRatio, variant.difficulty);
}

export function validatePuzzleFamilyMetadata(meta: unknown): meta is PuzzleFamilyMetadata {
	if (typeof meta !== 'object' || meta === null) return false;
	const family = meta as Record<string, unknown>;
	if (!isPuzzleId(family.id)) return false;
	if (!isNonEmptyString(family.name)) return false;
	if (!isPuzzleAspectRatio(family.aspectRatio)) return false;
	if (!isFiniteNumber(family.createdAt)) return false;
	if (!isValidPuzzleStatus(family.status)) return false;
	if (!isValidOptionalCategory(family.category)) return false;
	if (!hasExactDifficultyKeys(family.variants)) return false;
	const variants = family.variants as Record<PuzzleDifficulty, unknown>;
	if (!PUZZLE_DIFFICULTIES.every((difficulty) => isPuzzleId(variants[difficulty]))) return false;
	if (family.imageWidth !== undefined && !isFiniteNumber(family.imageWidth)) return false;
	if (family.imageHeight !== undefined && !isFiniteNumber(family.imageHeight)) return false;
	return true;
}

export function isPuzzleFamilySummary(value: unknown): value is PuzzleFamilySummary {
	if (typeof value !== 'object' || value === null) return false;
	const family = value as Record<string, unknown>;
	if ('pieceCount' in family) return false;
	if (!isPuzzleId(family.id)) return false;
	if (!isNonEmptyString(family.name)) return false;
	if (!isPuzzleAspectRatio(family.aspectRatio)) return false;
	if (!isFiniteNumber(family.createdAt)) return false;
	if (!isValidPuzzleStatus(family.status)) return false;
	if (!isValidOptionalCategory(family.category)) return false;
	if (!hasExactDifficultyKeys(family.variants)) return false;
	const aspectRatio = family.aspectRatio as PuzzleAspectRatio;
	const variants = family.variants as Record<PuzzleDifficulty, unknown>;
	return PUZZLE_DIFFICULTIES.every((difficulty) => {
		const variant = variants[difficulty];
		if (!isPuzzleVariantSummary(variant, aspectRatio)) return false;
		return variant.difficulty === difficulty;
	});
}

export function isPuzzleFamilyListResponse(value: unknown): value is PuzzleFamilyListResponse {
	if (typeof value !== 'object' || value === null) return false;
	const response = value as Record<string, unknown>;
	if (!Array.isArray(response.families) || !response.families.every(isPuzzleFamilySummary)) {
		return false;
	}
	if (!isFiniteNumber(response.total)) return false;
	if (!isFiniteNumber(response.offset)) return false;
	if (!isFiniteNumber(response.limit)) return false;
	if (response.nextCursor !== undefined && !isNonEmptyString(response.nextCursor)) return false;
	return true;
}
