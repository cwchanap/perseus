// Deterministic gameplay fixture catalog.
//
// Five fixtures span the three supported aspect ratios, including a 4-piece
// completion fixture, 100- and 225-piece layout fixtures, and dedicated
// landscape/portrait coverage. Every fixture is built through the validated
// `buildFixture` builder, so a transposed grid, partial permutation, or invalid
// rotation fails at test import time.
//
// Run IDs are fixed UUIDv4-shaped strings (never random). Tray permutations are
// literal for the small completion fixture and produced by a fixed-seed LCG
// shuffle for the larger layouts, so the catalog is byte-stable across runs.
// Rotations are non-zero only on the rotation-enabled completion fixture.
import type { PerseusE2EGameplayConfigV1 } from '../../src/lib/testing/e2e-gameplay-runtime';
import type { Rotation } from '@perseus/game-core';
import type { PuzzleDifficulty } from '@perseus/types';
import { buildFixture, type GameplayFixture } from './builder';

export type GameplayFixtureId =
	| 'e2e-square-4'
	| 'e2e-landscape-12'
	| 'e2e-portrait-12'
	| 'e2e-square-100'
	| 'e2e-square-225';

export const FIXTURE_IDS: readonly GameplayFixtureId[] = [
	'e2e-square-4',
	'e2e-landscape-12',
	'e2e-portrait-12',
	'e2e-square-100',
	'e2e-square-225'
];

export const DEFAULT_FIXTURE_ID: GameplayFixtureId = 'e2e-square-4';

/** Deterministic family id for the square-4 progression fixture (harness + E2E). */
export function familyIdForFixtureIndex(fixtureIndex: number): string {
	const tail = (fixtureIndex + 1).toString(16).padStart(12, '0');
	return `00000000-0000-4000-8000-${tail}`;
}

export const E2E_PROGRESSION_FAMILY_ID = familyIdForFixtureIndex(0);

const FIXTURE_DIFFICULTY: PuzzleDifficulty = 'easy';

/** Run IDs consumed per Play Again (one for the initial solve, plus a margin). */
const RUN_ID_COUNT = 4;

/**
 * Produce `count` deterministic, fixture-unique UUIDv4-shaped run IDs. The
 * version (4) and variant (8) nibbles are fixed; the trailing 12 hex digits
 * encode the fixture index and sequence so ids never collide across fixtures.
 */
function runIdsFor(fixtureIndex: number, count: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < count; i += 1) {
		const seq = (fixtureIndex + 1) * 0x10000 + i;
		const tail = seq.toString(16).padStart(12, '0');
		ids.push(`00000000-0000-4000-8000-${tail}`);
	}
	return ids;
}

/**
 * Deterministic UUIDv4-shaped seed run ID for restored sessions. Uses a
 * distinct tail range (0xfffe offset) so it never collides with any id in
 * `runIdsFor` (which uses 0..count-1). This is the run ID `buildMinimalSeed`
 * plants in a restored session — separate from the allocation pool so Play
 * Again's first `runIdFactory.create()` returns `runIds[0]`, not the seed.
 */
function seedRunIdFor(fixtureIndex: number): string {
	const seq = (fixtureIndex + 1) * 0x10000 + 0xfffe;
	const tail = seq.toString(16).padStart(12, '0');
	return `00000000-0000-4000-8000-${tail}`;
}

/** Deterministic Fisher-Yates shuffle driven by a fixed-seed LCG. */
function seededShuffle(seed: number, length: number): number[] {
	const arr = Array.from({ length }, (_, i) => i);
	let state = seed >>> 0;
	for (let i = length - 1; i > 0; i -= 1) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const j = state % (i + 1);
		const tmp = arr[i]!;
		arr[i] = arr[j]!;
		arr[j] = tmp;
	}
	return arr;
}

function allZeroRotations(n: number): Record<number, Rotation> {
	const r: Record<number, Rotation> = {};
	for (let i = 0; i < n; i += 1) r[i] = 0;
	return r;
}

