# HPA-218 Gallery Local Progress and Continue Design

- **Issue:** HPA-218
- **Parent:** HPA-215
- **Date:** 2026-08-09
- **Last reviewed:** 2026-08-10
- **Status:** Approved design

## Objective

Make unfinished current-device puzzle sessions visible from the gallery with the smallest useful
resume experience:

- show one **Continue on this device** entry for the newest valid unfinished session among the
  puzzle contexts the gallery can currently identify without extra network requests;
- show placed/total progress on matching server gallery cards and change their action label from
  **Play** to **Continue**;
- keep the existing `/puzzle/[id]` route responsible for loading the puzzle and hydrating the
  persisted session.

The candidate set is deliberately bounded to:

1. ready server puzzles present in the gallery page's current `PuzzleSummary[]`; and
2. surviving persisted Quick Puzzles returned by `listQuick()`.

This is not a device-global recent-session catalog. A resumable server puzzle that is not in the
currently loaded gallery summaries is intentionally not discoverable until that summary is loaded
again.

HPA-556 has removed the pre-release persistence compatibility paths, so this feature reads only
the current `PersistedPuzzleSessionV1` schema. Invalid current-device data is deleted instead of
migrated or recovered.

## Context and Existing Seams

The required foundation already exists:

- `apps/web/src/lib/services/gameplay/session/persistence.ts` owns the canonical
  `puzzle-progress-${puzzleId}` key, current-schema parsing, geometry validation, invalid-record
  cleanup, and `isResumable`.
- `PersistedPuzzleSessionV1.lastUpdated` provides the ordering signal for the newest session.
- `isResumable` already implements the product definition needed here: an `active` or `paused`
  session with user activity and no sealed completion.
- `apps/web/src/routes/+page.svelte` already owns the currently loaded server `PuzzleSummary[]`
  and pagination/filter lifecycle.
- `PuzzleSummary` already includes `pieceCount` and optional `aspectRatio` for current server
  puzzles.
- Server puzzle generation uses row-major piece IDs (`row * cols + col`) and canonical
  coordinates (`correctX = col`, `correctY = row`). The Quick Puzzle generator and deterministic
  E2E fixture builder use the same contract.
- `getGridDimensionsForAspectRatio`, `isPuzzleAspectRatio`, and
  `isValidPieceCountForAspectRatio` already live in `@perseus/types`.
- `listQuick()` already returns surviving local Quick Puzzle metadata, including grid dimensions
  and canonical piece coordinates, while pruning expired/orphaned entries.
- `PuzzleCard.svelte` already owns the server-card action label and compact metadata row.
- `apps/web/e2e/gameplay-fixtures/persisted-state.ts` already seeds persisted sessions through the
  production codec before writing them.

The web API client casts a successful JSON object to its TypeScript response type rather than
runtime-validating every `PuzzleSummary` field. A corrupted or unexpected `aspectRatio` value can
therefore reach gallery code even though the normal server path should produce valid metadata.
The gallery context builder must guard the runtime value before calling grid helpers.

HPA-557 is currently changing the puzzle-route presentation boundaries, but HPA-218 does not
need to modify the puzzle route. Keeping HPA-218 gallery-only avoids coupling this work to that
in-flight refactor.

## Product Behavior

### Continue on this device

The gallery shows at most one compact **Continue on this device** section. It represents the
resumable session with the greatest `lastUpdated` value among the currently discoverable puzzle
contexts:

1. ready server puzzles present in the page's current `puzzles` array; and
2. surviving persisted Quick Puzzles returned by `listQuick()`.

The entry shows the puzzle name and placed/total count, then links directly to
`/puzzle/${puzzleId}`. The puzzle route performs normal source loading and session hydration.
The gallery does not preload the puzzle or create a second hydration path.

A server session is intentionally invisible when its puzzle is not present in the gallery data
currently held by the page. Search/filter changes can therefore hide that continuation until the
matching puzzle is loaded again. This follows HPA-218's "already loaded gallery data" constraint
without creating a retained catalog or cache.

A Quick Puzzle session may appear only while its existing persisted Quick Puzzle metadata is
returned by `listQuick()`. Session-only Quick Puzzle metadata that was never persisted is not
made enumerable for this feature; adding a second cross-source catalog is out of scope.

### Gallery cards

For every ready server card with a valid resumable local session:

- the overlay label changes from **PLAY** to **CONTINUE**;
- the compact piece-count line changes from `N PCS` to `placed/N PLACED`;
- the card keeps the same `/puzzle/${id}` href and existing best-time display.

Cards without resumable progress retain today's rendering. Processing and failed cards remain
non-clickable and never present Continue, even if a stale progress key exists.

### Completed and invalid sessions

A valid completed snapshot is **ignored but not deleted**. Completed persistence can still carry
completion-effect state that the puzzle route may need to reconcile, so HPA-218 must not treat
"not resumable" as "safe to clear."

A record is deleted only when the existing current-schema loader reports it invalid. That
includes malformed JSON, unsupported schema versions, source mismatches, piece/grid mismatches,
and the existing cross-field validation failures. HPA-218 adds no migration, repair, or fallback
parser.

If current server summary metadata is insufficient or invalid for constructing a validation
context, the gallery skips that candidate rather than guessing geometry or deleting progress it
cannot safely validate. This includes:

- missing `aspectRatio`;
- a runtime `aspectRatio` value that fails `isPuzzleAspectRatio`;
- an invalid piece-count/aspect-ratio combination;
- a non-ready summary.

Skipping one bad summary must not abort discovery for other candidates.

## Recommended Architecture

Add one small service:

`apps/web/src/lib/services/gameplay/galleryProgress.ts`

It converts the data already available to the gallery into validation contexts, delegates all
persisted-session validation and cleanup to the existing `SessionStorageAdapter`, and returns a
view-friendly result.

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

The service is synchronous because every input and persisted-session read is local. Production
uses `createSessionStorageAdapter()` by default; tests can inject an adapter backed by an
in-memory `Storage` or a small spy adapter.

### Server candidate construction

For each server summary:

1. require `status === 'ready'`;
2. require `isPuzzleAspectRatio(puzzle.aspectRatio)` **before** calling any aspect-ratio grid
   helper;
3. require `isValidPieceCountForAspectRatio(puzzle.pieceCount, puzzle.aspectRatio)`;
4. derive `{ rows, cols }` with `getGridDimensionsForAspectRatio`;
5. construct canonical row-major pieces for IDs `0..pieceCount - 1`;
6. build `SessionValidationContext` with source `api`;
7. call `sessionStorage.loadSession(puzzle.id, context)`;
8. include the loaded snapshot only when `sessionStorage.isResumable(snapshot)` is true.

The runtime guard is intentionally local and cheap. Do not catch a thrown grid helper after the
fact when the input can be rejected first.

Because `loadSession` already removes invalid records, discovery must not add its own deletion or
session-validation policy.

### Row-major geometry contract

The gallery needs a tiny private derivation:

```ts
const pieces = Array.from({ length: puzzle.pieceCount }, (_, id) => ({
	id,
	correctX: id % cols,
	correctY: Math.floor(id / cols)
}));
```

Do **not** add a new shared `buildRowMajorCanonicalPieces` helper for HPA-218. There are currently
only a few simple producers and this ticket does not need another public abstraction. Instead,
lock parity with table-driven tests for representative supported grids:

- `1:1`, 4 pieces → 2x2;
- `4:3`, 12 pieces → 3x4;
- `3:4`, 12 pieces → 4x3.

The expected `{ id, correctX, correctY }` tuples must be explicit in the test so a transpose or
ID-order drift fails visibly. If the production generation contract becomes more complex later,
extracting a shared helper can be evaluated with real pressure rather than preemptively.

### Quick Puzzle candidate construction

For each `StoredQuickPuzzle` returned by `listQuick()`:

1. use its stored `gridCols`, `gridRows`, `pieceCount`, and `pieces` directly;
2. build `SessionValidationContext` with source `local`;
3. call the same `loadSession` and `isResumable` path.

No Quick Puzzle image is decoded or rendered during discovery.

### Gallery page integration

`+page.svelte` keeps one local discovery result and refreshes it whenever the currently loaded
`puzzles` array changes. The effect calls `listQuick()` and `discoverGalleryProgress(...)`.
This is intentionally not a global store:

- returning to the gallery creates a fresh discovery pass from local persistence;
- pagination adds candidates naturally when the page appends summaries;
- search/category replacement naturally removes server candidates no longer in the current
  result set;
- no storage-event listener, cache invalidation, or cross-tab synchronization is needed.

