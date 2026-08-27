// Pure typed builder for deterministic gameplay fixtures.
//
// Rows and columns are DERIVED from the shared production grid contract
// (`getGridDimensionsForAspectRatio`) — never accepted as an unchecked
// orientation. Validating only `rows * cols` would admit transposed 4:3 / 3:4
// grids, so the builder requires exact equality with the shared helper and, when
// a definition records expected dimensions for readability, exact equality with
// those too.
//
// Edge geometry reuses the shared edge helpers so complementary neighbors are
// correct by construction; the builder still validates flat outer edges and
// complementary neighbors as defense-in-depth. A definition that violates any
// invariant throws during test import so a broken catalog can never ship.
//
// The returned fixture is deeply frozen. Consumers that need a mutable copy
// (e.g. a Playwright route handler about to serialize it) must clone at their
// boundary.
import type { EdgeType, PuzzleAspectRatio, PuzzleDifficulty, PuzzlePiece } from '@perseus/types';
import {
	aspectRatiosMatch,
	getBottomEdge,
	getGridDimensionsForAspectRatio,
	getLeftEdge,
	getRightEdge,
	getTopEdge,
	isPuzzleAspectRatio,
	PUZZLE_DIFFICULTIES
} from '@perseus/types';
import { EXPANSION_FACTOR } from '../../src/lib/constants/puzzle';
import type { Rotation } from '@perseus/game-core';

export const VALID_ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

/**
 * Visible content edge length for a single synthetic piece, in SVG user units.
 * The padded piece image is `EXPANSION_FACTOR` times this (140px at the current
 * 0.2 tab ratio), leaving 20% transparent padding on every side.
 */
export const FIXTURE_BASE_PIECE_SIZE = 100;

/** Padded piece image edge length (content + tab overflow on both sides). */
export const PADDED_PIECE_SIZE = Math.round(FIXTURE_BASE_PIECE_SIZE * EXPANSION_FACTOR);

const VALID_ROTATION_SET: ReadonlySet<number> = new Set(VALID_ROTATIONS);
// Canonical UUIDv4: 8-4-4-4-12 hex with version (4) and variant (8/9/a/b) nibbles.
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GameplayFixtureDefinition {
	fixtureId: string;
	familyId: string;
	difficulty: PuzzleDifficulty;
	name: string;
	aspectRatio: PuzzleAspectRatio;
	pieceCount: number;
	imageWidth: number;
	imageHeight: number;
	createdAt: number;
	hasReference: boolean;
	/** Optional documented dimensions; when present must exactly match the derived grid. */
	expectedRows?: number;
	expectedCols?: number;
	runIds: readonly string[];
	/**
	 * Run ID for restored sessions (buildMinimalSeed). Must be a valid UUIDv4
	 * and must NOT appear in `runIds`, so a Play Again on a restored session
	 * never collides with the first factory allocation.
	 */
	seedRunId: string;
	initialTrayOrder: readonly number[];
	restartTrayOrders: readonly (readonly number[])[];
	rotations: Readonly<Record<number, Rotation>>;
}

export interface GameplayFixture {
	readonly fixtureId: string;
	readonly familyId: string;
	readonly difficulty: PuzzleDifficulty;
	readonly name: string;
	readonly aspectRatio: PuzzleAspectRatio;
	readonly pieceCount: number;
	readonly rows: number;
	readonly cols: number;
	readonly imageWidth: number;
	readonly imageHeight: number;
	readonly createdAt: number;
	readonly hasReference: boolean;
	readonly pieces: readonly PuzzlePiece[];
	readonly runIds: readonly string[];
	readonly seedRunId: string;
	readonly initialTrayOrder: readonly number[];
	readonly restartTrayOrders: readonly (readonly number[])[];
	readonly rotations: Readonly<Record<number, Rotation>>;
}

function fail(message: string): never {
	throw new Error(`GameplayFixture: ${message}`);
}

function opposite(edge: EdgeType): EdgeType {
	return edge === 'tab' ? 'blank' : edge === 'blank' ? 'tab' : 'flat';
}

