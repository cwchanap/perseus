// Canonical `e2e-*` fixture-id signature, shared by the E2E fixture router,
// page diagnostics, and the gameplay runtime override so all three classify
// requests identically.
//
// Fixture ids must stay UUIDv4-shaped — loadPuzzleSource's `isPuzzleId` gate
// rejects anything else before a request is ever made — so the namespace
// cannot differ from a real id by shape. Real puzzle ids are random v4, and
// roughly one in 4,096 generated ids begins with `e2e`; matching on the bare
// prefix therefore claims real traffic. The dedicated namespace instead pins
// the zero-padded group signature every catalog fixture shares
// (`e2e2?000-0000-4000-8000-…`), which a random v4 id cannot practically
// reproduce.
export const E2E_PUZZLE_ID_SOURCE = 'e2e2[0-9a-f]000-0000-4000-8000-[0-9a-f]{12}';

/** Full-id matcher for the fixture namespace (case-insensitive). */
export const E2E_PUZZLE_ID_PATTERN = new RegExp(`^${E2E_PUZZLE_ID_SOURCE}$`, 'i');

/** Path matcher for any `/api/puzzles/<fixture-id>…` request. */
export const E2E_PUZZLE_API_PATH = new RegExp(`/api/puzzles/${E2E_PUZZLE_ID_SOURCE}`, 'i');

/** Extracts the fixture id from an `/api/puzzles/<fixture-id>…` path. */
export const E2E_PUZZLE_ID_IN_PATH = new RegExp(`/api/puzzles/(${E2E_PUZZLE_ID_SOURCE})`, 'i');

/** Whether a puzzle id belongs to the E2E fixture namespace. */
export function isE2EPuzzleId(value: string): boolean {
	return E2E_PUZZLE_ID_PATTERN.test(value);
}
