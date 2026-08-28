// Catalog invariants for the five deterministic gameplay fixtures.
//
// These tests pin the exact documented grids and the full set of structural
// invariants (zero-based ids, unique coordinates, flat outer edges,
// complementary neighbors, complete permutations, valid rotations, unique
// UUIDv4 run ids) for every shipped fixture. A catalog change that breaks any
// invariant fails here before reaching a Playwright run.
import { describe, expect, it } from 'bun:test';
import { aspectRatiosMatch } from '@perseus/types';
import {
	DEFAULT_FIXTURE_ID,
	FIXTURES,
	FIXTURE_IDS,
	buildGameplayConfig,
	getFixture,
	type GameplayFixtureId
} from './catalog';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPPOSITE: Record<string, string> = { tab: 'blank', blank: 'tab', flat: 'flat' };

const EXPECTED_GRIDS: Record<GameplayFixtureId, { rows: number; cols: number; pieces: number }> = {
	'e2e-square-4': { rows: 2, cols: 2, pieces: 4 },
	'e2e-landscape-12': { rows: 3, cols: 4, pieces: 12 },
	'e2e-portrait-12': { rows: 4, cols: 3, pieces: 12 },
	'e2e-square-100': { rows: 10, cols: 10, pieces: 100 },
	'e2e-square-225': { rows: 15, cols: 15, pieces: 225 }
};

function expectPermutation(order: readonly number[], n: number): void {
	expect(order.length).toBe(n);
	const seen = new Set<number>();
	for (const id of order) {
		expect(Number.isInteger(id) && id >= 0 && id < n).toBe(true);
		expect(seen.has(id)).toBe(false);
		seen.add(id);
	}
	expect(seen.size).toBe(n);
	// A tray order that equals the sorted identity provides no shuffle coverage.
	if (n > 1) {
		const identity = order.every((id, i) => id === i);
		expect(identity).toBe(false);
	}
}

describe('catalog - fixture registry', () => {
	it('ships exactly the five documented fixture ids', () => {
		expect(FIXTURE_IDS).toEqual([
			'e2e-square-4',
			'e2e-landscape-12',
			'e2e-portrait-12',
			'e2e-square-100',
			'e2e-square-225'
		]);
	});

	it('defaults to the completion fixture', () => {
		expect(DEFAULT_FIXTURE_ID).toBe('e2e-square-4');
	});

	it('registers every id and getFixture round-trips', () => {
		for (const id of FIXTURE_IDS) {
			expect(getFixture(id).fixtureId).toBe(id);
			expect(FIXTURES[id].fixtureId).toBe(id);
		}
	});
});

describe('catalog - exact grids and pieces', () => {
	for (const id of FIXTURE_IDS) {
		it(`${id} has the exact shared grid, zero-based ids, and unique coordinates`, () => {
			const fixture = getFixture(id);
			const expected = EXPECTED_GRIDS[id];
			expect(fixture.rows).toBe(expected.rows);
			expect(fixture.cols).toBe(expected.cols);
			expect(fixture.pieceCount).toBe(expected.pieces);
			expect(fixture.pieces.length).toBe(expected.pieces);

			const ids = fixture.pieces.map((p) => p.id).sort((a, b) => a - b);
			expect(ids).toEqual(Array.from({ length: expected.pieces }, (_, i) => i));

			const cells = new Set<string>();
			for (const piece of fixture.pieces) {
				expect(piece.correctX).toBe(piece.id % fixture.cols);
				expect(piece.correctY).toBe(Math.floor(piece.id / fixture.cols));
				expect(piece.imagePath).toBe(`pieces/${piece.id}.png`);
				expect(piece.puzzleId).toBe(id);
				const key = `${piece.correctX},${piece.correctY}`;
				expect(cells.has(key)).toBe(false);
				cells.add(key);
			}
		});

		it(`${id} has flat outer edges and complementary neighbors`, () => {
			const fixture = getFixture(id);
			const byCell = new Map(fixture.pieces.map((p) => [`${p.correctX},${p.correctY}`, p]));
			for (const piece of fixture.pieces) {
				if (piece.correctY === 0) expect(piece.edges.top).toBe('flat');
				if (piece.correctY === fixture.rows - 1) expect(piece.edges.bottom).toBe('flat');
				if (piece.correctX === 0) expect(piece.edges.left).toBe('flat');
				if (piece.correctX === fixture.cols - 1) expect(piece.edges.right).toBe('flat');
				if (piece.correctX < fixture.cols - 1) {
					const n = byCell.get(`${piece.correctX + 1},${piece.correctY}`);
					expect(piece.edges.right).toBe(OPPOSITE[n!.edges.left]!);
				}
				if (piece.correctY < fixture.rows - 1) {
					const n = byCell.get(`${piece.correctX},${piece.correctY + 1}`);
					expect(piece.edges.bottom).toBe(OPPOSITE[n!.edges.top]!);
				}
			}
		});

		it(`${id} image dimensions match the declared aspect ratio and grid`, () => {
			const fixture = getFixture(id);
			expect(fixture.imageWidth).toBe(fixture.cols * 100);
			expect(fixture.imageHeight).toBe(fixture.rows * 100);
			expect(aspectRatiosMatch(fixture.imageWidth, fixture.imageHeight, fixture.aspectRatio)).toBe(
				true
			);
		});
	}
});

