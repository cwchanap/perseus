// Invariant tests for the deterministic gameplay fixture builder.
//
// The builder is a pure typed function: it derives rows/columns from the shared
// production grid contract (never accepting them as unchecked input) and
// validates every structural invariant before returning a frozen fixture. These
// tests pin that contract so a catalog definition cannot silently introduce a
// transposed grid, a partial permutation, or an invalid rotation.
import { describe, expect, it } from 'bun:test';
import { getGridDimensionsForAspectRatio } from '@perseus/types';
import type { PuzzleAspectRatio } from '@perseus/types';
import { buildFixture, VALID_ROTATIONS, type GameplayFixtureDefinition } from './builder';

const OPPOSITE: Record<string, string> = { tab: 'blank', blank: 'tab', flat: 'flat' };

function gridFor(pieceCount: number, ratio: PuzzleAspectRatio) {
	const { rows, cols } = getGridDimensionsForAspectRatio(pieceCount, ratio);
	return { rows, cols };
}

function identityPermutation(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

function zeroRotations(n: number): Record<number, number> {
	const r: Record<number, number> = {};
	for (let i = 0; i < n; i += 1) r[i] = 0;
	return r;
}

function validRunIds(count: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < count; i += 1) {
		const tail = (i + 1).toString(16).padStart(12, '0');
		ids.push(`00000000-0000-4000-8000-${tail}`);
	}
	return ids;
}

function validSeedRunId(): string {
	// Distinct tail (0xfffe) so it never collides with validRunIds (0x1..count).
	return '00000000-0000-4000-8000-00000000fffe';
}

function makeDefinition(
	pieceCount: number,
	aspectRatio: PuzzleAspectRatio,
	overrides: Partial<GameplayFixtureDefinition> = {}
): GameplayFixtureDefinition {
	const { rows, cols } = gridFor(pieceCount, aspectRatio);
	return {
		fixtureId: 'e2e-test',
		name: 'Test fixture',
		aspectRatio,
		pieceCount,
		imageWidth: cols * 100,
		imageHeight: rows * 100,
		createdAt: 1700000000000,
		hasReference: true,
		runIds: validRunIds(4),
		seedRunId: validSeedRunId(),
		initialTrayOrder: identityPermutation(pieceCount),
		restartTrayOrders: [identityPermutation(pieceCount)],
		rotations: zeroRotations(pieceCount),
		...overrides
	};
}

describe('buildFixture - grid derivation', () => {
	it('derives exact grids for every supported ratio/count pair', () => {
		const cases: Array<{
			pieceCount: number;
			ratio: PuzzleAspectRatio;
			rows: number;
			cols: number;
		}> = [
			{ pieceCount: 4, ratio: '1:1', rows: 2, cols: 2 },
			{ pieceCount: 12, ratio: '4:3', rows: 3, cols: 4 },
			{ pieceCount: 12, ratio: '3:4', rows: 4, cols: 3 },
			{ pieceCount: 100, ratio: '1:1', rows: 10, cols: 10 },
			{ pieceCount: 225, ratio: '1:1', rows: 15, cols: 15 }
		];
		for (const c of cases) {
			const fixture = buildFixture(makeDefinition(c.pieceCount, c.ratio));
			expect(fixture.rows).toBe(c.rows);
			expect(fixture.cols).toBe(c.cols);
			expect(fixture.pieceCount).toBe(c.pieceCount);
		}
	});

	it('rejects a piece-count/ratio pair that has no shared grid', () => {
		// 7 is not a perfect square, so the 1:1 contract admits no grid.
		expect(() => buildFixture(makeDefinition(7, '1:1'))).toThrow(/grid/i);
	});

	it('rejects a transposed expected grid (validates rows*cols alone is insufficient)', () => {
		// 4:3 derives 3x4; declaring 4x3 must fail even though 4*3 === 12.
		const def = makeDefinition(12, '4:3', { expectedRows: 4, expectedCols: 3 });
		expect(() => buildFixture(def)).toThrow(/expected/i);
	});

	it('accepts an expected grid that exactly matches the derived grid', () => {
		const def = makeDefinition(12, '4:3', { expectedRows: 3, expectedCols: 4 });
		expect(buildFixture(def).cols).toBe(4);
	});
});

