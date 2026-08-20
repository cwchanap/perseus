# HPA-647: Tray Rotation and Saved Progress Picker — Design

**Linear:** HPA-647  
**Status:** Design for implementation  
**Date:** 2026-08-19

## Context

Two pieces of direct gameplay feedback point at presentation seams that already exist in Perseus:

1. the tray renders a Rotate button directly over every unplaced puzzle piece when rotation is enabled, which obscures small piece artwork; and
2. the gallery exposes one prominent **Continue on this device** entry, so a player cannot intentionally resume an older current-device session.

Current `main` already owns the behavior needed for both changes:

- `PuzzlePiece.svelte` owns selection, focused-piece `R` rotation, orientation presentation, and the overlaid Rotate button;
- `PuzzleInventoryPanel.svelte` already receives `selectedPieceId`, `rotationEnabled`, and `onRotate(pieceId)`, and already has a small header action row;
- `PuzzleSession` owns rotation state/history/scoring; no new gameplay action is required;
- `+page.svelte` mounts Quick Puzzle metadata once, projects gallery progress with `discoverGalleryProgress()`, and renders **Continue on this device**;
- persistence owns the private `puzzle-progress-` namespace plus read-only `peekSession()` and `isResumable()`;
- `fetchPuzzle(id)` resolves canonical server puzzle detail;
- `modalFocus` and `DiscardSessionDialog.svelte` establish the local modal pattern.

This is a UI/discovery extension, not a new save system.

## Goals

1. Remove the visual Rotate affordance from inside tray piece thumbnails.
2. Keep pointer/touch rotation discoverable through one inventory-header action.
3. Preserve focused-piece `R` rotation and orientation accessibility.
4. Keep the latest Continue row stable while search/category filtering changes the visible gallery cards.
5. Add one picker that can resume older valid current-device saves, including server puzzles outside the currently loaded gallery results.
6. Avoid a false saved-progress affordance for completed/no-activity/malformed local records.
7. Load authoritative puzzle metadata and perform full session validation only after the player opens the picker.
8. Never passively delete invalid or unavailable progress during discovery.
9. Keep the work inside one HPA-647 PR with focused tests and one additional gallery E2E flow.

## Non-goals

- Persistence schema changes or migrations.
- Multiple named save slots for one puzzle.
- Cloud/cross-device synchronization.
- A retained save index or global progress store.
- A new server batch endpoint.
- Rename/delete/search/filter/pagination inside the saved-progress dialog.
- A saved-progress route.
- A generic modal/list/action framework.
- Rotation-domain, result-class, scoring, or session-history changes.
- Backward compatibility for pre-release session formats.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Rotate one piece | `PuzzlePiece.onRotate` → route → `rotate_piece` | Reuse unchanged |
| Keyboard rotation | `PuzzlePiece` native `R` handler | Keep unchanged |
| Pointer/touch rotate affordance | `PuzzleInventoryPanel.panel-actions` | Add one concrete header `ROTATE` button |
| Rotation state/scoring | `PuzzleSession` | No domain changes |
| Visible-card progress | `discoverGalleryProgress().byPuzzleId` | Keep query-coupled |
| Latest Continue row | `discoverGalleryProgress().newest` | Retain route-local latest value across search/filter changes |
| Save namespace | private `PROGRESS_KEY_PREFIX` in persistence | Add free-function candidate enumeration beside it |
| Resumable predicate | `isResumable()` | Factor the lifecycle/seal/activity predicate once and reuse it in the mount probe |
| Read-only authoritative validation | `peekSession()` | Reuse unchanged |
| Quick metadata | mount-time `listQuick()` | Reuse same array |
| Loaded server metadata | current `PuzzleSummary[]` | Reuse without detail request |
| Off-page server metadata | `fetchPuzzle(id)` | Resolve lazily after picker open |
| Explicit piece validation | `quickValidationContext()` already checks IDs/cells/bounds | Extract one nullable helper for Quick + fetched detail |
| Dialog focus | `$lib/actions/modalFocus` | One concrete `SavedProgressDialog.svelte` |
| Navigation | existing `/puzzle/[id]` route | Direct links |
| Rotation integration tests | `routes/puzzle/[id]/page.svelte.test.ts` | Migrate old `Rotate piece N` callers in same task |
| Gallery E2E | current newest-session test | Keep intact; add a separate off-page picker test |

