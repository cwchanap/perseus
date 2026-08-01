import { shuffleArray } from '$lib/utils/shuffle';
import { createBrowserRunIdFactory } from '$lib/services/gameplay/session/persistence';
import { generateRandomRotations } from '$lib/services/gameplay/rotation';
import type { Rotation } from '$lib/types/gameplay';
import { readGameplayRuntimeOverride } from 'virtual:perseus-gameplay-runtime-override';
import type { GameplayRuntimeDependencies } from './runtime.types';

/**
 * Build the gameplay runtime dependencies for a puzzle. In normal builds the
 * virtual module reader returns null and the production factories (browser
 * run-id, Fisher–Yates shuffle, puzzle-derived rotation seed) are used. When
 * the E2E harness supplies an override, it is returned verbatim.
 */
export function createGameplayRuntimeDependencies(
	puzzleId: string,
	pieceIds: readonly number[]
): GameplayRuntimeDependencies {
	const override = readGameplayRuntimeOverride({ puzzleId, pieceIds });
	if (override) {
		return override;
	}

	return {
		runIdFactory: createBrowserRunIdFactory(),
		createInitialTrayOrder: (ids) => buildTrayOrder(ids),
		createRestartTrayOrder: (ids) => buildTrayOrder(ids),
		createRotations: (resolvedPuzzleId, ids) => buildRotations(resolvedPuzzleId, ids)
	};
}

function buildTrayOrder(pieceIds: readonly number[]): number[] {
	const order = shuffleArray([...pieceIds]);
	assertCompletePermutation(pieceIds, order);
	return order;
}

function buildRotations(puzzleId: string, pieceIds: readonly number[]): Record<number, Rotation> {
	let hash = 0;
	const seedStr = `${puzzleId}:${pieceIds.join(',')}`;
	for (const ch of seedStr) {
		hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	}
	return { ...generateRandomRotations([...pieceIds], hash || 1) };
}

function assertCompletePermutation(pieceIds: readonly number[], order: readonly number[]): void {
	if (order.length !== pieceIds.length) {
		throw new Error(
			`Expected tray order of length ${pieceIds.length} but received length ${order.length}`
		);
	}
	const expected = new Set<number>(pieceIds);
	for (const id of order) {
		if (!expected.delete(id)) {
			throw new Error(
				`Tray order is not a complete permutation of piece ids: missing or duplicate ${id}`
			);
		}
	}
}