function assertPermutation(order: readonly number[], pieceCount: number, label: string): void {
	if (order.length !== pieceCount) {
		fail(`${label} length ${order.length} does not match piece count ${pieceCount}`);
	}
	const seen = new Set<number>();
	for (const id of order) {
		if (!Number.isInteger(id) || id < 0 || id >= pieceCount) {
			fail(`${label} contains out-of-range piece id ${id}`);
		}
		if (seen.has(id)) {
			fail(`${label} is not a complete permutation: duplicate ${id}`);
		}
		seen.add(id);
	}
}

function validateRunIds(runIds: readonly string[]): void {
	if (runIds.length === 0) {
		fail('runIds must contain at least one id (initial solve consumes one)');
	}
	const seen = new Set<string>();
	for (const id of runIds) {
		if (!UUID_V4_PATTERN.test(id)) {
			fail(`runIds contains a non-UUIDv4 value: "${id}"`);
		}
		if (seen.has(id)) {
			fail(`runIds contains a duplicate: "${id}"`);
		}
		seen.add(id);
	}
}

function validateSeedRunId(seedRunId: string, runIds: readonly string[]): void {
	if (!UUID_V4_PATTERN.test(seedRunId)) {
		fail(`seedRunId is not a valid UUIDv4: "${seedRunId}"`);
	}
	if (runIds.includes(seedRunId)) {
		fail(`seedRunId "${seedRunId}" must not appear in runIds (would collide on Play Again)`);
	}
}

function validateRotations(
	rotations: Readonly<Record<number, Rotation>>,
	pieceCount: number
): void {
	const expected = new Set<number>();
	for (let i = 0; i < pieceCount; i += 1) expected.add(i);
	const actual = new Set<number>();
	for (const [key, value] of Object.entries(rotations)) {
		const id = Number(key);
		if (!Number.isInteger(id) || id < 0 || id >= pieceCount || String(id) !== key) {
			fail(`rotations key "${key}" is not a valid piece id in [0, ${pieceCount})`);
		}
		if (!VALID_ROTATION_SET.has(value)) {
			fail(`rotations[${key}] is ${value}; must be one of ${VALID_ROTATIONS.join(', ')}`);
		}
		actual.add(id);
	}
	if (actual.size !== expected.size) {
		const missing = [...expected].filter((id) => !actual.has(id));
		fail(`rotations covers ${actual.size} pieces; missing ids: ${missing.join(', ')}`);
	}
}

function buildPieces(def: GameplayFixtureDefinition, rows: number, cols: number): PuzzlePiece[] {
	const pieces: PuzzlePiece[] = [];
	for (let row = 0; row < rows; row += 1) {
		for (let col = 0; col < cols; col += 1) {
			const id = row * cols + col;
			pieces.push({
				id,
				puzzleId: def.fixtureId,
				correctX: col,
				correctY: row,
				edges: {
					top: getTopEdge(row, col, rows),
					right: getRightEdge(row, col, cols),
					bottom: getBottomEdge(row, col, rows),
					left: getLeftEdge(row, col, cols)
				},
				imagePath: `pieces/${id}.png`
			});
		}
	}
	return pieces;
}

function assertEdgeInvariants(pieces: PuzzlePiece[], rows: number, cols: number): void {
	const byCell = new Map<string, PuzzlePiece>();
	for (const piece of pieces) byCell.set(`${piece.correctX},${piece.correctY}`, piece);

	for (const piece of pieces) {
		if (piece.correctY === 0 && piece.edges.top !== 'flat') {
			fail(`piece ${piece.id} top edge must be flat on the top row`);
		}
		if (piece.correctY === rows - 1 && piece.edges.bottom !== 'flat') {
			fail(`piece ${piece.id} bottom edge must be flat on the bottom row`);
		}
		if (piece.correctX === 0 && piece.edges.left !== 'flat') {
			fail(`piece ${piece.id} left edge must be flat on the left column`);
		}
		if (piece.correctX === cols - 1 && piece.edges.right !== 'flat') {
			fail(`piece ${piece.id} right edge must be flat on the right column`);
		}
		if (piece.correctX < cols - 1) {
			const neighbor = byCell.get(`${piece.correctX + 1},${piece.correctY}`);
			if (neighbor && piece.edges.right !== opposite(neighbor.edges.left)) {
				fail(`piece ${piece.id}.right is not complementary to piece ${neighbor.id}.left`);
			}
		}
		if (piece.correctY < rows - 1) {
			const neighbor = byCell.get(`${piece.correctX},${piece.correctY + 1}`);
			if (neighbor && piece.edges.bottom !== opposite(neighbor.edges.top)) {
				fail(`piece ${piece.id}.bottom is not complementary to piece ${neighbor.id}.top`);
			}
		}
	}
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		Object.freeze(value);
		if (Array.isArray(value)) {
			for (const item of value) deepFreeze(item);
		} else {
			for (const child of Object.values(value as Record<string, unknown>)) {
				deepFreeze(child);
			}
		}
	}
	return value;
}

