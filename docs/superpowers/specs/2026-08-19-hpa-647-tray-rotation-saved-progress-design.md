# HPA-647: Tray Rotation and Saved Progress Picker — Design

**Linear:** HPA-647  
**Status:** Design for implementation  
**Date:** 2026-08-19

## Context

HPA-647 combines two direct puzzle UX fixes into one small shipping slice:

1. the tray currently renders a Rotate button on top of every unplaced piece while rotation mode is enabled, which obscures small piece artwork; and
2. the gallery exposes only the newest **Continue on this device** entry, so the player cannot intentionally resume an older current-device save.

Current `main` already has the required domain and persistence seams:

- `PuzzlePiece.svelte` owns piece selection, the `R` keyboard shortcut, orientation naming, and the overlaid Rotate button;
- `PuzzleInventoryPanel.svelte` already receives `selectedPieceId`, `rotationEnabled`, and `onRotate(pieceId)`, and already has a header action row beside `CANCEL`;
- `PuzzleSession` owns rotation state, history, timer start, result-class facts, and selection validity;
- `+page.svelte` already loads Quick Puzzle metadata once and projects the cheap newest/card progress view with `discoverGalleryProgress()`;
- `persistence.ts` owns the `puzzle-progress-` namespace and read-only `peekSession()` validation path;
- `fetchPuzzle(id)` already resolves full server puzzle metadata;
- `modalFocus` plus `DiscardSessionDialog.svelte` establish the concrete modal pattern.

The change is therefore UI plus a read-only save projection. It is not a new save system.

## Goals

1. Remove the Rotate overlay from tray thumbnails.
2. Preserve pointer/touch rotation through one selected-piece `ROTATE` action in the inventory header.
3. Preserve focused-piece `R` rotation and orientation accessibility.
4. Keep the newest **Continue on this device** path cheap and immediate.
5. Make **VIEW SAVED PROGRESS** reachable when at least one app-owned current-schema save is plausibly resumable, even when that save is outside the current gallery page/filter.
6. Do not show a saved-progress affordance for completed-only, no-activity, malformed, or old-schema keys.
7. Resolve and fully validate the complete saved-progress list only when the picker opens.
8. Reuse one explicit piece-geometry validator for Quick metadata and fetched server puzzle detail.
9. Migrate the existing puzzle-route rotation integration tests in the same task as the overlay removal.
10. Keep passive discovery non-destructive.

## Non-goals

- Persistence schema changes or migrations.
- Multiple named save slots for one puzzle.
- Cloud or cross-device synchronization.
- A retained save index or global progress store.
- A new server batch endpoint.
- Save rename/delete/search/filter/pagination inside the picker.
- A new saved-progress route.
- A generic modal/list framework.
- Changes to `PuzzleSession`, rotation scoring, result classes, or API/database contracts.
- Backward compatibility for pre-release session formats.

## Verified reuse and breakage survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Rotate one piece | route `onRotate` → `rotate_piece` | Reuse unchanged |
| Keyboard rotation | `PuzzlePiece` native `R` handler | Keep unchanged |
| Pointer/touch selected-piece action | `PuzzleInventoryPanel.panel-actions` | Add one concrete `ROTATE` button |
| Rotation state/history/timer | `PuzzleSession` | No domain change |
| Existing integration coverage | `routes/puzzle/[id]/page.svelte.test.ts` directly clicks `Rotate piece N` in rotation/history/timer/rejection/announcer tests | Migrate in the same rotation task; do not leave CI breakage for final verification |
| Immediate newest Continue | `discoverGalleryProgress().newest` | Keep current cheap projection |
| Save-key ownership | `PROGRESS_KEY_PREFIX = 'puzzle-progress-'` | Keep the prefix scan inside persistence |
| Resumable predicate | `isResumable()` uses lifecycle, seal, and `hasUserActivity` | Reuse the same predicate for a geometry-free mount probe |
| Full read-only validation | `peekSession()` + current codec | Reuse only when picker opens |
| Quick metadata | mount-time `listQuick()` | Reuse the same array |
| Loaded server metadata | current `PuzzleSummary[]` | Reuse without detail fetch |
| Missing server metadata | `fetchPuzzle(id)` | Resolve lazily on picker open |
| Explicit piece validation | Quick validation already checks ids/cells/bounds; session construction has equivalent invariant checks | Extract one nullable explicit-geometry helper for Quick + fetched detail |
| Dialog focus | `modalFocus` | One `SavedProgressDialog.svelte` |
| Navigation | existing `/puzzle/[id]` route | Direct Continue links |

