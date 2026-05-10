# Quick Puzzle — Browser-Side Jigsaw Generation

**Status:** Design approved (2026-05-09)
**Scope:** New web feature — `/quick` upload page + minor changes to `/puzzle/[id]` to support a local data source.

## Goal

Let a visitor upload an image and immediately play it as a jigsaw puzzle, with the entire pipeline (decode → mask → render → store) staying in the browser. No server upload, no API calls, no account.

Quick puzzles persist in `localStorage` for **7 days** or **5 puzzles** (whichever comes first), evicted oldest-first by `createdAt`. They share the existing `/puzzle/[id]` gameplay page, including zoom, undo/redo, hints, rotation, timer, and reference overlay.

## Constraints

- `localStorage` only (no IndexedDB) — strict ~5 MB per-origin budget across all quick puzzles.
- No server-side storage of any kind — image bytes never leave the browser.
- Reuse the existing gameplay UI (`PuzzleBoard`, `PuzzlePiece`, `PuzzleToolbar`, etc.) without forking.
- No new WASM bundles — use Canvas 2D + `OffscreenCanvas`.
- Modern-browser-only (Chromium, Firefox, recent Safari). No graceful degradation beyond a "browser not supported" toast.

## Non-goals

- Sharing quick puzzles between devices or users.
- Persisting in-progress generation (a refresh mid-upload restarts).
- Listing quick puzzles in the existing server-side gallery.
- Telemetry or error reporting beyond `console.error`.

## Decisions log (from brainstorming)

| Decision                 | Choice                                                                                                           | Rationale                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Difficulty picker        | Numeric input, 4–100 pieces, default 24                                                                          | Matches existing admin flow; simple.                        |
| Storage shape            | Hybrid — store original image + piece metadata; render piece bitmaps on demand into in-memory blob URLs          | Smallest persistent footprint, fast play after first paint. |
| Storage backend          | `localStorage` (per user preference)                                                                             | Per request; trade-off accepted (image cap).                |
| Routing                  | New `/quick` page for upload + saved list; play happens on existing `/puzzle/[id]` via a local-first data source | Maximum reuse, no fork.                                     |
| Generation engine        | Canvas 2D + `OffscreenCanvas`, sharing `generateJigsawSvgMask` from a moved-to-shared module                     | No WASM, identical mask geometry to server.                 |
| Eviction at 5-puzzle cap | Silent oldest-first                                                                                              | Predictable, no friction.                                   |
| Expiry                   | 7 days from `createdAt`; auto-deleted silently on next read                                                      | Predictable, no surprise renewals.                          |
| Image upload             | Auto-downscale to 1200 px longest side, re-encode JPEG q80; reject non-`{jpeg,png,webp}`; reject > 20 MB         | Enforces budget; quick UX.                                  |
| Page layout              | Upload form + "My Quick Puzzles" list of saved local puzzles below                                               | Single surface for create + manage.                         |
| Naming                   | Auto-derive from filename                                                                                        | One-click upload.                                           |
| Save failure (quota)     | Don't persist; play in-memory for the session; toast user                                                        | Graceful degradation.                                       |
| Discoverability          | Header link in shared layout                                                                                     | Minimal scope.                                              |

## Architecture

### File layout

```
apps/web/src/
  routes/
    quick/
      +page.svelte                  # NEW: upload form + saved list
      +page.ts                      # NEW: prerender = true
    puzzle/[id]/
      +page.svelte                  # MODIFIED: load via puzzleSource (local-first)
  lib/
    services/
      quickPuzzle/
        index.ts                    # NEW: public facade — createQuick, openQuick + module-level in-memory blob-URL cache
        storage.ts                  # NEW: localStorage I/O — saveQuick, getQuick, listQuick, deleteQuick (eviction & expiry)
        generator.ts                # NEW: Canvas piece generation — generateQuickPuzzle
        types.ts                    # NEW: StoredQuickPuzzle, QuickPieceMeta, QuickPuzzleValidationError
      puzzleSource.ts               # NEW: source-agnostic loader (local first, then API)
    components/
      QuickPuzzleUploader.svelte    # NEW
      QuickPuzzleList.svelte        # NEW

packages/types/src/
  jigsaw-path.ts                    # MOVED from apps/workflows/src/utils/jigsaw-path.ts
  grid.ts                           # NEW: getGridDimensions + edge helpers (moved from apps/workflows/src/index.ts)
```

