// Strict E2E gameplay runtime reader.
//
// Reads the frozen `window.__PERSEUS_E2E_GAMEPLAY_V1__` global planted by the
// E2E init script and surfaces deterministic gameplay dependencies. The reader
// is only bundled into the harness build (the virtual module re-exports it);
// in normal builds the virtual module returns a no-op and this file is dead-
// code eliminated. ESLint guardrails keep it out of production source.
//
// Contract:
//   - Read the global ONCE per call and validate the complete frozen shape
//     before creating any closures.
//   - Missing global falls back to null for ordinary and `q-*` puzzles; an
//     unconfigured `e2e-*` puzzle is a hard error — but only in the browser.
//     During server rendering (no window) the reader returns null without
//     throwing: the override is only ever consulted after hydration, so an
//     `e2e-*` puzzle rendered server-side simply gets no override.
//   - Once config is present, any defect is a hard error — never fall back.
//   - Every error message is prefixed with `PERSEUS_E2E_CONFIG:`.
//   - Arrays/objects are cloned at return boundaries so callers cannot mutate
//     the frozen config.

import type { Rotation } from '$lib/types/gameplay';
import type {
	GameplayRuntimeDependencies,
	GameplayRuntimeOverrideContext
} from '$lib/services/gameplay/runtime.types';

/**
 * Frozen gameplay configuration planted on the window global by the E2E init
 * script. The reader validates this shape in full before adopting it.
 */
export interface PerseusE2EGameplayConfigV1 {
	version: 1;
	fixtureId: string;
	runIds: readonly string[];
	initialTrayOrder: readonly number[];
	restartTrayOrders: readonly (readonly number[])[];
	rotations: Readonly<Record<number, Rotation>>;
}

const CONFIG_GLOBAL = '__PERSEUS_E2E_GAMEPLAY_V1__';
const ERROR_PREFIX = 'PERSEUS_E2E_CONFIG:';
const VALID_ROTATIONS: readonly number[] = [0, 90, 180, 270];

/**
 * Read the E2E gameplay runtime override for a puzzle.
 *
 * Returns `null` when no config is present and the puzzle is not an `e2e-*`
 * fixture (letting the production runtime supply its own factories). Throws
 * for an unconfigured `e2e-*` puzzle or for any defect in a present config —
 * both only in the browser. During server rendering the reader returns `null`
 * without throwing: the override is only consulted after hydration, so an
 * `e2e-*` puzzle rendered server-side simply gets no override.
 */
export function readGameplayRuntimeOverride(
	context: GameplayRuntimeOverrideContext
): GameplayRuntimeDependencies | null {
	const global = readGlobal();
	if (!global.available) {
		// Server render: there is no window to read and the runtime is never
		// consulted before hydration (the route builds it post-hydration), so
		// an unconfigured e2e-* puzzle must not hard-error here.
		return null;
	}
	const raw = global.value;
	if (raw === undefined || raw === null) {
		if (context.puzzleId.startsWith('e2e-')) {
			throw new Error(
				`${ERROR_PREFIX} missing gameplay config for e2e puzzle "${context.puzzleId}"`
			);
		}
		return null;
	}

	const config = validateConfig(raw, context);
	deepFreeze(config);
	return buildDependencies(config);
}

function readGlobal(): { available: true; value: unknown } | { available: false } {
	if (typeof window === 'undefined') {
		// Server rendering: the global cannot exist without a window.
		return { available: false };
	}
	return { available: true, value: (window as unknown as Record<string, unknown>)[CONFIG_GLOBAL] };
}