describe('buildFixture - pieces', () => {
	it('produces zero-based ids covering the full range', () => {
		const fixture = buildFixture(makeDefinition(12, '4:3'));
		const ids = fixture.pieces.map((p) => p.id).sort((a, b) => a - b);
		expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});

	it('assigns id = row * cols + col, correctX = col, correctY = row', () => {
		const fixture = buildFixture(makeDefinition(12, '4:3'));
		for (const piece of fixture.pieces) {
			expect(piece.id).toBe(piece.correctY * fixture.cols + piece.correctX);
		}
	});

	it('produces unique in-bounds coordinates', () => {
		const fixture = buildFixture(makeDefinition(12, '3:4'));
		const cells = new Set<string>();
		for (const piece of fixture.pieces) {
			expect(piece.correctX).toBeGreaterThanOrEqual(0);
			expect(piece.correctX).toBeLessThan(fixture.cols);
			expect(piece.correctY).toBeGreaterThanOrEqual(0);
			expect(piece.correctY).toBeLessThan(fixture.rows);
			const key = `${piece.correctX},${piece.correctY}`;
			expect(cells.has(key)).toBe(false);
			cells.add(key);
		}
		expect(cells.size).toBe(fixture.pieceCount);
	});

	it('stamps puzzleId and imagePath on every piece', () => {
		const fixture = buildFixture(makeDefinition(4, '1:1'));
		for (const piece of fixture.pieces) {
			expect(piece.puzzleId).toBe('e2e-test');
			expect(piece.imagePath).toBe(`pieces/${piece.id}.png`);
		}
	});
});

describe('buildFixture - edges', () => {
	it('makes every outer edge flat', () => {
		const fixture = buildFixture(makeDefinition(12, '4:3'));
		for (const piece of fixture.pieces) {
			if (piece.correctY === 0) expect(piece.edges.top).toBe('flat');
			if (piece.correctY === fixture.rows - 1) expect(piece.edges.bottom).toBe('flat');
			if (piece.correctX === 0) expect(piece.edges.left).toBe('flat');
			if (piece.correctX === fixture.cols - 1) expect(piece.edges.right).toBe('flat');
		}
	});

	it('makes horizontal neighbors complementary (right opposes left)', () => {
		const fixture = buildFixture(makeDefinition(225, '1:1'));
		const byCell = new Map(fixture.pieces.map((p) => [`${p.correctX},${p.correctY}`, p]));
		for (const piece of fixture.pieces) {
			if (piece.correctX === fixture.cols - 1) continue;
			const neighbor = byCell.get(`${piece.correctX + 1},${piece.correctY}`);
			expect(neighbor).toBeDefined();
			expect(piece.edges.right).toBe(OPPOSITE[neighbor!.edges.left]!);
		}
	});

	it('makes vertical neighbors complementary (bottom opposes top)', () => {
		const fixture = buildFixture(makeDefinition(100, '1:1'));
		const byCell = new Map(fixture.pieces.map((p) => [`${p.correctX},${p.correctY}`, p]));
		for (const piece of fixture.pieces) {
			if (piece.correctY === fixture.rows - 1) continue;
			const neighbor = byCell.get(`${piece.correctX},${piece.correctY + 1}`);
			expect(neighbor).toBeDefined();
			expect(piece.edges.bottom).toBe(OPPOSITE[neighbor!.edges.top]!);
		}
	});
});