### Shared geometry move

The existing `apps/workflows/src/utils/jigsaw-path.ts` (`generateJigsawSvgMask`) and the four edge helpers (`getTopEdge`, `getRightEdge`, `getBottomEdge`, `getLeftEdge`) plus `getGridDimensions` from `apps/workflows/src/index.ts` are pure and isomorphic. They move to `packages/types/`. The workflow imports from there afterwards. No behavioural change for the workflow; existing tests stay green after the import path update.

### No changes to

- `apps/api` (any file)
- `apps/workflows/src/index.ts` aside from import path updates
- The existing API client, progress service, stats service
- Gameplay logic, stores, or component internals beyond the listed prop signature changes

## Data model

Two `localStorage` key shapes. Everything is JSON.

### Index key — `quickPuzzle:index`

```ts
type QuickPuzzleIndex = {
	ids: string[]; // newest first; max length 5
	schemaVersion: 1;
};
```

### Per-puzzle key — `quickPuzzle:<id>`

```ts
type StoredQuickPuzzle = {
	id: string; // 'q-' + crypto.randomUUID()
	name: string; // derived from filename, max 80 chars
	pieceCount: number;
	gridRows: number;
	gridCols: number;
	imageWidth: number; // post-downscale
	imageHeight: number;
	imageDataUrl: string; // JPEG, base64
	pieces: QuickPieceMeta[];
	createdAt: number; // epoch ms — used for ordering and 7-day expiry
	schemaVersion: 1;
};

type QuickPieceMeta = {
	id: number; // row * cols + col
	correctX: number; // col
	correctY: number; // row
	edges: EdgeConfig; // { top, right, bottom, left }
};
```

### ID format

`q-<uuid>` (e.g. `q-7a3e9f12-4b2d-4f4c-9b8a-…`). The `/puzzle/[id]` page uses the prefix as a hint to try the local source first, but the source abstraction works without it (still falls through to API on local miss).

### Budget math

At 1200 px longest side and JPEG q80, typical photos compress to ~300–500 KB raw → ~400–670 KB as base64. Pieces metadata is ~50 bytes × max 100 pieces ≈ 5 KB. Index is < 200 bytes. Five puzzles ≈ 2–3.5 MB total. Comfortable margin under the 5 MB limit.

## Generation pipeline

A single async function in `quickPuzzle/generator.ts`:

```ts
async function generateQuickPuzzle(
	file: File,
	pieceCount: number,
	name: string
): Promise<{
	stored: StoredQuickPuzzle;
	pieceBlobUrls: Map<number, string>;
}>;
```

Steps in order:

1. **Validate file.** MIME ∈ `{image/jpeg, image/png, image/webp}`; size ≤ 20 MB. Throw a typed `QuickPuzzleValidationError` otherwise.
2. **Decode → downscale.** `createImageBitmap(file)`. If `max(width, height) > 1200` → scale to fit on `OffscreenCanvas`. Export with `convertToBlob({ type: 'image/jpeg', quality: 0.8 })`. Read result as base64 data URL via `FileReader` → `imageDataUrl`.
3. **Compute grid.** Call shared `getGridDimensions(pieceCount)` → `{ rows, cols }`.
4. **Compute pieces metadata.** For each `(row, col)` up to `pieceCount`, build `EdgeConfig` via the shared edge helpers; push `QuickPieceMeta`. Stored in `StoredQuickPuzzle.pieces` so the saved puzzle is self-describing.
5. **Render piece bitmaps (in-memory only).** For each piece:
   - Compute extraction bounds: `baseWidth/Height + 2 × overlap` (overlap = `floor(base × TAB_RATIO)` with `TAB_RATIO = 0.20`), clamped to image bounds, with `offsetX/Y` for clamped pieces.
   - On a target-size `OffscreenCanvas`, `drawImage(...)` the source region at `(offsetX, offsetY)`.
   - Generate the SVG mask string via `generateJigsawSvgMask(edges, targetWidth, targetHeight)`.
   - Load the SVG as an `Image` element from a `data:image/svg+xml;base64,…` URL; await its `load`.
   - Composite onto the piece canvas with `globalCompositeOperation = 'destination-in'` to apply the alpha mask.
   - `convertToBlob({ type: 'image/png' })` → `URL.createObjectURL(blob)` → store in `pieceBlobUrls` keyed by piece ID.