function validateConfig(
	raw: unknown,
	context: GameplayRuntimeOverrideContext
): PerseusE2EGameplayConfigV1 {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${ERROR_PREFIX} config must be a plain object`);
	}
	const cfg = raw as Record<string, unknown>;

	if (cfg.version !== 1) {
		throw new Error(`${ERROR_PREFIX} config.version must be 1 (got ${stringify(cfg.version)})`);
	}
	if (typeof cfg.fixtureId !== 'string' || cfg.fixtureId.length === 0) {
		throw new Error(`${ERROR_PREFIX} config.fixtureId must be a non-empty string`);
	}
	if (cfg.fixtureId !== context.puzzleId) {
		throw new Error(
			`${ERROR_PREFIX} fixtureId "${cfg.fixtureId}" does not match puzzleId "${context.puzzleId}"`
		);
	}
	if (!isStringArray(cfg.runIds)) {
		throw new Error(`${ERROR_PREFIX} config.runIds must be an array of strings`);
	}
	if (!isNumberArray(cfg.initialTrayOrder)) {
		throw new Error(`${ERROR_PREFIX} config.initialTrayOrder must be an array of numbers`);
	}
	assertPermutation(cfg.initialTrayOrder, context.pieceIds, 'initialTrayOrder');
	if (!Array.isArray(cfg.restartTrayOrders)) {
		throw new Error(`${ERROR_PREFIX} config.restartTrayOrders must be an array`);
	}
	cfg.restartTrayOrders.forEach((order, index) => {
		if (!isNumberArray(order)) {
			throw new Error(
				`${ERROR_PREFIX} config.restartTrayOrders[${index}] must be an array of numbers`
			);
		}
		assertPermutation(order, context.pieceIds, `restartTrayOrders[${index}]`);
	});
	validateRotations(cfg.rotations, context.pieceIds);

	return cfg as unknown as PerseusE2EGameplayConfigV1;
}

function validateRotations(value: unknown, pieceIds: readonly number[]): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${ERROR_PREFIX} config.rotations must be a plain object`);
	}
	const rotations = value as Record<string, unknown>;
	const expected = new Set(pieceIds);
	const actual = new Set<number>();

	for (const key of Object.keys(rotations)) {
		const numeric = Number(key);
		if (!Number.isInteger(numeric) || numeric < 0 || String(numeric) !== key) {
			throw new Error(
				`${ERROR_PREFIX} config.rotations key "${key}" is not a non-negative integer`
			);
		}
		const rot = rotations[key];
		if (!VALID_ROTATIONS.includes(rot as number)) {
			throw new Error(
				`${ERROR_PREFIX} config.rotations["${key}"] must be 0|90|180|270 (got ${stringify(rot)})`
			);
		}
		actual.add(numeric);
	}

	if (actual.size !== expected.size) {
		throw new Error(
			`${ERROR_PREFIX} config.rotations has ${actual.size} keys but puzzle has ${expected.size} pieces`
		);
	}
	for (const id of expected) {
		if (!actual.has(id)) {
			throw new Error(`${ERROR_PREFIX} config.rotations is missing key for piece ${id}`);
		}
	}
}

function assertPermutation(
	order: readonly number[],
	pieceIds: readonly number[],
	label: string
): void {
	if (order.length !== pieceIds.length) {
		throw new Error(
			`${ERROR_PREFIX} ${label} length ${order.length} does not match piece count ${pieceIds.length}`
		);
	}
	const expected = new Set<number>(pieceIds);
	for (const id of order) {
		if (!expected.delete(id)) {
			throw new Error(
				`${ERROR_PREFIX} ${label} is not a complete permutation: missing or duplicate ${id}`
			);
		}
	}
}

function buildDependencies(config: PerseusE2EGameplayConfigV1): GameplayRuntimeDependencies {
	let runCursor = 0;
	let restartCursor = 0;

	return {
		runIdFactory: {
			create() {
				if (runCursor >= config.runIds.length) {
					throw new Error(`${ERROR_PREFIX} runIds exhausted after ${config.runIds.length} reads`);
				}
				return config.runIds[runCursor++]!;
			}
		},
		createInitialTrayOrder: () => [...config.initialTrayOrder],
		createRestartTrayOrder: () => {
			if (restartCursor >= config.restartTrayOrders.length) {
				throw new Error(
					`${ERROR_PREFIX} restartTrayOrders exhausted after ${config.restartTrayOrders.length} reads`
				);
			}
			return [...config.restartTrayOrders[restartCursor++]!];
		},
		createRotations: () => ({ ...config.rotations })
	};
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNumberArray(value: unknown): value is readonly number[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function stringify(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (value === null) return 'null';
	return String(value);
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
