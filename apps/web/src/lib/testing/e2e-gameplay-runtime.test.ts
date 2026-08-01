// Unit tests for the strict E2E gameplay runtime reader.
//
// The reader consumes the frozen `window.__PERSEUS_E2E_GAMEPLAY_V1__` global
// set by the E2E init script and surfaces deterministic gameplay dependencies.
// Browser-mode vitest gives us a real `window` to plant the global onto.
import { afterEach, describe, expect, it } from 'vitest';
import { readGameplayRuntimeOverride } from './e2e-gameplay-runtime';

const CONFIG_KEY = '__PERSEUS_E2E_GAMEPLAY_V1__';
const PIECE_IDS = [10, 20, 30];

function windowRecord(): Record<string, unknown> {
	return window as unknown as Record<string, unknown>;
}

function setConfig(config: unknown): void {
	windowRecord()[CONFIG_KEY] = config;
}

function clearConfig(): void {
	delete windowRecord()[CONFIG_KEY];
}

function ctx(puzzleId = 'e2e-abc') {
	return { puzzleId, pieceIds: PIECE_IDS };
}

// A structurally valid config object (returned as a broad record so malformed
// variants can override typed fields without TypeScript friction).
function validConfig(): Record<string, unknown> {
	return {
		version: 1,
		fixtureId: 'e2e-abc',
		runIds: ['run-1', 'run-2'],
		initialTrayOrder: [30, 10, 20],
		restartTrayOrders: [
			[20, 30, 10],
			[10, 30, 20]
		],
		rotations: { 10: 90, 20: 180, 30: 0 }
	};
}

