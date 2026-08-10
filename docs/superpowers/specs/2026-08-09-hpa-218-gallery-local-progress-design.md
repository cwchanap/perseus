# HPA-218 Gallery Local Progress and Continue Design

- **Issue:** HPA-218
- **Parent:** HPA-215
- **Date:** 2026-08-09
- **Status:** Proposed design — review amendments applied

## Objective

Make unfinished current-device puzzle sessions visible from the gallery with the smallest useful
resume experience:

- show one **Continue on this device** entry for the newest resumable session among the puzzle
  contexts the gallery already knows about;
- show an always-visible Continue/progress signal on matching ready server cards;
- keep `/puzzle/[id]` as the only route that loads authoritative puzzle detail and hydrates or
  clears persisted session state.

This remains a gallery-only feature. It does not add a history screen, retained catalog, global
store, backend endpoint, cloud synchronization, compatibility layer, or analytics.

## Current Seams

The required foundations already exist:

- `apps/web/src/lib/services/gameplay/session/persistence.ts` owns the current
  `puzzle-progress-${puzzleId}` format, `loadPersistedSession`, the storage adapter, and
  `isResumable`.
- `PersistedPuzzleSessionV1.lastUpdated` supplies the ordering signal.
- `apps/web/src/routes/+page.svelte` owns the current server `PuzzleSummary[]` lifecycle,
  including search replacement and pagination append.
- Current `PuzzleSummary` includes `pieceCount`, `status`, and optional `aspectRatio`.
- Shared puzzle metadata validation cross-checks `pieceCount`, `gridRows`, `gridCols`, and
  `aspectRatio`, so a listed summary with a valid aspect ratio has trustworthy grid dimensions.
- Metadata validation does **not** prove that every stored `PuzzlePiece.correctX/correctY` follows
  the row-major producer convention. Full puzzle-route hydration does have authoritative pieces.
- Server, Quick Puzzle, and E2E producers currently assign row-major IDs and coordinates:
  `id = row * cols + col`, `correctX = col`, `correctY = row`.
- `listQuick()` returns surviving persisted Quick Puzzle metadata, but it is not a pure lookup: it
  parses complete stored entries and prunes expired/orphaned records, including companion progress
  and stats keys.
- `PuzzleCard.svelte` already reads local best-time storage in `onMount`. HPA-218 still keeps
  progress discovery out of the card because progress requires validation context and global
  newest-selection, not because the card is completely storage-free today.

HPA-557 has merged. Its changes are limited to the puzzle route and extracted puzzle presentation
components, so they do not change these gallery/persistence seams.

## Product Behavior

### Candidate set and bounded newest semantics

The gallery shows at most one **Continue on this device** panel. `newest` means the greatest
`lastUpdated` among resumable sessions for:

1. ready server puzzles present in the page's **current** `puzzles` array; and
2. surviving persisted Quick Puzzles returned by the page's one `listQuick()` call.

This is intentionally not device-global discovery. Search/filter replacement can hide a server
continuation when its summary is no longer loaded. Pagination can make a continuation appear when
its summary becomes loaded. No previously seen server summaries are retained in a hidden catalog.

### Continue panel and matching server card may both render

If the newest resumable session is a loaded server puzzle, the same puzzle appears in two places:

- the standalone **Continue on this device** panel as the fast resume affordance; and
- its normal gallery card with progress.

This duplication is intentional. The panel answers "what should I continue now?" while the card
preserves progress context in the normal gallery. Do not suppress either surface for the matching
puzzle.

### Gallery cards

For a ready server card with valid resumable progress:

- the normal `/puzzle/${id}` href is unchanged;
- the always-visible metadata line shows `CONTINUE · placed/total PLACED`;
- the existing hover/focus overlay may mirror `CONTINUE`, but the overlay remains `aria-hidden`
  and decorative.

The metadata line is the user-facing state because it works on touch devices where the hover
layer is never shown. Tests must assert the always-visible metadata, not treat the opacity-zero
hover overlay as the accessibility or mobile signal.

Cards without resumable progress keep the current piece-count presentation. Processing and failed
cards remain non-clickable and never show Continue progress.

### Quick Puzzle continuation