## Options considered

### Option A — Cheap local candidate probe + lazy authoritative discovery (selected)

At gallery mount, inspect only Perseus-owned session keys and parse enough current-schema state to decide whether a record is plausibly resumable. Keep the current gallery projection for visible-card badges and latest Continue. When the player opens **VIEW SAVED PROGRESS**, resolve missing metadata, validate full geometry/session state with existing seams, and render the authoritative list.

**Pros**

- picker works outside current gallery pagination/filter state;
- completed-only leftovers do not create a false entry point;
- no save index or batch endpoint;
- no missing-puzzle network work during normal gallery startup;
- authoritative validation remains read-only and lazy.

**Cons**

- picker open may issue one detail request per off-page server save;
- the mount probe is intentionally only a candidate test, so full validation can still eliminate every candidate.

If full discovery returns zero actionable rows, the route clears the in-memory candidate IDs for the rest of that page lifetime so the player is not stranded on a permanent empty-picker affordance. Reloading re-probes storage, which is sufficient for this pre-release hobby project and avoids adding retry/error/catalog state.

### Option B — Current HPA-218 metadata candidates only

**Rejected:** it silently omits older server saves hidden by pagination/search/category state.

### Option C — Persist a save index

**Rejected:** it adds another schema plus synchronization/recovery work on every save and clear.

### Option D — Add a server batch metadata endpoint

**Rejected:** expected save counts are small and detail fetches are lazy. Add a batch endpoint only if measured usage justifies it.

## Tray rotation design

### Remove the thumbnail overlay

Delete the Rotate `<button>` and its click/propagation helpers from `PuzzlePiece.svelte`. Keep the existing `onRotate` prop because the root `R` handler still needs it.

The root continues to expose:

- `aria-keyshortcuts="R"` when rotatable;
- `Puzzle piece N, upright` / `Puzzle piece N, rotated X degrees`;
- the current rotation transform.

Inventory roving focus becomes simpler because there is no per-piece Rotate child control.

### Keep pointer/touch rotation visible

When `rotationEnabled` is true, always render one inventory-header action:

```text
ROTATE
```

with accessible name:

```text
Rotate selected piece
```

The button is disabled while `selectedPieceId === null` and enabled after selection. This makes enabling rotation mode visibly change the tray UI instead of making pointer/touch rotation look broken.

Use an explicit handler so mutable Svelte state is narrowed at call time:

```ts
function rotateSelectedPiece(): void {
  const pieceId = selectedPieceId;
  if (pieceId !== null) onRotate(pieceId);
}
```

The button remains visible while the drawer body is collapsed. Do not auto-select a piece and do not move per-piece rotation into `PuzzleToolbar`; toolbar `ROTATE` still means rotation mode.

### Route-test migration is part of the feature

`routes/puzzle/[id]/page.svelte.test.ts` directly clicks `Rotate piece N` across rotation/history/timer/rejection/announcer cases. Removing the overlay changes those callers semantically because pointer rotation now requires selection.

Migrate those tests in the same task:

- select the target piece before header rotation when needed;
- avoid a later `selectPiece(id)` if the new pointer path already left it selected;
- keep at least one route test proving header ROTATE is visible-but-disabled before selection;
- keep one route test proving focused-piece `R` rotates without selecting the piece.

## Local saved-progress candidate probe

### Key existence is not progress

Completed sessions remain stored, so this is intentionally invalid:

```text
puzzle-progress-* key exists ⇒ saved progress available
```

Add one free function in persistence:

```ts
export function listResumableSessionCandidateIds(storage?: Storage): string[]
```

Keep `SessionStorageAdapter` unchanged.

For each exact `puzzle-progress-` key:

1. require a non-empty key suffix;
2. read the raw value;
3. `JSON.parse()`; failures are skipped;
4. require an object;
5. require `schemaVersion === CURRENT_SESSION_SCHEMA_VERSION`;
6. require parsed `puzzleId` to equal the key suffix;
7. apply the same lifecycle/seal/activity predicate used by `isResumable()`:
   - lifecycle is `active` or `paused`;
   - `sealedCompletion === null`;
   - `hasUserActivity === true`.

Factor that predicate once as an internal helper so `isResumable()` and the candidate probe cannot drift.

