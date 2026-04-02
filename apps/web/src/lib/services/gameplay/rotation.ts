// Rotation helper

export type Rotation = 0 | 90 | 180 | 270;

/**
 * Normalizes any angle to a valid rotation (0 | 90 | 180 | 270).
 * Snaps arbitrary angles to the nearest 90-degree increment.
 * Values at exact midpoints (45, 135, 225, 315) round down.
 */
export function normalizeRotation(angle: number): Rotation {
	const normalized = ((angle % 360) + 360) % 360;
	if (normalized <= 45) return 0;
	if (normalized <= 135) return 90;
	if (normalized <= 225) return 180;
	if (normalized <= 315) return 270;
	return 0;
}

/**
 * Rotates a piece 90 degrees clockwise.
 */
export function rotateClockwise(current: Rotation): Rotation {
	return ((current + 90) % 360) as Rotation;
}

/**
 * Rotates a piece 90 degrees counter-clockwise.
 */
export function rotateCounterClockwise(current: Rotation): Rotation {
	return ((current - 90 + 360) % 360) as Rotation;
}

/**
 * Checks if a piece is in upright orientation (0 degrees).
 * Placement gate requires upright orientation.
 */
export function isUpright(rotation: Rotation): boolean {
	return rotation === 0;
}

/**
 * Simple seeded pseudo-random number generator.
 * Uses a linear congruential generator (LCG).
 */
function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

/**
 * Generates random rotations for a set of pieces.
 * Useful for testing or initializing a scrambled puzzle.
 *
 * @param pieceIds - Array of piece IDs to generate rotations for
 * @param seed - Optional seed for deterministic output (useful for testing)
 * @returns Record mapping piece IDs to random rotations
 */
export function generateRandomRotations(
	pieceIds: number[],
	seed?: number
): Record<number, Rotation> {
	const validRotations: Rotation[] = [0, 90, 180, 270];
	const result: Record<number, Rotation> = {};

	const random = seed !== undefined ? seededRandom(seed) : Math.random;

	for (const pieceId of pieceIds) {
		const randomIndex = Math.floor(random() * validRotations.length);
		result[pieceId] = validRotations[randomIndex];
	}

	return result;
}
