/**
 * Determines whether a puzzle is ready for play. Handles both runtime shapes:
 * - Worker (production): `PuzzleMetadata` with a `status` field ('ready' | 'processing' | 'failed')
 * - Bun (dev): legacy `Puzzle` shape with no `ready`/`status` fields — puzzles on disk
 *   are inherently ready since there's no async workflow.
 */
export function isPuzzleReady(puzzle: unknown): boolean {
	if (typeof puzzle !== 'object' || puzzle === null) {
		return false;
	}

	const candidate = puzzle as { ready?: boolean; status?: string };

	if (typeof candidate.ready === 'boolean') {
		return candidate.ready;
	}

	if (typeof candidate.status === 'string') {
		return candidate.status === 'ready';
	}

	// Bun dev server returns legacy Puzzle shape (no ready/status fields).
	// If a puzzle exists on the filesystem, it's inherently ready — there's no async workflow.
	return true;
}