The probe does **not** validate geometry, rotations, tray order, counters, result class, or puzzle existence. It performs no network work and never removes storage.

Run `listQuick()` and this candidate probe once on gallery mount. Search/filter/pagination must not rerun them.

## Separate latest Continue from visible-card progress

`discoverGalleryProgress()` currently returns both `byPuzzleId` and `newest`, and the gallery recomputes both whenever the visible `puzzles` query changes. That means search/category changes can erase the primary Continue row even though the underlying local session did not change.

Split route presentation ownership without changing the service return type:

```ts
let cardProgressByPuzzleId = $state<ReadonlyMap<string, GalleryProgress>>(new Map());
let latestProgress = $state<GalleryProgress | null>(null);
```

Whenever gallery candidates are projected:

1. always replace `cardProgressByPuzzleId` with the current `byPuzzleId` so card badges follow the active query;
2. if `discovery.newest` exists and is newer than `latestProgress`, retain it as the route-local latest row;
3. never replace a known `latestProgress` with `null` merely because search/filter hides that puzzle.

This lets pagination or another result set improve the latest row if it discovers a genuinely newer save while preventing search from degrading the primary affordance.

After the user explicitly discards `latestProgress`, clear it and recompute from the currently available gallery/Quick candidates plus refresh the mount probe. The existing Discard semantics otherwise remain unchanged.

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

The candidate IDs remain untrusted.

### One explicit piece-context helper

Extract one nullable helper used by Quick metadata and fetched server detail:

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

Validate:

- non-empty `puzzleId`;
- positive integer `pieceCount`, `gridCols`, `gridRows`;
- `gridCols * gridRows === pieceCount`;
- `pieces.length === pieceCount`;
- every piece is an object;
- integer piece IDs in `[0, pieceCount)`;
- unique piece IDs;
- integer in-bounds `correctX` / `correctY`;
- unique canonical cells.

Do **not** add a runtime source check here: `source` is a typed literal supplied by the two internal callers, not untrusted metadata.

Then:

- `quickValidationContext()` keeps Quick-specific checks such as the `q-` prefix and delegates geometry with `source: 'local'`;
- fetched server detail delegates geometry with `source: 'api'`;
- summary-based `serverValidationContext()` stays row-major because summaries lack canonical piece coordinates.

A fetched server `Puzzle` has no `status` field. No extra readiness gate is needed: the existing server detail endpoint returns 404 for non-ready/deleted puzzles, so `fetchPuzzle(id)` rejects and discovery skips that candidate.

### Candidate resolution

For each unique candidate ID:

1. Quick ID: resolve only from mount-time `quickPuzzles`; missing/malformed metadata is skipped and is never fetched as server data.
2. Server ID already present in loaded summaries: reuse `serverValidationContext()` with no detail request.
3. Off-page server ID: call injected `fetchPuzzleById(id)`, require returned `puzzle.id === id`, then use `explicitValidationContext()`.
4. Call `sessionStorage.peekSession(id, context)`.
5. Keep only `loaded` + `sessionStorage.isResumable(snapshot)`.
6. Project `GalleryProgress`.

Sort by `lastUpdated` descending, then `puzzleId` ascending for deterministic ties.

A failed/deleted detail request, malformed metadata, invalid session, or completed session is skipped without deletion.

## SavedProgressDialog

Create one concrete `SavedProgressDialog.svelte` with:

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
- loading state while discovery runs;
- `NO SAVED PROGRESS` if zero rows survive;
- rows rendered as a semantic `<ul>` / `<li>` list;
- each row shows puzzle name plus `{placedCount}/{pieceCount} PLACED`;
- each link has visible `CONTINUE` text and `aria-label="Continue {item.name}"` so repeated actions remain distinguishable;
- outer overlay uses the same `env(safe-area-inset-*)` padding pattern as `DiscardSessionDialog` so the modal does not clip on notched phones.

No discard/delete controls belong in this modal.

## Gallery orchestration

Route-local picker state:

```ts
let savedProgressCandidateIds = $state<string[]>([]);
let savedProgressOpen = $state(false);
let savedProgressLoading = $state(false);
let savedProgressItems = $state<GalleryProgress[]>([]);
let savedProgressRequestId = 0;
```

Render the current-device section when either `latestProgress` exists or candidate IDs exist.