export function buildFixture(def: GameplayFixtureDefinition): GameplayFixture {
	if (def.fixtureId.length === 0) fail('fixtureId must be a non-empty string');
	if (!UUID_V4_PATTERN.test(def.familyId)) {
		fail(`familyId is not a valid UUIDv4: "${def.familyId}"`);
	}
	if (!(PUZZLE_DIFFICULTIES as readonly string[]).includes(def.difficulty)) {
		fail(`difficulty "${def.difficulty}" is not a supported difficulty`);
	}
	if (!isPuzzleAspectRatio(def.aspectRatio)) {
		fail(`aspectRatio "${def.aspectRatio}" is not a supported ratio`);
	}
	if (!Number.isInteger(def.pieceCount) || def.pieceCount <= 0) {
		fail('pieceCount must be a positive integer');
	}

	// Derive the grid before validating image dimensions: the count/ratio pair
	// must admit a shared grid, and image pixel checks are meaningless without it.
	const { rows, cols } = getGridDimensionsForAspectRatio(def.pieceCount, def.aspectRatio);
	if (rows <= 0 || cols <= 0 || rows * cols !== def.pieceCount) {
		fail(`pieceCount ${def.pieceCount} with ratio ${def.aspectRatio} has no shared grid`);
	}
	if (def.expectedRows !== undefined && def.expectedRows !== rows) {
		fail(`expectedRows ${def.expectedRows} does not match derived rows ${rows}`);
	}
	if (def.expectedCols !== undefined && def.expectedCols !== cols) {
		fail(`expectedCols ${def.expectedCols} does not match derived cols ${cols}`);
	}

	if (!Number.isInteger(def.imageWidth) || def.imageWidth <= 0) {
		fail('imageWidth must be a positive integer');
	}
	if (!Number.isInteger(def.imageHeight) || def.imageHeight <= 0) {
		fail('imageHeight must be a positive integer');
	}
	if (!aspectRatiosMatch(def.imageWidth, def.imageHeight, def.aspectRatio)) {
		fail(
			`image ${def.imageWidth}x${def.imageHeight} does not match aspect ratio ${def.aspectRatio}`
		);
	}

	validateRunIds(def.runIds);
	validateSeedRunId(def.seedRunId, def.runIds);
	assertPermutation(def.initialTrayOrder, def.pieceCount, 'initialTrayOrder');
	for (let i = 0; i < def.restartTrayOrders.length; i += 1) {
		assertPermutation(def.restartTrayOrders[i], def.pieceCount, `restartTrayOrders[${i}]`);
	}
	validateRotations(def.rotations, def.pieceCount);

	const pieces = buildPieces(def, rows, cols);
	assertEdgeInvariants(pieces, rows, cols);

	// Copy the caller's arrays before the fixture is frozen: deepFreeze is
	// destructive, so freezing the fixture must not freeze the definition's
	// arrays (a caller may reuse them across fixtures or keep building).
	const runIds = [...def.runIds];
	const initialTrayOrder = [...def.initialTrayOrder];
	const restartTrayOrders = def.restartTrayOrders.map((order) => [...order]);
	const rotations = { ...def.rotations };

	const fixture: GameplayFixture = {
		fixtureId: def.fixtureId,
		familyId: def.familyId,
		difficulty: def.difficulty,
		name: def.name,
		aspectRatio: def.aspectRatio,
		pieceCount: def.pieceCount,
		rows,
		cols,
		imageWidth: def.imageWidth,
		imageHeight: def.imageHeight,
		createdAt: def.createdAt,
		hasReference: def.hasReference,
		pieces,
		runIds,
		seedRunId: def.seedRunId,
		initialTrayOrder,
		restartTrayOrders,
		rotations
	};

	return deepFreeze(fixture);
}
