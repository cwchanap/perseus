import type { RunIdFactory, Rotation } from '@perseus/game-core';

/**
 * Runtime gameplay dependencies that may be overridden by the E2E harness for
 * deterministic gameplay. In normal builds, the virtual module returns null and
 * the production runtime supplies its own factories.
 */
export interface GameplayRuntimeDependencies {
	runIdFactory: RunIdFactory;
	createInitialTrayOrder(pieceIds: readonly number[]): number[];
	createRestartTrayOrder(pieceIds: readonly number[]): number[];
	createRotations(puzzleId: string, pieceIds: readonly number[]): Record<number, Rotation>;
}

/**
 * Context supplied when reading a gameplay runtime override. Identifies the
 * puzzle being played and the canonical piece ids the override must account for.
 */
export interface GameplayRuntimeOverrideContext {
	puzzleId: string;
	pieceIds: readonly number[];
}
