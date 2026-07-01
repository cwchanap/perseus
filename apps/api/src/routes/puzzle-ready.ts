// Puzzle readiness check, extracted from puzzles.ts to break a circular
// import between puzzles.ts and puzzles.complete.ts. Pure and stateless —
// safe to import from either module without load-order coupling.
export function isPuzzleReady(puzzle: unknown): boolean {
	if (typeof puzzle !== 'object' || puzzle === null) {
		return false;
	}

	const candidate = puzzle as {
		ready?: boolean;
		status?: string;
		id?: unknown;
		pieces?: unknown;
	};

	if (typeof candidate.ready === 'boolean') {
		return candidate.ready;
	}

	if (typeof candidate.status === 'string') {
		return candidate.status === 'ready';
	}

	// Bun dev server returns the legacy Puzzle shape (no ready/status fields).
	// Only treat it as playable when it actually looks like a Puzzle — a real
	// legacy puzzle carries a string `id` and a `pieces` array. Malformed
	// objects (e.g. {} or { status: 123 }) fall through to "not ready" instead
	// of being optimistically served as ready.
	if (typeof candidate.id === 'string' && Array.isArray(candidate.pieces)) {
		return true;
	}
	return false;
}
