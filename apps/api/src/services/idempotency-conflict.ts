/**
 * True when a commit failure means a retry reclaimed the reservation (owner or
 * status conflict). Transient DO/HTTP failures are ambiguous and must not
 * trigger orphaned-workflow cleanup.
 */
export function isIdempotencyCommitConflict(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		/owned by another puzzle/i.test(message) ||
		/Cannot committed reservation in status/i.test(message)
	);
}