## Option selected: cheap resumable-candidate probe + lazy authoritative discovery

The original idea of gating the picker on “any `puzzle-progress-` key exists” is too weak. Completed sessions are intentionally kept in storage, and `discoverGalleryProgress()` already excludes them from Continue. Showing **SAVED PROGRESS AVAILABLE** for a completed-only key would open an empty picker.

The selected approach has two levels of discovery:

1. **Mount-time candidate probe:** scan only Perseus-owned session keys, read their local JSON, and apply a geometry-free current-schema resumability probe. No puzzle metadata and no network request.
2. **Picker-time authoritative discovery:** resolve metadata, construct a full `SessionValidationContext`, call `peekSession()`, and include only fully valid resumable rows.

This adds no index and no second persistence schema. The first level answers only “is there a plausible save worth exposing a picker for?”; the second level remains authoritative.

A persisted index and a batch API remain rejected: both add more lifecycle and synchronization machinery than a hobby-project local save picker needs.

## Tray rotation design

### Remove the thumbnail overlay

Delete the per-piece Rotate `<button>` from `PuzzlePiece.svelte` and delete its click/propagation helpers.

Keep `onRotate?: (pieceId: number) => void` because the piece root still uses it for `R`.

The root continues to expose:

- `aria-keyshortcuts="R"` when rotation is enabled and the piece is unplaced;
- `Puzzle piece N, upright` or `Puzzle piece N, rotated X degrees`;
- the existing rotated visual transform.

`PuzzleInventoryPanel` no longer needs the child-button special case in its native arrow handler. Roving focus returns to one active piece root rather than an active root plus an overlaid Rotate leaf.

### Add selected-piece header ROTATE

When:

```text
rotationEnabled === true
selectedPieceId !== null
```

render one inventory header action:

```text
ROTATE
aria-label="Rotate selected piece"
```

Clicking it calls:

```ts
onRotate(selectedPieceId)
```

`selectedPieceId !== null` is sufficient. The session already refuses selecting placed pieces and clears invalid selection through its normal transitions; the panel must not duplicate that domain rule.

The action stays visible while the inventory drawer is collapsed, like `CANCEL`.

Do not move this action into `PuzzleToolbar`: that toolbar’s ROTATE toggles rotation mode, while this header action rotates the currently selected piece.

## Rotation test migration

Removing the overlay changes the interaction contract, not just the accessible name. The puzzle-route suite currently rotates pieces without selecting them in multiple tests, including rotation/history, timer start, non-upright rejection, and live-announcement cases.

Those tests must be retargeted in the same implementation task:

- pointer/touch path: select the intended piece, then click `Rotate selected piece`;
- when a test already has the intended piece selected, click the header action directly;
- remove any now-redundant later `selectPiece(id)` call that would toggle the already-selected piece off;
- add one route assertion that the header Rotate action is absent before selection and appears after selection;
- add one route-level `R` test proving a focused piece rotates without the overlay/header path.

Component tests remain useful, but they are not sufficient because the route tests exercise timer start, history, rejection, and announcer behavior through the old button.

## Mount-time save visibility probe

### Why key existence alone is insufficient

A completed session remains persisted. `checkpointSession()` serializes any non-disposed session, including completed state, and the existing gallery projection intentionally keeps completed snapshots stored while excluding them from resumable progress.

Therefore this condition is wrong:

```text
puzzle-progress-* key exists ⇒ show saved-progress affordance
```

### Candidate probe contract

Add one exported persistence helper:

```ts
export function listResumableSessionCandidateIds(storage?: Storage): string[]
```

Internally, persistence keeps a private key-enumeration helper beside `PROGRESS_KEY_PREFIX`. For each owned key:

1. strip the non-empty puzzle ID suffix;
2. `getItem()` the raw value;
3. `JSON.parse()` it; parse failure is skipped;
4. require an object;
5. require `schemaVersion === CURRENT_SESSION_SCHEMA_VERSION`;
6. require parsed `puzzleId` to equal the key suffix;
7. apply the same resumability state predicate as `isResumable()`:
   - lifecycle is `active` or `paused`;
   - `sealedCompletion === null`;
   - `hasUserActivity === true`.

The shared state predicate should be factored once so `isResumable()` and the candidate probe cannot drift.

This probe deliberately does **not** validate grid geometry, tray order, rotations, counters, or result-class consistency. Those checks require the authoritative puzzle context and remain lazy in `peekSession()`.