describe('catalog - tray permutations and rotations', () => {
	for (const id of FIXTURE_IDS) {
		it(`${id} has complete, shuffled tray permutations and valid rotations`, () => {
			const fixture = getFixture(id);
			expectPermutation(fixture.initialTrayOrder, fixture.pieceCount);
			expect(fixture.restartTrayOrders.length).toBeGreaterThanOrEqual(1);
			for (const order of fixture.restartTrayOrders) {
				expectPermutation(order, fixture.pieceCount);
			}

			expect(Object.keys(fixture.rotations).length).toBe(fixture.pieceCount);
			for (const piece of fixture.pieces) {
				expect(fixture.rotations[piece.id]).toBeOneOf([0, 90, 180, 270]);
			}
		});

		it(`${id} run ids are unique UUIDv4 values`, () => {
			const fixture = getFixture(id);
			expect(fixture.runIds.length).toBeGreaterThanOrEqual(2);
			for (const runId of fixture.runIds) expect(UUID_V4.test(runId)).toBe(true);
			expect(new Set(fixture.runIds).size).toBe(fixture.runIds.length);
		});

		it(`${id} seedRunId is a valid UUIDv4 not in runIds`, () => {
			const fixture = getFixture(id);
			expect(UUID_V4.test(fixture.seedRunId)).toBe(true);
			expect(fixture.runIds).not.toContain(fixture.seedRunId);
		});
	}
});

describe('catalog - square-4 completion fixture specifics', () => {
	it('carries the documented rotation map and initial tray order', () => {
		const fixture = getFixture('e2e-square-4');
		expect(fixture.initialTrayOrder).toEqual([3, 1, 0, 2]);
		expect(fixture.rotations).toEqual({ 0: 0, 1: 90, 2: 180, 3: 270 });
	});
});

describe('catalog - runtime config projection', () => {
	it('buildGameplayConfig projects a reader-compatible shape for every fixture', () => {
		for (const id of FIXTURE_IDS) {
			const fixture = getFixture(id);
			const config = buildGameplayConfig(fixture);
			expect(config.version).toBe(1);
			expect(config.fixtureId).toBe(id);
			expect(config.runIds).toBe(fixture.runIds);
			expect(config.initialTrayOrder).toBe(fixture.initialTrayOrder);
			expect(config.restartTrayOrders).toBe(fixture.restartTrayOrders);
			expect(config.rotations).toBe(fixture.rotations);
		}
	});
});

describe('catalog - run ids are globally unique across fixtures', () => {
	it('has no cross-fixture run-id collisions (including seedRunIds)', () => {
		const all = new Set<string>();
		for (const id of FIXTURE_IDS) {
			for (const runId of getFixture(id).runIds) {
				expect(all.has(runId)).toBe(false);
				all.add(runId);
			}
			const seed = getFixture(id).seedRunId;
			expect(all.has(seed)).toBe(false);
			all.add(seed);
		}
	});
});