The page renders the standalone Continue section from `discovery.newest` and passes the matching
`placedCount` to `PuzzleCard` from `discovery.byPuzzleId`.

Route tests may mock `discoverGalleryProgress` to keep presentation assertions focused, but they
must also verify the page wiring itself:

- after a server fetch resolves, discovery receives that exact current server summary array and
  the current `listQuick()` return value;
- after a search/filter replacement, discovery receives the replacement summary array rather
  than stale results.

This closes the integration seam without duplicating the service tests inside the route test.

### PuzzleCard contract

Keep `PuzzleCard` presentational with one optional prop:

```ts
interface Props {
	puzzle: PuzzleSummary;
	placedCount?: number;
}
```

The parent decides whether a session is valid/resumable. `PuzzleCard` does not read localStorage,
construct validation contexts, or select the newest session.

## Alternatives Considered

### 1. Central gallery discovery service — recommended

**Pros**

- reuses the canonical persistence validator and invalid cleanup;
- performs zero additional network requests;
- supports both server cards and the one Quick Puzzle continuation;
- keeps localStorage/session semantics out of `PuzzleCard`;
- has one deterministic place to test candidate ordering and geometry context construction.

**Cons**

- adds one small gallery-specific service.

This is the best tradeoff because the service is a thin adapter over existing contracts rather
than a new state subsystem.

### 2. Let every PuzzleCard read its own progress

This reduces the number of new files but spreads persistence knowledge across rendered cards,
duplicates geometry/context construction, makes newest-session selection awkward, and still
needs separate logic for Quick Puzzle continuation. It also couples a reusable presentational
component to browser storage. Rejected.

### 3. Add API detail/batch validation or enrich the backend specifically for resume

The server could return full piece metadata or validate local sessions, but that adds backend
contract work and network dependency to a device-local feature. It directly conflicts with the
HPA-218 guardrail against batch validation and per-card availability requests. Rejected.

### 4. Extract a shared row-major-piece builder now

A five-line shared helper could remove literal duplication, but the contract is simple and the
current producers also construct additional producer-specific fields such as edges and image
paths. HPA-218 only needs `{ id, correctX, correctY }`. Explicit parity tests give the required
confidence with less public API surface. Rejected for now under YAGNI.

## Data Flow

```text
server fetchPuzzles() ----------------------+
                                            |
                                            v
                                   current PuzzleSummary[]
                                            |
listQuick() -> StoredQuickPuzzle[] ----------+----> galleryProgress discovery
                                                       |
                                                       | guard summary + build context
                                                       v
                                            SessionStorageAdapter.loadSession()
                                                       |
                                          invalid -----+-----> existing cleanup
                                                       |
                                                    loaded
                                                       |
                                            SessionStorageAdapter.isResumable()
                                                       |
                                                       v
                                  { byPuzzleId, newest GalleryProgress }
                                      |                         |
                                      v                         v
                              PuzzleCard progress       Continue on this device
                                      \                         /
                                       \                       /
                                        +--> /puzzle/[id] <---+
                                                |
                                                v
                                      existing route hydration
```

## Error Handling

- Browser storage read/remove failures continue through the existing adapter's resilient behavior;
  discovery simply omits a session it cannot read.
- Invalid persisted sessions are removed by the adapter and then appear as missing.
- Missing, unsupported, or invalid server summary metadata is skipped before grid helpers run;
  its progress record remains untouched because there is no trustworthy validation context.
- A bad summary affects only that candidate and cannot blank the rest of the Continue UI.
- Quick Puzzle pruning/expiry continues to be owned by `listQuick()`.
- Discovery never throws solely because one candidate has no progress or malformed summary
  metadata.

No recovery banners or user-facing repair actions are added.

## Testing Strategy

### Gallery-progress service

Focused tests cover:

- reconstructing current server geometry from `pieceCount + aspectRatio`;
- explicit row-major parity for representative `1:1`, `4:3`, and `3:4` grids using exact
  `{ id, correctX, correctY }` tuples;
- skipping a runtime-unknown aspect ratio such as `16:9` without throwing, calling the storage
  adapter, or deleting an unvalidated progress record;
- using Quick Puzzle canonical metadata without network access;
- selecting the greatest `lastUpdated` resumable session among current candidates;
- returning per-puzzle placed counts;
- excluding fresh/no-activity and completed snapshots;
- preserving valid completed snapshots in storage;
- clearing unsupported-schema and geometry-mismatched records through the existing adapter;
- skipping a server summary that lacks enough current metadata to validate, without deleting an
  unvalidated record.