Storage/parse failures produce no candidate and never remove data.

### Gallery visibility

On gallery mount, run exactly once:

```ts
quickPuzzles = listQuick();
savedProgressCandidateIds = listResumableSessionCandidateIds();
```

Search, category changes, and pagination must not rerun either mount-only enumeration.

Render the current-device section when either:

```text
localProgress.newest !== null
OR
savedProgressCandidateIds.length > 0
```

Inside the section:

- if `localProgress.newest` exists, keep its current name/progress/CONTINUE/DISCARD presentation unchanged;
- if no newest row exists but candidate IDs exist, show concise `SAVED PROGRESS AVAILABLE` copy instead of inventing a newest puzzle;
- show **VIEW SAVED PROGRESS** only when candidate IDs exist.

A completed-only or no-activity storage set yields zero candidate IDs, so the section does not appear.

## Full saved-progress discovery

Add:

```ts
export async function discoverAllSavedProgress(options: {
  puzzleIds: readonly string[];
  serverPuzzles: readonly PuzzleSummary[];
  quickPuzzles: readonly StoredQuickPuzzle[];
  fetchPuzzleById: (puzzleId: string) => Promise<Puzzle>;
  sessionStorage?: SessionStorageAdapter;
}): Promise<GalleryProgress[]>;
```

The input IDs are the mount-time candidate IDs. Full discovery still treats them as untrusted.

### Shared explicit-geometry validator

The original plan’s `fetchedServerCandidate()` did only shallow grid checks, while `quickValidationContext()` already validates each piece. That would create two validators that can drift.

Extract one nullable helper in `galleryProgress.ts`:

```ts
function explicitValidationContext(input: {
  puzzleId: string;
  source: PuzzleSourceType;
  pieceCount: number;
  gridCols: number;
  gridRows: number;
  pieces: readonly unknown[];
}): SessionValidationContext | null
```

It validates:

- non-empty puzzle ID and valid source;
- positive integer `pieceCount`, `gridCols`, and `gridRows`;
- `gridCols * gridRows === pieceCount`;
- `pieces.length === pieceCount`;
- each piece is an object;
- integer piece ID in `[0, pieceCount)`;
- unique piece IDs;
- integer `correctX` / `correctY` in bounds;
- unique canonical cells.

Then:

- `quickValidationContext()` keeps only Quick-specific guards such as the `q-` ID prefix, then delegates explicit geometry to this helper with `source: 'local'`;
- fetched server `Puzzle` detail delegates to the same helper with `source: 'api'`;
- summary-based `serverValidationContext()` remains row-major because summaries do not include canonical piece coordinates.

The helper returns `null` on malformed metadata. Picker discovery skips that row; it does not throw like the session construction invariant boundary.

### Candidate resolution

For each unique candidate ID:

1. `q-` ID: resolve only from the mount-time Quick metadata array. Missing/malformed Quick metadata is skipped; do not fetch it as a server puzzle.
2. Server ID already in loaded summaries: build the existing summary validation context with no request.
3. Server ID outside loaded summaries: call injected `fetchPuzzleById(id)`, require returned `puzzle.id === id`, then build the shared explicit context.
4. Call `sessionStorage.peekSession(id, context)`.
5. Include only `loaded` + `sessionStorage.isResumable(snapshot)`.
6. Project `GalleryProgress`.

Sort by:

1. `lastUpdated` descending;
2. `puzzleId` ascending for deterministic ties.

A deleted puzzle, failed detail request, malformed metadata, invalid session, or completed session is skipped without deletion.

## SavedProgressDialog

Create one concrete `SavedProgressDialog.svelte`:

```ts
interface Props {
  progress: readonly GalleryProgress[];
  loading: boolean;
  onClose: () => void;
}
```

Behavior:

- `role="dialog"`, `aria-modal="true"`, `aria-label="Saved progress"`;
- reuse `modalFocus`;
- Escape closes;
- visible Close button;
- loading state while authoritative discovery is running;
- `NO SAVED PROGRESS` if no rows survive full validation;
- otherwise one row per supplied item, showing name and `placedCount/pieceCount PLACED`;
- normal Continue link to `/puzzle/{puzzleId}`.

No discard/delete controls belong in this modal for HPA-647.

## Gallery orchestration

Route-local state only:

```ts
let savedProgressCandidateIds = $state<string[]>([]);
let savedProgressOpen = $state(false);
let savedProgressLoading = $state(false);
let savedProgressItems = $state<GalleryProgress[]>([]);
let savedProgressRequestId = 0;
```