describe('readGameplayRuntimeOverride', () => {
	afterEach(() => {
		clearConfig();
	});

	describe('absent config', () => {
		it('returns null for an ordinary puzzle id', () => {
			expect(readGameplayRuntimeOverride({ puzzleId: 'abc123', pieceIds: PIECE_IDS })).toBeNull();
		});

		it('returns null for a q-* puzzle id', () => {
			expect(readGameplayRuntimeOverride({ puzzleId: 'q-xyz', pieceIds: PIECE_IDS })).toBeNull();
		});

		it('throws with PERSEUS_E2E_CONFIG: for an unconfigured e2e-* puzzle id', () => {
			expect(() => readGameplayRuntimeOverride(ctx('e2e-abc'))).toThrow(/PERSEUS_E2E_CONFIG:/);
		});
	});

	describe('malformed config', () => {
		it('rejects a wrong version', () => {
			setConfig({ ...validConfig(), version: 2 });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a missing fixtureId', () => {
			const cfg = validConfig();
			delete cfg.fixtureId;
			setConfig(cfg);
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a non-array runIds', () => {
			setConfig({ ...validConfig(), runIds: 'not-an-array' });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a non-array initialTrayOrder', () => {
			setConfig({ ...validConfig(), initialTrayOrder: 'nope' });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects an invalid rotation value', () => {
			setConfig({ ...validConfig(), rotations: { 10: 45, 20: 180, 30: 0 } });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a non-object rotations value', () => {
			setConfig({ ...validConfig(), rotations: [90, 180, 0] });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a non-integer rotation key', () => {
			setConfig({ ...validConfig(), rotations: { abc: 90, 20: 180, 30: 0 } });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a non-array element in restartTrayOrders', () => {
			setConfig({ ...validConfig(), restartTrayOrders: ['nope'] });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a non-array restartTrayOrders value', () => {
			setConfig({ ...validConfig(), restartTrayOrders: 'nope' });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a non-object config', () => {
			setConfig('totally-not-a-config');
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});
	});

	describe('fixture mismatch', () => {
		it('rejects when fixtureId does not match the puzzleId', () => {
			setConfig({ ...validConfig(), fixtureId: 'e2e-different' });
			expect(() => readGameplayRuntimeOverride(ctx('e2e-abc'))).toThrow(/PERSEUS_E2E_CONFIG:/);
		});
	});

	describe('frozen-object requirement', () => {
		it('freezes the config global (and nested arrays) on read', () => {
			setConfig(validConfig());
			readGameplayRuntimeOverride(ctx());
			const frozen = windowRecord()[CONFIG_KEY] as { runIds: unknown };
			expect(Object.isFrozen(frozen)).toBe(true);
			expect(Object.isFrozen(frozen.runIds)).toBe(true);
		});
	});

	describe('valid run ids', () => {
		it('advances the cursor through the runIds array in order', () => {
			setConfig({ ...validConfig(), runIds: ['run-a', 'run-b', 'run-c'] });
			const deps = readGameplayRuntimeOverride(ctx())!;
			expect(deps.runIdFactory.create()).toBe('run-a');
			expect(deps.runIdFactory.create()).toBe('run-b');
			expect(deps.runIdFactory.create()).toBe('run-c');
		});
	});

	describe('tray permutations', () => {
		it('returns the configured initial and restart permutations in order', () => {
			setConfig({
				...validConfig(),
				initialTrayOrder: [20, 30, 10],
				restartTrayOrders: [
					[30, 20, 10],
					[10, 20, 30]
				]
			});
			const deps = readGameplayRuntimeOverride(ctx())!;
			expect(deps.createInitialTrayOrder(PIECE_IDS)).toEqual([20, 30, 10]);
			expect(deps.createRestartTrayOrder(PIECE_IDS)).toEqual([30, 20, 10]);
			expect(deps.createRestartTrayOrder(PIECE_IDS)).toEqual([10, 20, 30]);
		});

		it('rejects an initialTrayOrder that is not a permutation of piece ids', () => {
			setConfig({ ...validConfig(), initialTrayOrder: [10, 20, 99] });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects a restartTrayOrder that is not a permutation of piece ids', () => {
			setConfig({
				...validConfig(),
				restartTrayOrders: [
					[10, 20],
					[10, 20, 30]
				]
			});
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});
	});

	describe('rotation keys', () => {
		it('returns rotations keyed exactly by the piece ids', () => {
			setConfig({ ...validConfig(), rotations: { 10: 90, 20: 270, 30: 180 } });
			const deps = readGameplayRuntimeOverride(ctx())!;
			const rotations = deps.createRotations('e2e-abc', PIECE_IDS);
			expect(
				Object.keys(rotations)
					.map(Number)
					.sort((a, b) => a - b)
			).toEqual([10, 20, 30]);
			expect(rotations[10]).toBe(90);
			expect(rotations[20]).toBe(270);
			expect(rotations[30]).toBe(180);
		});

		it('rejects when rotation keys do not exactly match piece ids', () => {
			setConfig({ ...validConfig(), rotations: { 10: 90, 20: 180 } });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects extra rotation keys beyond the piece ids', () => {
			setConfig({ ...validConfig(), rotations: { 10: 90, 20: 180, 30: 0, 40: 90 } });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('rejects equal count but mismatched rotation keys', () => {
			setConfig({ ...validConfig(), rotations: { 10: 90, 20: 180, 40: 0 } });
			expect(() => readGameplayRuntimeOverride(ctx())).toThrow(/PERSEUS_E2E_CONFIG:/);
		});
	});

	describe('sequence exhaustion', () => {
		it('throws when runIdFactory.create() exceeds runIds length', () => {
			setConfig({ ...validConfig(), runIds: ['only-run'] });
			const deps = readGameplayRuntimeOverride(ctx())!;
			expect(deps.runIdFactory.create()).toBe('only-run');
			expect(() => deps.runIdFactory.create()).toThrow(/PERSEUS_E2E_CONFIG:/);
		});

		it('throws when createRestartTrayOrder exceeds restart orders length', () => {
			setConfig({ ...validConfig(), restartTrayOrders: [[30, 20, 10]] });
			const deps = readGameplayRuntimeOverride(ctx())!;
			expect(deps.createRestartTrayOrder(PIECE_IDS)).toEqual([30, 20, 10]);
			expect(() => deps.createRestartTrayOrder(PIECE_IDS)).toThrow(/PERSEUS_E2E_CONFIG:/);
		});
	});

	describe('clone isolation', () => {
		it('mutating a returned tray order does not affect subsequent reads', () => {
			setConfig({ ...validConfig(), initialTrayOrder: [30, 20, 10] });
			const deps = readGameplayRuntimeOverride(ctx())!;
			const first = deps.createInitialTrayOrder(PIECE_IDS);
			first[0] = 9999;
			const second = deps.createInitialTrayOrder(PIECE_IDS);
			expect(second).toEqual([30, 20, 10]);
		});

		it('mutating returned rotations does not affect subsequent reads', () => {
			setConfig({ ...validConfig(), rotations: { 10: 90, 20: 180, 30: 0 } });
			const deps = readGameplayRuntimeOverride(ctx())!;
			const first = deps.createRotations('e2e-abc', PIECE_IDS);
			first[10] = 270;
			const second = deps.createRotations('e2e-abc', PIECE_IDS);
			expect(second[10]).toBe(90);
		});
	});
});