6. **Persist via `saveQuick(stored)`.** Eviction logic in `storage.ts`. If quota exceeded, the function returns `{ persisted: false }`; the caller proceeds anyway.
7. **Return** `{ stored, pieceBlobUrls }`.

### Generation progress

Generation is sequential per piece. The `/quick` page shows a determinate progress bar (`X / N pieces`) driven by an optional `onProgress(done, total)` callback parameter. Budget: ~30 ms per piece on mid-range hardware; ~1.5 s for 50 pieces.

### In-memory piece cache

A module-level `Map<puzzleId, Map<pieceId, string>>` in `quickPuzzle/index.ts` holds blob URLs for the current session. The two public entry points that populate it:

- `createQuick(file, pieceCount, name)` — runs `generateQuickPuzzle` (generator.ts), then `saveQuick` (storage.ts), and seeds the cache with the freshly generated blob URLs. Returns `{ stored, persisted }`.
- `openQuick(id)` — used by `puzzleSource.load` for local IDs. Calls `getQuick(id)`, and if hit but the cache is empty for that ID, re-runs piece rendering (step 5 of the pipeline) from the stored `imageDataUrl` + metadata.

The cache is cleared per-ID when the play page calls `puzzleSource.cleanup()` in `onDestroy` (revokes URLs, drops the map entry).

## Routing & data flow

### `/quick` page

`routes/quick/+page.svelte` renders:

- `QuickPuzzleUploader.svelte` — file input, name field (auto-filled from filename, editable), piece-count number input (default 24, min 4, max 100), "Create Puzzle" button. Determinate progress bar during generation. On success, `goto('/puzzle/' + stored.id)`.
- `QuickPuzzleList.svelte` — calls `listQuick()` on mount, renders rows (thumbnail `<img src={imageDataUrl}>`, name, age via `Intl.RelativeTimeFormat`, piece count, delete button). Each row links to `/puzzle/<id>`.

Empty state copy: "Upload an image to create your first quick puzzle. Stays on your device for 7 days, max 5."

Toast on storage failure (returned by `saveQuick`): "Storage full — this puzzle will only last for this session."

`+page.ts` exports `prerender = true` (the page hydrates client-side from `localStorage` on mount).

### Header link

Add "Quick Puzzle" to the existing nav in the shared `+layout.svelte`. One element.

### `/puzzle/[id]` modifications

```
Page mount
  └── puzzleSource.load(id)
       ├── if (id starts with 'q-') try local first
       │    ├── getQuick(id) → if found, ensure piece blob URLs cached → return
       │    └── if not found → fall through to API
       └── else fetchPuzzle(id)
            └── return API result
```

`puzzleSource.load(id)` returns:

```ts
{
  puzzle: Puzzle;                                      // existing shape
  resolvePieceImage: (piece: PuzzlePiece) => string;   // blob URL or API URL
  resolveReferenceImage: () => string | null;          // data URL or API URL
  source: 'local' | 'api';
  cleanup: () => void;                                 // revoke blob URLs (no-op for API)
}
```

The play page calls `cleanup()` in `onDestroy`.

### Component prop changes (minimal)

- `PuzzleBoard.svelte` — receive a `resolvePieceImage` prop instead of importing `getPieceImageUrl` from `services/api`.
- `PuzzlePiece.svelte` — same.
- `ReferenceOverlay.svelte` — receive a `referenceImageUrl: string | null` prop instead of computing from puzzle ID.
- `routes/puzzle/[id]/+page.svelte` — call `puzzleSource.load(id)` instead of `fetchPuzzle(id)`; plumb resolvers down.