### PuzzleCard

Component tests cover:

- default **PLAY** and `N PCS` rendering;
- **CONTINUE** plus `placed/N PLACED` when `placedCount` is provided;
- unchanged puzzle href;
- processing/failed cards never exposing Continue.

### Gallery page

Route tests cover:

- rendering the newest-current-candidate Continue panel;
- applying progress only to the matching server card;
- verifying `discoverGalleryProgress` receives the fetched server summaries and the exact
  `listQuick()` result;
- verifying a search/filter replacement re-runs discovery with the replacement summaries, not
  stale data;
- keeping existing search/pagination behavior intact.

### Browser smoke

Extend the existing gallery Playwright coverage with one current-schema persisted-session case:
seed a valid partial session, reload the gallery, verify Continue/progress, click the existing
puzzle link, and assert navigation to `/puzzle/[id]`. Reuse the HPA-226 persisted-state helper so
the E2E seed is accepted by the production codec before it is written.

## Non-goals

- device-global session history or a dedicated recent-games route;
- retaining a server puzzle catalog across search/filter changes;
- server-side local-session validation;
- per-card puzzle detail requests;
- cloud/cross-device progress;
- account semantics;
- storage migrations or compatibility readers;
- retention policy or stale-session UI;
- analytics;
- changing puzzle-route hydration or HPA-557 component boundaries;
- adding a new global store/cache/controller;
- extracting a shared row-major geometry abstraction solely for this ticket.

## Risks and Mitigations

### Derived server geometry drifts from generation

The discovery context depends on the current row-major generation contract. Keep the derivation
private and small. Lock exact tuples for 2x2, 3x4, and 4x3 grids in service tests so transposition,
ID-order, or coordinate drift is caught without adding another shared abstraction. If the server
generation contract changes later, that change should update this context builder and parity test
in the same change set.

### Unexpected runtime aspect-ratio value aborts discovery

The TypeScript type alone is not a runtime boundary. Guard with `isPuzzleAspectRatio` before
`isValidPieceCountForAspectRatio` or `getGridDimensionsForAspectRatio`. Invalid values are skipped
and their local progress remains untouched.

### Gallery filtering hides a resumable server puzzle

This is deliberate: HPA-218 allows server progress only for puzzle data already loaded by the
page. Retaining previously seen summaries would introduce a hidden catalog/cache that the issue
explicitly does not need.

### Page tests prove presentation but not discovery wiring

Keep the discovery service mocked in route tests for focused rendering, but assert its call
arguments after initial fetch and one replacement fetch. The browser smoke then proves the full
service-to-page-to-navigation path.

### Completed snapshots are accidentally cleared

Discovery must distinguish `invalid` from merely `not resumable`. Only `loadSession` invalidation
may clear storage; `isResumable === false` never triggers deletion.

## Review Amendments — 2026-08-10

The following review findings were validated against current `main` and incorporated without
changing the architecture or file set:

1. guard runtime `aspectRatio` with `isPuzzleAspectRatio` before calling grid helpers;
2. assert the gallery page passes current server summaries and `listQuick()` data into discovery;
3. define "newest" as newest among the currently discoverable candidate set, not device-global;
4. add explicit row-major parity tests across the three supported aspect ratios instead of a new
   shared geometry helper.

## Acceptance Mapping

| HPA-218 acceptance criterion | Design response |
| --- | --- |
| Newest valid unfinished session among current gallery summaries + `listQuick()` is shown | Choose max `lastUpdated` among currently discovered resumable contexts |
| Matching cards display progress and resume | `byPuzzleId` drives `PuzzleCard`; href remains `/puzzle/[id]` |
| Completed sessions are not resumable | Reuse `isResumable`; leave valid completed record intact |
| Invalid/mismatched data is cleared, not migrated | Reuse current `loadSession` cleanup path only when a trustworthy context exists |
| One bad/malformed summary does not blank discovery | Runtime aspect-ratio guard skips the candidate before grid helpers run |
| No per-card network requests | Reconstruct server context from loaded summary; Quick uses `listQuick()` |
| Focused tests | Service parity/guard tests, card tests, route wiring assertions, and one gallery smoke case |
