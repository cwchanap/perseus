# HPA-647: Tray Rotation and Saved Progress Picker — Design

**Linear:** HPA-647  
**Status:** Design for implementation  
**Date:** 2026-08-19

## Context

Two pieces of direct gameplay feedback point at presentation seams that already exist in Perseus:

1. the tray renders a Rotate button directly over every unplaced puzzle piece when rotation is enabled, which obscures small piece artwork; and
2. the gallery exposes only one prominent **Continue on this device** entry, so a player cannot intentionally resume an older current-device session.

Current `main` already owns the underlying behavior needed for both changes:

- `PuzzlePiece.svelte` owns per-piece selection, the `R` keyboard rotation shortcut, orientation presentation, and the overlaid Rotate button;
- `PuzzleInventoryPanel.svelte` already receives `selectedPieceId`, `rotationEnabled`, and the existing `onRotate(pieceId)` callback, and already has a small header action row;
- `PuzzleSession` owns rotation state and scoring eligibility; no new gameplay action is required;
- `+page.svelte` already mounts Quick Puzzle metadata once, projects current gallery progress through `discoverGalleryProgress()`, and renders **Continue on this device**;
- the persistence module already owns the `puzzle-progress-` key namespace and the read-only `peekSession()` validation path;
- `fetchPuzzle(id)` already resolves canonical server puzzle detail;
- `modalFocus` and `DiscardSessionDialog.svelte` establish the local modal pattern.

The feature is therefore a small UI and discovery extension, not a new save system.

## Goals

1. Remove the visual Rotate affordance from inside tray piece thumbnails.
2. Preserve pointer/touch rotation through one selected-piece action in the inventory header.
3. Preserve `R` rotation and orientation accessibility on the focused puzzle piece.
4. Keep the current newest-session Continue banner as the fast gallery path.
5. Add one modal that can list every valid resumable session in the app-owned current-device save namespace, even when a saved server puzzle is outside the gallery's currently loaded page or active filter.
6. Load the full save catalog only when the player asks for it.
7. Reuse the current session codec and authoritative puzzle metadata validation without deleting invalid data during passive discovery.
8. Cover the behavior with focused unit/component/page tests plus one gallery E2E flow.

## Non-goals

- A persistence schema change or migration.
- Multiple named save slots for one puzzle.
- Cloud or cross-device synchronization.
- A retained save index or global progress store.
- A new server batch endpoint.
- Rename, delete, search, filter, sort controls, pagination, thumbnails, or other save-management UI inside the picker.
- A new saved-progress route.
- A generic modal, list, or command framework.
- Changes to rotation scoring, result classes, session actions, or session state.
- Backward compatibility for pre-release session formats.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Rotate one piece | `PuzzlePiece.onRotate` → route → `rotate_piece` | Reuse unchanged |
| Keyboard rotation | `PuzzlePiece` native `R` handler | Keep unchanged |
| Selected-piece action area | `PuzzleInventoryPanel.panel-actions` | Add one concrete `ROTATE` button |
| Rotation state/scoring | `PuzzleSession` | No domain changes |
| Immediate Continue | `discoverGalleryProgress().newest` | Keep current cheap projection |
| Save-key ownership | `PROGRESS_KEY_PREFIX = 'puzzle-progress-'` in persistence | Add one exported key-enumeration helper beside it |
| Read-only validation | `SessionStorageAdapter.peekSession()` + `isResumable()` | Reuse unchanged |
| Quick metadata | mount-time `listQuick()` | Reuse the same array for full discovery |
| Loaded server metadata | current gallery `PuzzleSummary[]` | Reuse without a detail request |
| Missing server metadata | `fetchPuzzle(id)` | Resolve lazily only when picker opens |
| Dialog focus | `$lib/actions/modalFocus` | One concrete `SavedProgressDialog.svelte` |
| Navigation | existing `/puzzle/[id]` route | Picker rows link directly to it |

## Options considered

### Option A — Lazy app-owned save enumeration + existing metadata resolvers (selected)

Keep the current homepage projection unchanged. When **VIEW SAVED PROGRESS** is opened, enumerate only keys beginning with `puzzle-progress-`, resolve metadata from existing Quick/gallery data first, fetch missing server puzzle detail by ID, validate with the current codec, sort valid resumable rows newest-first, and render them in one modal.

**Pros**

- actually satisfies “all saved progress” rather than mirroring gallery pagination;
- no new persistent index to maintain or migrate;
- no new API endpoint;
- no normal-gallery network penalty;
- validation remains authoritative and read-only.

**Cons**

- opening the picker may issue one detail request per saved server puzzle that is not already represented by loaded gallery summaries.

For a local hobby-game save list, that tradeoff is simpler and cheaper than maintaining another catalog. A batch endpoint can be added only if real save counts make it necessary.