No other gameplay/store/progress changes. `lib/services/progress.ts` already keys by puzzle ID and works for `q-…` IDs unchanged.

## Lifecycle, eviction & expiry

All in `quickPuzzle/storage.ts`. Functions read and write the index and per-puzzle keys directly; no in-memory caching at this layer (the blob-URL cache lives in `index.ts`).

### `listQuick(): StoredQuickPuzzle[]`

1. Read `quickPuzzle:index`.
2. For each ID, read `quickPuzzle:<id>`. If missing or `schemaVersion` mismatched → drop from index.
3. Drop entries where `createdAt < now - 7 days`. Remove their per-puzzle keys.
4. Persist cleaned index back if anything changed.
5. Return surviving puzzles, newest first.

### `getQuick(id): StoredQuickPuzzle | null`

Single-ID variant of the same expiry + schema check. Returns `null` for expired or missing entries (and removes their per-puzzle key).

### `saveQuick(stored: StoredQuickPuzzle): { persisted: boolean }`

1. Run `listQuick` first (auto-prunes expired entries → frees budget).
2. While the surviving index has ≥ 5 entries, evict the oldest (delete per-puzzle key, drop from index).
3. `try { localStorage.setItem('quickPuzzle:' + id, JSON.stringify(stored)) }`.
4. On `QuotaExceededError`: do NOT retry, do NOT mutate the index, return `{ persisted: false }`.
5. On success: prepend `id` to the index (de-duped), trim to 5, persist index, return `{ persisted: true }`.

### `deleteQuick(id): void`

Remove per-puzzle key, drop from index, revoke any cached blob URLs for that ID, drop the in-memory map entry.

### Why `listQuick` owns pruning

`listQuick` is called on user-visible UI flows (saved list, pre-write eviction in `saveQuick`). Concentrating cleanup there means `getQuick` stays O(1) on the play-page hot path, and pruning is consistent with what the user can see. If they open the list, expired entries vanish; if they don't, they vanish on the next save.

### Cross-tab races

`localStorage` writes are synchronous and atomic per call, but multi-tab is theoretically a race on the index. Last-write-wins is acceptable; worst case is a stale index entry, cleaned up on the next read. We do not subscribe to the `storage` event.

### No "expired" UI

Pruning is silent. The user never sees an "expired" badge — entries simply disappear. Consistent with the auto-delete decision.

## Error handling & edge cases

### Upload validation (synchronous, before generation)

| Condition                 | Behaviour                                                      |
| ------------------------- | -------------------------------------------------------------- |
| Bad MIME                  | Inline form error: "Please choose a JPEG, PNG, or WebP image." |
| File > 20 MB              | Inline form error: "Image too large (max 20 MB)."              |
| Piece count outside 4–100 | Inline form error: "Choose between 4 and 100 pieces."          |

### Generation failures

| Condition                     | Behaviour                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `createImageBitmap` throws    | Toast: "Couldn't read this image. Try a different file." Form stays populated.                              |
| `OffscreenCanvas` unavailable | Fallback to a hidden in-DOM `<canvas>`. If both fail → toast: "Your browser doesn't support quick puzzles." |
| OOM during piece rendering    | Toast: "Couldn't generate puzzle. Try fewer pieces or a smaller image."                                     |

### Storage failures

