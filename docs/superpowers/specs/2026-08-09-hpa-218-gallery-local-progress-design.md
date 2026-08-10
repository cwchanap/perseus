# HPA-218 Gallery Local Progress and Continue Design

- **Issue:** HPA-218
- **Parent:** HPA-215
- **Date:** 2026-08-09
- **Status:** Proposed design

## Objective

Make unfinished current-device puzzle sessions visible from the gallery with the smallest useful
resume experience:

- show one **Continue on this device** entry for the newest valid unfinished session that the
  gallery can identify without extra network requests;
- show placed/total progress on matching server gallery cards and change their action label from
  **Play** to **Continue**;
- keep the existing `/puzzle/[id]` route responsible for loading the puzzle and hydrating the
  persisted session.

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
- `PuzzleSummary` already includes `pieceCount` and `aspectRatio` for current server puzzles.
- Server puzzle generation uses row-major piece IDs (`row * cols + col`) and canonical
  coordinates (`correctX = col`, `correctY = row`). Therefore the gallery can reconstruct the
  exact `SessionValidationContext` from a ready summary by using
  `getGridDimensionsForAspectRatio`—no detail fetch is required.
- `listQuick()` already returns surviving local Quick Puzzle metadata, including grid dimensions
  and canonical piece coordinates, while pruning expired/orphaned entries.
- `PuzzleCard.svelte` already owns the server-card action label and compact metadata row.

HPA-557 is currently changing the puzzle-route presentation boundaries, but HPA-218 does not
need to modify the puzzle route. Keeping HPA-218 gallery-only avoids coupling this work to that
in-flight refactor.

## Product Behavior

### Continue on this device

The gallery shows at most one compact **Continue on this device** section. It represents the
resumable session with the greatest `lastUpdated` value among the puzzle contexts currently
available to the gallery:

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

If current server summary metadata is insufficient to construct a validation context (for
example, a summary lacks `aspectRatio`), the gallery skips that candidate rather than guessing a
geometry or deleting its progress without enough information to validate it.

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

The service is synchronous because every input and persisted session read is local. Production
uses `createSessionStorageAdapter()` by default; tests can inject an adapter backed by an
in-memory `Storage`.

### Server candidate construction

For each `status === 'ready'` summary with a current `aspectRatio` and a valid piece-count/aspect
combination:

1. derive `{ rows, cols }` with `getGridDimensionsForAspectRatio`;
2. construct canonical row-major pieces for IDs `0..pieceCount - 1`;
3. build `SessionValidationContext` with source `api`;
4. call `sessionStorage.loadSession(puzzle.id, context)`;
5. include the loaded snapshot only when `sessionStorage.isResumable(snapshot)` is true.

Because `loadSession` already removes invalid records, discovery must not add its own deletion or
validation policy.

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
- has one deterministic place to test newest-session selection.

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

## Data Flow

```text
server fetchPuzzles() ----------------------+
                                            |
                                            v
                                   current PuzzleSummary[]
                                            |
listQuick() -> StoredQuickPuzzle[] ----------+----> galleryProgress discovery
                                                       |
                                                       | builds validation contexts
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
- A missing/invalid server summary context is skipped; no network request is made to compensate.
- Quick Puzzle pruning/expiry continues to be owned by `listQuick()`.
- Discovery never throws solely because one candidate has no progress.

No recovery banners or user-facing repair actions are added.

## Testing Strategy

### Gallery-progress service

Focused tests cover:

- reconstructing current server geometry from `pieceCount + aspectRatio`;
- using Quick Puzzle canonical metadata without network access;
- selecting the greatest `lastUpdated` resumable session;
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

- rendering the newest Continue panel;
- applying progress only to the matching server card;
- keeping existing search/pagination behavior intact.

### Browser smoke

Extend the existing gallery Playwright coverage with one current-schema persisted-session case:
seed a valid partial session, reload the gallery, verify Continue/progress, click the existing
puzzle link, and assert navigation to `/puzzle/[id]`. Reuse the HPA-226 persisted-state helper so
the E2E seed is accepted by the production codec before it is written.

## Non-goals

- session history or a dedicated recent-games route;
- retaining a server puzzle catalog across search/filter changes;
- server-side local-session validation;
- per-card puzzle detail requests;
- cloud/cross-device progress;
- account semantics;
- storage migrations or compatibility readers;
- retention policy or stale-session UI;
- analytics;
- changing puzzle-route hydration or HPA-557 component boundaries;
- adding a new global store/cache/controller.

## Risks and Mitigations

### Derived server geometry drifts from generation

The discovery context depends on the current row-major generation contract. Keep the derivation
small and test it against the same shared grid helper and representative aspect ratios. If the
server generation contract changes later, that change should update this context builder in the
same change set.

### Gallery filtering hides a resumable server puzzle

This is deliberate: HPA-218 allows server progress only for puzzle data already loaded by the
page. Retaining previously seen summaries would introduce a hidden catalog/cache that the issue
explicitly does not need.

### Completed snapshots are accidentally cleared

Discovery must distinguish `invalid` from merely `not resumable`. Only `loadSession` invalidation
may clear storage; `isResumable === false` never triggers deletion.

## Acceptance Mapping

| HPA-218 acceptance criterion | Design response |
| --- | --- |
| Newest valid unfinished session is shown | Choose max `lastUpdated` among discovered resumable contexts |
| Matching cards display progress and resume | `byPuzzleId` drives `PuzzleCard`; href remains `/puzzle/[id]` |
| Completed sessions are not resumable | Reuse `isResumable`; leave valid completed record intact |
| Invalid/mismatched data is cleared, not migrated | Reuse current `loadSession` cleanup path only |
| No per-card network requests | Reconstruct server context from loaded summary; Quick uses `listQuick()` |
| Focused tests | Service, card, route, and one gallery smoke case |