### Option B — Extend HPA-218's current candidate list only

**Rejected:** `discoverGalleryProgress()` intentionally knows only currently loaded server summaries plus mount-time Quick metadata. A modal built only from those candidates would silently omit older server saves hidden by pagination, search, or category filtering, contradicting the requested UX.

### Option C — Persist a save index alongside sessions

**Rejected:** this introduces another schema, synchronization rules on every save/clear, recovery behavior for index drift, and migration/reset questions just to make a small local picker faster. Current `Storage` already exposes the app-owned keys.

### Option D — Add a server batch lookup endpoint

**Rejected:** the picker is local-session UX. The existing `fetchPuzzle(id)` endpoint is sufficient for the expected small number of saves, and lazy loading prevents cost on users who never open the picker.

## Tray rotation design

### Remove the thumbnail overlay

Delete the Rotate `<button>` from `PuzzlePiece.svelte` together with its click/propagation helpers. Keep the existing `onRotate` prop because the piece root still uses it for the `R` shortcut.

The root continues to expose:

- `aria-keyshortcuts="R"` when the piece is rotatable;
- `Puzzle piece N, upright` or `Puzzle piece N, rotated X degrees` as its accessible name;
- the current visual rotation transform.

HPA-223's inventory roving focus becomes simpler: only the active piece root is a repeated sequential tab stop. The special-case branch that detects `[data-testid="rotate-piece-button"]` is removed because the child button no longer exists.

### Selected-piece header action

`PuzzleInventoryPanel.svelte` already owns the selected piece ID and the panel header action row. When both conditions are true:

```text
rotationEnabled === true
selectedPieceId !== null
```

render one header button:

```text
ROTATE
```

with accessible name `Rotate selected piece`. Clicking it calls `onRotate(selectedPieceId)`.

The button remains available while the drawer body is collapsed, matching the existing `CANCEL` behavior and ensuring a selected mobile piece can still be rotated without reopening the tray body.

Do not auto-select a piece when Rotate is pressed. Do not move per-piece rotation into `PuzzleToolbar`; that toolbar action controls rotation mode, not the currently selected piece.

## Saved-progress discovery design

### Keep the fast path fast

Gallery mount remains unchanged:

1. call `listQuick()` once;
2. fetch gallery summaries as today;
3. call synchronous `discoverGalleryProgress()` for visible card progress and the existing newest Continue banner.

Do not enumerate the full storage namespace or fetch missing server puzzle details during normal mount, search, category filtering, or pagination.

### Enumerate only Perseus session keys

Add a small exported helper beside the persistence key function:

```ts
export function listPersistedSessionPuzzleIds(storage?: Storage): string[]
```

It uses the same default storage selection as the session adapter, iterates `storage.length` / `storage.key(index)`, accepts only keys with the exact `puzzle-progress-` prefix, strips the prefix, ignores an empty suffix, and returns unique puzzle IDs. Unrelated localStorage data is never interpreted as a session.

The helper returns an empty list if storage enumeration is unavailable. It does not parse, validate, mutate, or remove records; those responsibilities stay in the existing codec/adapter.

Keep `SessionStorageAdapter` unchanged so its existing production consumers and test doubles do not gain another required method.

### Resolve and validate all candidates lazily

Add one async discovery function in `galleryProgress.ts`:

```ts
export async function discoverAllSavedProgress(options: {
  puzzleIds: readonly string[];
  serverPuzzles: readonly PuzzleSummary[];
  quickPuzzles: readonly StoredQuickPuzzle[];
  fetchPuzzleById: (puzzleId: string) => Promise<Puzzle>;
  sessionStorage?: SessionStorageAdapter;
}): Promise<GalleryProgress[]>;
```

The function reuses the existing internal validation helpers rather than reimplementing the persisted session schema.

For each unique `puzzleId`:

1. If the ID is a Quick Puzzle ID, look it up in the already-mounted `quickPuzzles` array. If metadata is absent or malformed, skip it.
2. Otherwise, first look for a ready matching server summary in `serverPuzzles`. If present, use the existing summary-to-validation-context path with no request.
3. If the server puzzle is not currently loaded, call `fetchPuzzleById(puzzleId)` and build a validation context from its canonical `gridCols`, `gridRows`, `pieceCount`, and `pieces`.
4. Call `sessionStorage.peekSession(puzzleId, context)`.
5. Keep the row only when the result is `loaded` and `sessionStorage.isResumable(snapshot)` is true.
6. Project the existing `GalleryProgress` shape.

A metadata request failure skips only that server save. Passive picker discovery never calls `loadSession()` or `clearSession()`, so malformed, stale, unsupported, deleted-puzzle, or temporarily unresolved saves are not destroyed.

The result is sorted by:

1. `lastUpdated` descending;
2. `puzzleId` ascending as a deterministic tie-breaker for tests and stable rendering.

The function returns a plain array; no retained catalog or cross-route cache is introduced.

### Why full fetched puzzles use canonical geometry

`PuzzleSummary` does not contain full piece coordinates, so the current gallery projection derives row-major coordinates from `pieceCount` and `aspectRatio`. A missing saved server puzzle resolved with `fetchPuzzle(id)` already provides `gridCols`, `gridRows`, and canonical pieces. Full-history validation should use those authoritative fields directly instead of reconstructing them again.

## Saved-progress dialog

Create one `SavedProgressDialog.svelte` with props:

```ts
interface Props {
  progress: readonly GalleryProgress[];
  loading: boolean;
  onClose: () => void;
}
```

Behavior:

- fixed modal surface with `role="dialog"`, `aria-modal="true"`, `aria-label="Saved progress"`;
- reuse `modalFocus`;
- Escape invokes `onClose`;
- visible Close button;
- while `loading`, show a concise loading state;
- when loaded with zero rows, show `NO SAVED PROGRESS`;
- otherwise render every row in the order supplied;
- row content is puzzle name plus `{placedCount}/{pieceCount} PLACED`;
- each row has a direct Continue link to `resolve('/puzzle/{puzzleId}')`.

Do not put discard controls in this modal. The existing newest-session Discard flow remains the only home-page deletion affordance for this ticket.

## Gallery orchestration

`+page.svelte` owns only route-local picker presentation state:

```ts
let savedProgressOpen = $state(false);
let savedProgressLoading = $state(false);
let savedProgressItems = $state<GalleryProgress[]>([]);
let savedProgressRequestId = 0;
```

Add **VIEW SAVED PROGRESS** beside the existing Continue/Discard actions whenever `localProgress.newest` exists. Opening it:

1. marks the modal open and loading;
2. increments the local request revision;
3. calls `listPersistedSessionPuzzleIds()`;
4. passes those IDs, the current `puzzles`, the mount-time `quickPuzzles`, `fetchPuzzle`, and the existing session adapter to `discoverAllSavedProgress()`;
5. publishes the result only if the request revision is still current.

Closing the dialog increments the revision so late async results cannot reopen or mutate a closed dialog's presentation state.

The main page becomes inert when either the discard confirmation or saved-progress dialog is open. Both dialogs remain siblings outside the inert subtree.

The full list is recomputed on each explicit open. That is intentionally simpler than adding cache invalidation for a catalog that is only used on demand and is expected to contain few rows.

## Accessibility

- Removing the tiny per-piece Rotate button does not remove keyboard rotation: focused pieces retain `R` and orientation naming.
- Pointer/touch rotation moves to a larger stable header control after selection.
- `SavedProgressDialog` follows the existing focus trap/restore pattern and has a named dialog surface.
- Continue rows are normal links, preserving native keyboard and browser navigation behavior.
- No new custom listbox semantics are needed; the dialog is a short list of links.

## Testing strategy

### Persistence/service

- key enumeration includes only non-empty `puzzle-progress-` IDs and ignores unrelated keys;
- existing `discoverGalleryProgress()` behavior remains unchanged;
- full discovery returns both loaded-summary and fetched-detail server saves plus Quick saves;
- a server save absent from current gallery summaries is fetched and included;
- already-loaded server summaries do not trigger detail requests;
- invalid/completed/unresumable records are excluded without deletion;
- missing Quick metadata and failed server metadata resolution are skipped;
- output is newest-first with deterministic tie ordering.

### Components

- `PuzzlePiece` never renders a Rotate overlay when rotation is enabled;
- `R` still calls `onRotate` and accessible orientation remains correct;
- inventory header Rotate appears only for a selected piece while rotation is enabled, calls `onRotate(selectedPieceId)`, and remains present when the drawer is collapsed;
- saved-progress dialog loading, empty, rows, links, Escape, and Close behavior are covered.

### Gallery page

- initial gallery rendering does not enumerate full saves or fetch missing puzzle detail;
- **VIEW SAVED PROGRESS** opens an inert modal and starts full discovery;
- returned rows are passed to the dialog;
- closing the dialog restores the main page;
- existing newest Continue and Discard behavior remains intact.

### E2E

Extend `e2e/gallery.spec.ts` with two deterministic persisted sessions:

- newest: a fixture included in the gallery summary response;
- older: a different server fixture omitted from that initial summary response.

Assert the existing banner still offers the newest session immediately, open **VIEW SAVED PROGRESS**, confirm both rows appear, select the older row, and verify navigation to its existing puzzle route. This proves the picker is not bounded by gallery pagination/filter state.

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
- `apps/web/e2e/gallery.spec.ts`

No API, database, shared types, `PuzzleSession`, or persisted schema files need to change.