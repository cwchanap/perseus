import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GameplayRuntimeDependencies } from './runtime.types';

// Hoisted override state. `null` drives the production path (the virtual
// module reader yields null); a non-null value is returned verbatim, exercising
// the E2E harness override path without touching the production shuffle/run-id.
const overrideState = vi.hoisted(() => ({
	value: null as GameplayRuntimeDependencies | null
}));

// Deterministic shuffle (reverse) so tray-order assertions are stable. Typed
// for the number[] piece-id usage; the production shuffleArray is generic.
const shuffleMock = vi.hoisted(() => vi.fn((values: number[]) => [...values].reverse()));

const rotationsMock = vi.hoisted(() =>
	vi.fn((ids: number[]) => Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 90 : 0])))
);

vi.mock('virtual:perseus-gameplay-runtime-override', () => ({
	readGameplayRuntimeOverride: () => overrideState.value
}));

vi.mock('$lib/utils/shuffle', () => ({
	shuffleArray: shuffleMock
}));

// runtime.ts imports generateRandomRotations from @perseus/game-core; mock
// just that export while keeping the rest of the package real (persistence
// in this graph also consumes game-core at runtime).
vi.mock('@perseus/game-core', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@perseus/game-core')>();
	return {
		...actual,
		generateRandomRotations: rotationsMock
	};
});

import { createGameplayRuntimeDependencies } from './runtime';
import type { Rotation } from '@perseus/game-core';

const VALID_ROTATIONS: ReadonlyArray<Rotation> = [0, 90, 180, 270];

describe('createGameplayRuntimeDependencies', () => {
	beforeEach(() => {
		overrideState.value = null;
		shuffleMock.mockReset();
		shuffleMock.mockImplementation((values: number[]) => [...values].reverse());
		rotationsMock.mockReset();
		rotationsMock.mockImplementation((ids: number[]) =>
			Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 90 : 0]))
		);
	});

	describe('production path (no override)', () => {
		it('createInitialTrayOrder returns the shuffled permutation of the piece ids', () => {
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);
			expect(runtime.createInitialTrayOrder([0, 1, 2])).toEqual([2, 1, 0]);
		});

		it('createRestartTrayOrder returns the shuffled permutation of the piece ids', () => {
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);
			expect(runtime.createRestartTrayOrder([0, 1, 2])).toEqual([2, 1, 0]);
		});

		it('tray order factories return fresh arrays that do not alias the input', () => {
			const input = [0, 1, 2];
			const runtime = createGameplayRuntimeDependencies('puzzle-1', input);
			const order = runtime.createInitialTrayOrder(input);
			expect(order).not.toBe(input);
			order.push(99);
			expect(input).toEqual([0, 1, 2]);
		});

		it('createRotations returns a valid rotation for every requested piece id', () => {
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);
			const rotations = runtime.createRotations('puzzle-1', [0, 1, 2]);
			expect(Object.keys(rotations).sort()).toEqual(['0', '1', '2']);
			for (const value of Object.values(rotations)) {
				expect(VALID_ROTATIONS).toContain(value);
			}
		});

		it('bumps the first piece when generated rotations are all upright', () => {
			rotationsMock.mockReturnValueOnce({ 0: 0, 1: 0, 2: 0 });
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);

			expect(runtime.createRotations('puzzle-1', [0, 1, 2])).toEqual({
				0: 90,
				1: 0,
				2: 0
			});
		});

		it('requests fresh rotations on every production call', () => {
			rotationsMock.mockReturnValueOnce({ 0: 90, 1: 0 });
			rotationsMock.mockReturnValueOnce({ 0: 180, 1: 270 });
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1]);

			const first = runtime.createRotations('puzzle-1', [0, 1]);
			const second = runtime.createRotations('puzzle-1', [0, 1]);

			expect(rotationsMock).toHaveBeenCalledTimes(2);
			expect(first).not.toEqual(second);
			// Each generator invocation receives only the piece-id array, preserving
			// the unseeded production contract (no run id or puzzle id leaks in).
			expect(rotationsMock).toHaveBeenNthCalledWith(1, [0, 1]);
			expect(rotationsMock).toHaveBeenNthCalledWith(2, [0, 1]);
		});

		it('runIdFactory produces non-empty string run ids', () => {
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);
			const id = runtime.runIdFactory.create();
			expect(typeof id).toBe('string');
			expect(id.length).toBeGreaterThan(0);
		});

		it('throws when the production shuffle returns a shorter permutation', () => {
			shuffleMock.mockImplementationOnce(() => [0, 1]);
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);
			expect(() => runtime.createInitialTrayOrder([0, 1, 2])).toThrow();
		});

		it('throws when the production shuffle returns a duplicate or unknown id', () => {
			shuffleMock.mockImplementationOnce(() => [0, 0, 2]);
			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);
			expect(() => runtime.createInitialTrayOrder([0, 1, 2])).toThrow();
		});
	});

	describe('override path', () => {
		it('returns the override verbatim and does not invoke the production shuffle', () => {
			const fixed: GameplayRuntimeDependencies = {
				runIdFactory: { create: () => 'fixed-run-id' },
				createInitialTrayOrder: (ids) => [...ids],
				createRestartTrayOrder: (ids) => [...ids],
				createRotations: () => ({})
			};
			overrideState.value = fixed;

			const runtime = createGameplayRuntimeDependencies('puzzle-1', [0, 1, 2]);
			expect(runtime).toBe(fixed);
			expect(shuffleMock).not.toHaveBeenCalled();
		});
	});
});