Quick Puzzle progress may appear in the standalone Continue panel when the corresponding persisted
Quick Puzzle metadata survives the existing `listQuick()` pass. HPA-218 does not add Quick Puzzle
cards to the server gallery and does not make session-only, non-persisted Quick Puzzle metadata
enumerable.

### Completed and invalid sessions

A valid completed snapshot is not resumable and remains stored. Completion-effect reconciliation
continues to belong to puzzle-route hydration.

Gallery discovery is **non-destructive**. It may classify a candidate as missing, loaded, or
invalid, but it must never remove the progress key. This is important because server gallery
validation reconstructs piece coordinates from the current producer convention rather than
reading authoritative `PuzzlePiece[]` detail.

The existing puzzle route keeps the destructive cleanup behavior when the user opens a puzzle:
it builds `SessionValidationContext` from the authoritative loaded puzzle pieces and calls the
normal `loadSession` path. Therefore HPA-218's "invalid/mismatched data is cleared rather than
migrated" rule still applies at the authoritative hydration boundary, not during passive gallery
rendering.

If a server summary lacks a valid runtime `aspectRatio`, has an invalid piece-count/aspect
combination, or otherwise cannot produce a trustworthy derived context, discovery skips it and
leaves its persisted session untouched.

## Recommended Architecture

### 1. Add a non-destructive session peek

Extend the existing `SessionStorageAdapter` with one read-only method:

```ts
export interface SessionStorageAdapter {
	peekSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult;
	loadSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult;
	saveSession(puzzleId: string, snapshot: PersistedPuzzleSessionV1): void;
	clearSession(puzzleId: string): void;
	isResumable(snapshot: PersistedPuzzleSessionV1): boolean;
}
```

`peekSession` and `loadSession` share the same storage read and `loadPersistedSession` parser.
Their only difference is invalid handling:

- `peekSession`: return `{ status: 'invalid', reason }` and leave storage untouched;
- `loadSession`: preserve today's behavior by removing invalid data and returning `missing`.

This keeps one parser/validator while making passive discovery explicitly read-only. Do not add a
second gallery-local session parser.

### 2. Add one gallery discovery service

Create:

`apps/web/src/lib/services/gameplay/galleryProgress.ts`

```ts
export interface GalleryProgress {
	puzzleId: string;
	name: string;
	source: PuzzleSourceType;
	placedCount: number;
	pieceCount: number;
	lastUpdated: number;
}

export interface GalleryProgressDiscovery {
	byPuzzleId: ReadonlyMap<string, GalleryProgress>;
	newest: GalleryProgress | null;
}

export function discoverGalleryProgress(options: {
	serverPuzzles: readonly PuzzleSummary[];
	quickPuzzles: readonly StoredQuickPuzzle[];
	sessionStorage?: SessionStorageAdapter;
}): GalleryProgressDiscovery;
```

The service receives its candidate catalogs from the page, builds validation contexts, calls
`peekSession`, filters with `isResumable`, returns per-server-card progress, and selects the
largest `lastUpdated` in one pass.

It does not enumerate localStorage keys, call the network, retain old server summaries, or clear
invalid data.

### Server candidate construction

For each server summary:

1. require `status === 'ready'`;
2. require `isPuzzleAspectRatio(puzzle.aspectRatio)` **before** any aspect-ratio grid helper;
3. require `isValidPieceCountForAspectRatio(puzzle.pieceCount, puzzle.aspectRatio)`;
4. derive `{ rows, cols }` with `getGridDimensionsForAspectRatio`;
5. derive row-major canonical piece descriptors;
6. build `SessionValidationContext` with source `api`;
7. call `peekSession`;
8. include only a loaded, resumable snapshot.

The row-major derivation stays private:

```ts
const pieces = Array.from({ length: puzzle.pieceCount }, (_, id) => ({
	id,
	correctX: id % cols,
	correctY: Math.floor(id / cols)
}));
```

Do not add a shared row-major helper solely for this ticket. Lock this convention with explicit
expected tuples for representative `2x2`, `3x4`, and `4x3` grids. If the production coordinate
contract later gains real complexity, extraction can be reconsidered then.

### Quick Puzzle candidate construction

For each provided `StoredQuickPuzzle`, use its persisted `gridCols`, `gridRows`, `pieceCount`, and
canonical `pieces` directly to build a source `local` validation context. No Quick Puzzle image is
decoded or rendered during discovery.