describe('buildFixture - run ids', () => {
	it('rejects an empty run-id sequence', () => {
		expect(() => buildFixture(makeDefinition(4, '1:1', { runIds: [] }))).toThrow(/run/i);
	});

	it('rejects duplicate run ids', () => {
		const id = '00000000-0000-4000-8000-000000000001';
		expect(() => buildFixture(makeDefinition(4, '1:1', { runIds: [id, id] }))).toThrow(/run/i);
	});

	it('rejects malformed run ids', () => {
		expect(() => buildFixture(makeDefinition(4, '1:1', { runIds: ['not-a-uuid'] }))).toThrow(
			/run/i
		);
	});

	it('keeps run ids unique and uuid-shaped', () => {
		const fixture = buildFixture(makeDefinition(4, '1:1'));
		expect(new Set(fixture.runIds).size).toBe(fixture.runIds.length);
	});
});

describe('buildFixture - seed run id', () => {
	it('rejects a malformed seedRunId', () => {
		expect(() => buildFixture(makeDefinition(4, '1:1', { seedRunId: 'not-a-uuid' }))).toThrow(
			/seedRunId/i
		);
	});

	it('rejects a seedRunId that collides with a runId', () => {
		const id = validRunIds(4)[0]!;
		expect(() => buildFixture(makeDefinition(4, '1:1', { seedRunId: id }))).toThrow(/seedRunId/i);
	});

	it('accepts a valid, non-colliding seedRunId and exposes it on the fixture', () => {
		const fixture = buildFixture(makeDefinition(4, '1:1'));
		expect(fixture.seedRunId).toBe(validSeedRunId());
		expect(fixture.runIds).not.toContain(fixture.seedRunId);
	});
});

describe('buildFixture - tray permutations', () => {
	it('rejects an initial tray order that is not a complete permutation', () => {
		expect(() =>
			buildFixture(makeDefinition(4, '1:1', { initialTrayOrder: [0, 1, 2, 2] }))
		).toThrow(/initialTrayOrder/i);
		expect(() => buildFixture(makeDefinition(4, '1:1', { initialTrayOrder: [0, 1, 2] }))).toThrow(
			/initialTrayOrder/i
		);
	});

	it('rejects a restart tray order that is not a complete permutation', () => {
		expect(() =>
			buildFixture(makeDefinition(4, '1:1', { restartTrayOrders: [[0, 1, 3, 3]] }))
		).toThrow(/restartTrayOrders/i);
	});
});

describe('buildFixture - rotations', () => {
	it('rejects a rotation map missing a piece', () => {
		const partial: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
		expect(() => buildFixture(makeDefinition(4, '1:1', { rotations: partial }))).toThrow(
			/rotation/i
		);
	});

	it('rejects a rotation map with an extra piece', () => {
		const extra: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
		expect(() => buildFixture(makeDefinition(4, '1:1', { rotations: extra }))).toThrow(/rotation/i);
	});

	it('rejects an out-of-range rotation value', () => {
		const bad: Record<number, number> = { 0: 0, 1: 45, 2: 0, 3: 0 };
		expect(() => buildFixture(makeDefinition(4, '1:1', { rotations: bad }))).toThrow(/rotation/i);
	});

	it('exposes the canonical rotation set', () => {
		expect(VALID_ROTATIONS).toEqual([0, 90, 180, 270]);
	});
});

describe('buildFixture - image dimensions', () => {
	it('rejects image dimensions that disagree with the declared aspect ratio', () => {
		expect(() =>
			buildFixture(makeDefinition(4, '1:1', { imageWidth: 200, imageHeight: 100 }))
		).toThrow(/aspect/i);
	});
});

describe('buildFixture - immutability', () => {
	it('returns a deeply frozen fixture', () => {
		const fixture = buildFixture(makeDefinition(4, '1:1'));
		expect(Object.isFrozen(fixture)).toBe(true);
		expect(Object.isFrozen(fixture.pieces)).toBe(true);
		expect(Object.isFrozen(fixture.runIds)).toBe(true);
		expect(Object.isFrozen(fixture.initialTrayOrder)).toBe(true);
		expect(Object.isFrozen(fixture.rotations)).toBe(true);
		expect(Object.isFrozen(fixture.restartTrayOrders)).toBe(true);
		expect(Object.isFrozen(fixture.restartTrayOrders[0])).toBe(true);
	});
});