Inside it:

- if `latestProgress` exists, keep the current name/progress/CONTINUE/DISCARD row;
- if no latest row exists but candidates exist, show concise `SAVED PROGRESS AVAILABLE` copy;
- show **VIEW SAVED PROGRESS** whenever candidate IDs exist.

Opening the picker:

1. open + set loading;
2. increment request ID;
3. call `discoverAllSavedProgress()` with candidate IDs, current loaded summaries, mount-time Quick metadata, `fetchPuzzle`, and the existing session adapter;
4. publish only if the request ID is still current;
5. if the published result is empty, clear `savedProgressCandidateIds` for this page lifetime so the proven-empty picker affordance disappears.

Closing increments the request ID before hiding the modal so stale async results cannot publish into a closed dialog.

Recompute authoritative rows on every explicit open; do not add cache invalidation.

The main page is inert while either the discard confirmation or saved-progress modal is open.

## Testing strategy

### Persistence

Cover candidate probing:

- active/paused + activity + no seal included;
- completed, sealed, and no-activity excluded;
- malformed JSON, old schema, key/puzzle-ID mismatch, empty suffix, unrelated keys excluded;
- storage enumeration/read failure yields no candidate without mutation.

### Saved-progress service

Cover:

- loaded summary, fetched server detail, and Quick save together;
- loaded server summary avoids fetch;
- off-page server save fetches and appears;
- missing Quick metadata does not trigger server fetch;
- failed/deleted server detail is skipped;
- completed/invalid session skipped without deletion;
- malformed fetched/Quick IDs/cells/bounds rejected through the same explicit validator;
- newest-first ordering plus deterministic tie order.

### Rotation

Cover:

- no thumbnail Rotate overlay;
- `R` still rotates and orientation naming remains correct;
- header ROTATE is visible whenever rotation mode is enabled;
- header ROTATE is disabled before selection and enabled after selection;
- it calls `onRotate(selectedPieceId)` and stays visible while drawer body is collapsed;
- roving tests no longer expect child Rotate buttons;
- every old `Rotate piece N` route caller is migrated;
- route-level focused-piece `R` test remains selection-independent.

### Gallery page

Cover:

- `listQuick()` + candidate probe once per mount;
- search/filter/pagination do not rerun them;
- search/filter do not erase the retained latest Continue row;
- visible-card badges still follow active gallery results;
- completed/no-activity storage does not expose current-device progress;
- off-page candidate can expose **VIEW SAVED PROGRESS** while `latestProgress` is null;
- no missing detail fetch before picker open;
- picker open/load/close + inert behavior uses async polling around Svelte DOM updates;
- authoritative empty result clears candidate IDs and removes the saved-progress section;
- stale async results are ignored after close;
- latest Continue/Discard remains unchanged;
- discard refreshes candidate visibility.

### E2E

Keep the existing `shows current-device progress and continues the newest session` test untouched so it continues to cover the latest row and card badge.

Add a separate test for the picker:

- seed newest `e2e-square-4` included in gallery summaries;
- seed older `e2e-landscape-12` omitted from gallery summaries;
- assert newest row remains immediately visible;
- open **VIEW SAVED PROGRESS**;
- assert both rows;
- click the older row by accessible name `Continue {older.name}`;
- verify navigation to `/puzzle/e2e-landscape-12`.

## Risks and controls

1. **Old Rotate callers go red.** Control: migrate `routes/puzzle/[id]/page.svelte.test.ts` in Task 3 and run it immediately.
2. **Pointer rotation becomes visually undiscoverable.** Control: render disabled header ROTATE whenever rotation mode is on.
3. **Completed/no-activity keys look resumable.** Control: geometry-free current-schema candidate probe.
4. **Candidate probe survives but full validation finds nothing.** Control: clear in-memory candidate IDs after authoritative empty discovery; no in-modal delete needed.
5. **Search/filter erases the primary Continue row.** Control: separate retained `latestProgress` from query-coupled card map.
6. **Deleted/malformed off-page puzzle metadata.** Control: shared explicit validator + per-candidate skip + `peekSession()` only.
7. **Repeated anonymous Continue links / notch clipping.** Control: per-row accessible names, semantic list, safe-area overlay padding.

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

No API, database, shared-type, session-engine, package, or migration file should change.