### 3. Read Quick Puzzle metadata once per gallery mount

`listQuick()` is intentionally called once when the gallery mounts:

```ts
let quickPuzzles: StoredQuickPuzzle[] = $state([]);

onMount(() => {
	quickPuzzles = listQuick();
});

$effect(() => {
	const serverPuzzles = puzzles;
	const localPuzzles = quickPuzzles;
	localProgress = discoverGalleryProgress({
		serverPuzzles,
		quickPuzzles: localPuzzles
	});
});
```

The discovery effect may rerun when `puzzles` changes and once when `quickPuzzles` is populated.
It must not call `listQuick()` itself. Search changes and infinite-scroll appends therefore do not
re-parse large base64 Quick Puzzle records or rerun the Quick Puzzle pruning side effects.

No storage-event listener or Quick Puzzle cache subsystem is added. Navigating away and back to
the gallery naturally performs a fresh mount-time read.

### 4. Keep `PuzzleCard` presentational for progress

Extend its prop surface only:

```ts
interface Props {
	puzzle: PuzzleSummary;
	placedCount?: number;
}
```

The page decides whether progress is valid. The card renders the always-visible Continue/progress
metadata and keeps its existing best-time behavior. It does not build validation contexts or
select the newest session.

## Data Flow

```text
gallery mount ----> listQuick() once ----------------------+
                                                          |
fetchPuzzles()/filter/pagination ----> current puzzles ---+----> discoverGalleryProgress
                                                                  |
                                                        derived / stored contexts
                                                                  |
                                                        SessionStorageAdapter.peekSession
                                                                  |
                                                     loaded + isResumable only
                                                                  |
                                                   { byPuzzleId, newest }
                                                      |             |
                                                      v             v
                                                PuzzleCard       Continue panel
                                                      \             /
                                                       \           /
                                                        /puzzle/[id]
                                                             |
                                                  authoritative detail load
                                                             |
                                                  loadSession cleanup/hydration
```

## Error Handling

- Storage read failures keep the existing adapter behavior: report through `onError` if supplied
  and behave as missing.
- Invalid gallery candidates are ignored and left stored.
- Invalid data is still removed by the normal authoritative puzzle-route `loadSession` path.
- Bad/missing runtime aspect ratios are rejected before grid helpers run.
- Quick Puzzle expiry/orphan pruning remains owned by the one mount-time `listQuick()` call.
- One bad candidate never aborts discovery for other candidates.

No user-facing repair flow is added.

## Testing Strategy

### Session persistence seam

Add one focused test proving:

- `peekSession` returns `invalid` for a malformed/current-context mismatch and leaves the key;
- `loadSession` on the same invalid data preserves today's destructive cleanup behavior.

This is the only new cleanup/retention test HPA-218 needs.

### Gallery discovery

Focused tests cover:

- explicit row-major tuples for `1:1`/4 (`2x2`), `4:3`/12 (`3x4`), and `3:4`/12 (`4x3`);
- runtime-invalid `aspectRatio` is skipped without throwing or deleting storage;
- greatest `lastUpdated` among current resumable candidates wins;
- placed count is `snapshot.placedPieces.length`;
- fresh/no-activity and completed snapshots are excluded;
- a valid completed snapshot remains stored because discovery only peeks;
- invalid snapshots are ignored and remain stored until authoritative puzzle open;
- Quick Puzzle discovery uses supplied metadata without a network call.

### PuzzleCard

Component tests cover:

- normal cards keep the existing piece count;
- progress cards show the always-visible `CONTINUE · placed/total PLACED` metadata;
- href remains `/puzzle/${id}`;
- processing/failed cards never show Continue progress;
- the overlay remains decorative (`aria-hidden`); tests do not use it as the user-facing signal.

### Gallery page

Route tests cover:

- `listQuick()` runs once per mount even after server puzzle replacement;
- discovery receives the fetched current server summaries and the stored `quickPuzzles` array;
- discovery receives replacement summaries after a search/filter update without re-calling
  `listQuick()`;
- a newest server session intentionally renders both the Continue panel and progress on its
  matching card;
- a Quick Puzzle newest session can render the panel without creating a server card.

### Browser smoke

Extend the existing gallery Playwright file with one current-schema partial server-session case.
The test explicitly verifies both surfaces for the same puzzle:

- Continue panel visible;
- matching card's always-visible Continue/progress metadata visible;
- Continue navigation reaches `/puzzle/[id]` through the existing fixture-backed route.

Reuse HPA-226 `seedValid`, `buildMinimalSeed`, and the existing fixture router.

## Alternatives Considered

### Per-card progress reads

Rejected. `PuzzleCard` already has a small best-time read, so avoiding *all* storage in the card is
not the reason. Progress requires geometry-aware current-schema validation and one cross-card
newest selection; doing that per card would duplicate context construction and still require a
separate aggregator for the panel.

### Device-global localStorage scan / retained server catalog

Rejected. It expands scope, complicates filter semantics, and is unnecessary for the bounded
"currently discoverable" requirement.

### Backend detail/batch validation

Rejected. Device-local progress should not add per-card or batch server work when current gallery
metadata is sufficient for non-destructive discovery.

### Shared row-major helper now

Not planned by default. The contract is currently a five-line convention with explicit producer
examples, so exact parity tests are cheaper today. If implementation reveals concrete reuse or
correctness pressure that makes the existing producers meaningfully safer with a shared helper,
that refactor can be evaluated on its merits rather than being forbidden by this ticket.

## Non-goals

- device-global session history;
- retaining previously-seen server summaries;
- a new Quick Puzzle catalog/cache;
- per-card puzzle-detail requests;
- server-side local-session validation;
- cloud/cross-device progress or account semantics;
- compatibility readers or migrations;
- retention/recovery UI;
- analytics;
- changing puzzle-route hydration or HPA-557 presentation components;
- a global gallery progress store.

## Risks and Mitigations

### Derived server coordinates drift from authoritative puzzle pieces

Discovery is read-only, so drift can hide Continue but cannot delete progress. Explicit `2x2`,
`3x4`, and `4x3` tuple tests catch accidental transpose/order changes. Opening the puzzle remains
the authoritative validation point.

### Quick Puzzle enumeration becomes expensive during gallery interaction

Call `listQuick()` once on mount, not inside the reactive discovery effect. Search, category, and
pagination mutations reuse the already-loaded Quick Puzzle metadata for that page lifetime.

### Panel/card duplication looks accidental

Document it as intentional and test the overlapping server-puzzle case directly in both route and
E2E coverage.

### Hover-only Continue is invisible on touch

Treat the always-visible metadata row as the user-facing Continue signal. The hover/focus overlay
is decorative and may mirror the wording for desktop consistency.

## Review Amendments — 2026-08-10

Two review passes were validated against current `main` and incorporated without introducing a
new subsystem:

1. guard runtime `aspectRatio` before aspect-ratio helpers;
2. assert page-to-discovery wiring rather than only mocked presentation;
3. define newest as bounded to current server summaries plus surviving Quick Puzzle metadata;
4. lock row-major parity with explicit tuples instead of requiring a new helper;
5. make gallery validation non-destructive through `peekSession` and leave cleanup at
   authoritative puzzle open;
6. call `listQuick()` once on mount rather than on every `puzzles` mutation;
7. explicitly keep panel/card overlap for the newest loaded server puzzle;
8. make always-visible card metadata the mobile/user-facing Continue signal;
9. correct the per-card-storage rationale to reflect the card's existing best-time read;
10. trim final verification to real test/check/build/E2E gates.

## Acceptance Mapping

| HPA-218 acceptance criterion | Design response |
| --- | --- |
| Newest valid unfinished current candidate is shown | Max `lastUpdated` among current ready server summaries + mount-time `listQuick()` metadata |
| Matching cards display progress and Continue | Always-visible `CONTINUE · placed/total PLACED`; href unchanged |
| Completed sessions are not resumable | `isResumable` excludes them; read-only discovery leaves them stored |
| Invalid/mismatched data is cleared rather than migrated | Gallery ignores invalid data; existing authoritative puzzle-route `loadSession` clears it on open |
| Bad derived context cannot destroy progress | Gallery uses non-destructive `peekSession` and runtime geometry guards |
| No per-card network requests | Server context derives from current summary; Quick uses one mount-time local read |
| Focused tests | Peek semantics, geometry parity, discovery, card, page wiring/overlap, and one browser smoke |