Opening the picker:

1. open + set loading;
2. increment request ID;
3. call `discoverAllSavedProgress()` with candidate IDs, current loaded `puzzles`, mount-time `quickPuzzles`, `fetchPuzzle`, and the existing session adapter;
4. publish only if the request ID is still current.

Closing increments the request ID before hiding the modal so late results cannot mutate closed presentation state.

Recompute authoritative rows on every explicit open rather than adding cache invalidation.

After confirming the existing newest-session Discard action, recompute both:

- `localProgress` with `discoverGalleryProgress()`; and
- `savedProgressCandidateIds` with the mount-probe helper,

so the picker affordance reflects the cleared key.

The main page is inert when either the discard confirmation or saved-progress modal is open.

## Testing strategy

### Persistence

Cover the geometry-free candidate probe:

- active/paused + activity + no seal is included;
- completed is excluded even though the key remains;
- no-activity is excluded;
- sealed is excluded;
- malformed JSON, old schema, mismatched key/puzzle ID, empty suffix, and unrelated keys are excluded;
- storage enumeration/read failure returns no candidate and never mutates storage.

### Saved-progress service

Cover:

- loaded summary, fetched server detail, and Quick candidates in one result;
- loaded server summary avoids detail fetch;
- off-page server save is fetched and included;
- missing Quick metadata is skipped without server fetch;
- failed/deleted server detail is skipped;
- completed/invalid session is skipped without deletion;
- malformed fetched piece IDs/cells/bounds are rejected by the shared explicit validator;
- Quick and fetched detail use that same explicit validator;
- newest-first ordering plus deterministic tie order.

### Rotation components and route

Cover:

- `PuzzlePiece` never renders the old Rotate overlay when rotation is enabled;
- `R` still calls `onRotate` and orientation naming remains correct;
- inventory header Rotate appears only when rotation is enabled and a piece is selected;
- it calls `onRotate(selectedPieceId)` and remains visible while collapsed;
- inventory roving tests no longer expect child Rotate buttons;
- migrate every `Rotate piece N` caller in `routes/puzzle/[id]/page.svelte.test.ts` to the new selected-piece pointer path where appropriate;
- route test proves header Rotate is absent until selection;
- route test proves focused-piece `R` rotation still works without the overlay.

### Gallery page

Cover:

- `listQuick()` and candidate probe each run once per mount;
- search/filter/pagination do not rerun them;
- completed-only/no-activity candidate probe produces no current-device section;
- off-page maybe-resumable candidate with `localProgress.newest === null` still shows **VIEW SAVED PROGRESS**;
- no missing puzzle-detail fetch occurs before opening;
- picker open/load/close and inert behavior;
- stale async results are ignored after close;
- newest Continue/Discard remains unchanged;
- discard recomputes both current projection and candidate IDs.

### E2E

Extend `e2e/gallery.spec.ts` with two deterministic valid saved sessions:

- newest fixture included in the gallery summary response;
- older server fixture omitted from that response.

Assert:

1. newest Continue is immediately visible;
2. **VIEW SAVED PROGRESS** opens the modal;
3. both rows appear;
4. choosing the older row navigates to that puzzle route.

The fixture router already supplies off-page puzzle detail, so this proves the picker is independent of gallery pagination/filter state without a real backend request.

## Risks and controls

1. **Overlay callers outside component tests.** The route suite directly drives `Rotate piece N`; removing the overlay without migrating it causes immediate test failures and hides selection-state changes. Control: include `routes/puzzle/[id]/page.svelte.test.ts` in the rotation task and final focused suite.
2. **Completed keys mistaken for resumable saves.** Completion remains persisted, so key existence is not a valid UI signal. Control: geometry-free current-schema resumability candidate probe at mount; full validation stays lazy.
3. **Deleted or malformed off-page server puzzles.** Lazy `fetchPuzzle(id)` can 404 or return malformed typed-cast data. Control: shared explicit piece validator, per-candidate skip, `peekSession()` only, never passive deletion.

## Files expected to change

Production:

- `apps/web/src/lib/services/gameplay/session/persistence.ts`
- `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- `apps/web/src/lib/components/PuzzlePiece.svelte`
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- `apps/web/src/lib/components/SavedProgressDialog.svelte`
- `apps/web/src/routes/+page.svelte`

Tests:

- `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts`
- `apps/web/src/routes/page.svelte.test.ts`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/e2e/gallery.spec.ts`

No API, database, shared-type, session-engine, package, or migration file is required.