const square4 = buildFixture({
	fixtureId: 'e2e-square-4',
	familyId: familyIdForFixtureIndex(0),
	difficulty: FIXTURE_DIFFICULTY,
	name: 'E2E Square 4 (completion)',
	aspectRatio: '1:1',
	pieceCount: 4,
	imageWidth: 200,
	imageHeight: 200,
	createdAt: 1710000000000,
	hasReference: true,
	runIds: runIdsFor(0, RUN_ID_COUNT),
	seedRunId: seedRunIdFor(0),
	initialTrayOrder: [3, 1, 0, 2],
	restartTrayOrders: [
		[1, 2, 3, 0],
		[2, 0, 1, 3]
	],
	rotations: { 0: 0, 1: 90, 2: 180, 3: 270 }
});

const landscape12 = buildFixture({
	fixtureId: 'e2e-landscape-12',
	familyId: familyIdForFixtureIndex(1),
	difficulty: FIXTURE_DIFFICULTY,
	name: 'E2E Landscape 12',
	aspectRatio: '4:3',
	pieceCount: 12,
	imageWidth: 400,
	imageHeight: 300,
	createdAt: 1710000001000,
	hasReference: true,
	runIds: runIdsFor(1, RUN_ID_COUNT),
	seedRunId: seedRunIdFor(1),
	initialTrayOrder: seededShuffle(0x1a2b3c, 12),
	restartTrayOrders: [seededShuffle(0x4d5e6f, 12), seededShuffle(0x7a8b9c, 12)],
	rotations: allZeroRotations(12)
});

const portrait12 = buildFixture({
	fixtureId: 'e2e-portrait-12',
	familyId: familyIdForFixtureIndex(2),
	difficulty: FIXTURE_DIFFICULTY,
	name: 'E2E Portrait 12',
	aspectRatio: '3:4',
	pieceCount: 12,
	imageWidth: 300,
	imageHeight: 400,
	createdAt: 1710000002000,
	hasReference: true,
	runIds: runIdsFor(2, RUN_ID_COUNT),
	seedRunId: seedRunIdFor(2),
	initialTrayOrder: seededShuffle(0x112233, 12),
	restartTrayOrders: [seededShuffle(0x445566, 12), seededShuffle(0x778899, 12)],
	rotations: allZeroRotations(12)
});

const square100 = buildFixture({
	fixtureId: 'e2e-square-100',
	familyId: familyIdForFixtureIndex(3),
	difficulty: FIXTURE_DIFFICULTY,
	name: 'E2E Square 100 (layout)',
	aspectRatio: '1:1',
	pieceCount: 100,
	imageWidth: 1000,
	imageHeight: 1000,
	createdAt: 1710000003000,
	hasReference: true,
	runIds: runIdsFor(3, RUN_ID_COUNT),
	seedRunId: seedRunIdFor(3),
	initialTrayOrder: seededShuffle(0xabcdef, 100),
	restartTrayOrders: [seededShuffle(0xfedcba, 100)],
	rotations: allZeroRotations(100)
});

const square225 = buildFixture({
	fixtureId: 'e2e-square-225',
	familyId: familyIdForFixtureIndex(4),
	difficulty: FIXTURE_DIFFICULTY,
	name: 'E2E Square 225 (large layout)',
	aspectRatio: '1:1',
	pieceCount: 225,
	imageWidth: 1500,
	imageHeight: 1500,
	createdAt: 1710000004000,
	hasReference: true,
	runIds: runIdsFor(4, RUN_ID_COUNT),
	seedRunId: seedRunIdFor(4),
	initialTrayOrder: seededShuffle(0x13579b, 225),
	restartTrayOrders: [seededShuffle(0x97531b, 225)],
	rotations: allZeroRotations(225)
});

export const FIXTURES: Readonly<Record<GameplayFixtureId, GameplayFixture>> = Object.freeze({
	'e2e-square-4': square4,
	'e2e-landscape-12': landscape12,
	'e2e-portrait-12': portrait12,
	'e2e-square-100': square100,
	'e2e-square-225': square225
});

export function getFixture(id: GameplayFixtureId): GameplayFixture {
	return FIXTURES[id];
}

/**
 * Project a fixture onto the frozen runtime contract consumed by the E2E
 * gameplay reader (`PerseusE2EGameplayConfigV1`). The reader validates this
 * shape in full before adopting it.
 */
export function buildGameplayConfig(fixture: GameplayFixture): PerseusE2EGameplayConfigV1 {
	return {
		version: 1,
		fixtureId: fixture.fixtureId,
		runIds: fixture.runIds,
		initialTrayOrder: fixture.initialTrayOrder,
		restartTrayOrders: fixture.restartTrayOrders,
		rotations: fixture.rotations
	};
}