| Condition                                          | Behaviour                                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QuotaExceededError` on `setItem`                  | `saveQuick` returns `{ persisted: false }`; toast on `/quick`: "Storage full — this puzzle will only last for this session." Generation completes; user is redirected to play; play page works because piece blob URLs and metadata are in memory. |
| Index write fails after per-puzzle write succeeded | Orphaned key. Cleaned on next `listQuick` (orphans aren't surfaced). Bounded by user actions.                                                                                                                                                      |
| Corrupted JSON read (tampering, schema bump)       | `getQuick` returns `null`; `listQuick` drops the entry. Silent recovery.                                                                                                                                                                           |

### Play page

`puzzleSource.load(id)` returns `null` for both local and API → existing 404 UI fires. Naturally covers expired and bookmarked-but-evicted puzzles. No special "expired" copy.

### SSR safety

Every `quickPuzzle/*` function guards with `typeof window === 'undefined'` (matches `progress.ts` pattern). The `/quick` page renders an empty shell server-side and populates the saved list on `onMount`.

### No telemetry

`console.error` for unexpected throws only. Matches existing web app posture.

## Testing strategy

### Unit tests (Vitest, Node)

`apps/web/src/lib/services/quickPuzzle/storage.test.ts`

- `saveQuick` evicts oldest when index has 5 entries
- `saveQuick` returns `{ persisted: false }` on `QuotaExceededError` (mock `setItem` to throw)
- `saveQuick` does NOT mutate index on quota failure
- `listQuick` drops entries with `createdAt < now - 7 days` and persists cleaned index
- `listQuick` drops entries with mismatched `schemaVersion`
- `listQuick` drops index entries whose per-puzzle key is missing (orphan)
- `getQuick` returns `null` for expired entries and removes their per-puzzle key
- `deleteQuick` removes both keys
- All functions are no-ops under `typeof window === 'undefined'`

`packages/types/src/jigsaw-path.test.ts` (moved from workflows; existing tests stay green)

`packages/types/src/grid.test.ts` (NEW)

- `getGridDimensions` returns `{1, n}` for primes, balanced grid for squares
- Edge helpers produce matching/opposite edges for adjacent positions

### Component tests (Vitest, browser mode)

`apps/web/src/lib/components/QuickPuzzleUploader.svelte.test.ts`

- Rejects non-image MIME → inline error, no submit
- Rejects > 20 MB file → inline error
- Rejects piece count outside 4–100 → inline error
- Auto-fills name from filename
- Submits with valid input (mocks `generateQuickPuzzle`)

`apps/web/src/lib/components/QuickPuzzleList.svelte.test.ts`

- Renders thumbnails from `imageDataUrl`
- Delete button calls `deleteQuick` and removes the row
- Empty state renders when list is empty

### E2E (Playwright)

`apps/web/e2e/quick-puzzle.spec.ts`

- Upload a small fixture image at `/quick`, submit, expect redirect to `/puzzle/q-…`, expect pieces in the tray (count matches input)
- Place one piece correctly (sanity reuse of existing solving patterns)
- Reload the play page: pieces re-render from `localStorage`
- Navigate back to `/quick`: saved list shows the puzzle
- Delete from list: row disappears, navigating to `/puzzle/q-…` shows the existing 404 UI

### Out of scope

- Cross-tab races (acknowledged, not harnessed)
- Filling `localStorage` to 5 MB for real (mock the throw)
- 7-day expiry by waiting (`vi.setSystemTime` instead)
- Visual regression of generated piece geometry (covered by deterministic edge/path-helper unit tests)

### Build gates

`bun run check` and `bun run lint` must pass after the move of `jigsaw-path.ts` + edge helpers + `getGridDimensions` into `packages/types`.

## Build sequence (informational)

The implementation plan will detail this; rough order:

1. Move `generateJigsawSvgMask`, edge helpers, `getGridDimensions` into `packages/types`. Update workflow imports. Verify workflow tests still pass.
2. Add `quickPuzzle/storage.ts` + tests.
3. Add `quickPuzzle/generator.ts` + a smoke test (deterministic output for a fixed input).
4. Add `puzzleSource.ts`. Refactor `/puzzle/[id]/+page.svelte` to use it; refactor `PuzzleBoard`, `PuzzlePiece`, `ReferenceOverlay` to take resolver props. All existing E2E tests should still pass.
5. Add `/quick/+page.svelte` + `QuickPuzzleUploader` + `QuickPuzzleList` + component tests.
6. Add header link.
7. Add `e2e/quick-puzzle.spec.ts`.

## Open questions

None at the time of this spec. Anything that surfaces during implementation goes into the implementation plan.
