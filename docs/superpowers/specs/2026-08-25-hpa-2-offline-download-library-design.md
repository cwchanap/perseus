# HPA-2 Explicit Downloads and Offline Library Design

**Date:** 2026-08-25
**Linear:** HPA-2 — [Perseus Mobile] Add explicit puzzle downloads and the offline library
**Depends on:** HPA-1 (Done)
**Blocks:** HPA-3

## Goal

Turn the HPA-1 NativeScript proof into the smallest usable offline mobile library: browse ready Perseus puzzles online, explicitly download one complete puzzle package, reconstruct installed puzzles from files after relaunch, and start or resume those puzzles with networking unavailable.

This ticket replaces the HPA-1 fixture boundary. It does not expand the gameplay feature set, introduce synchronization infrastructure, or change the server API.

## Current State

HPA-1 has already proven the risky foundations on iPad:

- NativeScript + Svelte Native + `@nativescript/canvas` renders real Perseus piece images and handles tap/drag input.
- `@perseus/game-core` owns `PuzzleSession`, session codec/validation, history, hints, rotation, inventory helpers, clocks, and run IDs.
- Mobile session persistence is already file-backed under `Documents/perseus/sessions` and writes JSON through a temp-file replacement path.
- The mobile app currently boots directly into one hard-coded `HPA1_FIXTURE` and `PuzzleCanvas.svelte` loads four bundled `~/assets/hpa-1/piece-N.png` files.

The existing public API already supplies everything HPA-2 needs:

- `GET /api/puzzles`
- `GET /api/puzzles/:id`
- `GET /api/puzzles/:id/thumbnail`
- `GET /api/puzzles/:id/reference`
- `GET /api/puzzles/:id/pieces/:pieceId/image`

No backend endpoint or wire-contract change is required.

## Product Decisions

- Offline play is explicit. Viewing a gallery row or playing an online preview never marks a puzzle as downloaded.
- The **Downloaded** view is the only source of offline-playable puzzles.
- One puzzle may download at a time. There is no download queue or background download service in HPA-2.
- Use a fixed asset concurrency of **5** requests inside that one download.
- A puzzle becomes installed only after every required asset is present, `manifest.json` has been written last, and the staging directory has been moved to the finalized package path.
- Downloads and gameplay progress are independent. **Remove Download** deletes assets only; **Discard Progress** deletes the session only.
- Unknown manifest schemas are treated as corrupt. This pre-release project does not migrate old mobile download manifests.
- Retained progress is never partially repaired. It is revalidated through the existing game-core session codec against the currently downloaded puzzle metadata.
- HPA-1 fixture code/assets are deleted once the real downloaded-package path replaces them. There is no compatibility fallback.
- HPA-2 does not add search, category filters, account state, completion sync, portrait layout, production gesture parity, or a generic navigation/state framework.

## Approaches Considered

### Option A — Direct filesystem packages and concrete mobile services — selected

Add one thin public API client, one mobile-local manifest codec, one concrete download store, and one direct filesystem library scan. Keep screen state in `App.svelte` and pass a resolved installed package into the existing gameplay view.

This follows the current HPA-2 contract exactly, reuses the HPA-1 file/session seams, has no server cost, and leaves clear ownership boundaries for later gameplay work.

### Option B — SQLite/repository-backed offline catalog — rejected

A database could make querying downloads and sessions convenient, but it would duplicate facts already present in finalized manifests and session files. It also creates schema/migration/index maintenance before the expected library size justifies it.

### Option C — Server-generated ZIP or generalized sync/cache layer — rejected

A ZIP endpoint would add workflow/API/storage work only to save client orchestration that is straightforward with the existing asset endpoints. A generalized cache/sync layer would conflate explicit offline installs, HTTP caching, account sync, and progress persistence. None is required for this ticket.

## Architecture

HPA-2 stays mobile-local except for adding `@perseus/types` as an existing workspace dependency:

```text
existing public Perseus API
        |
        v
apps/mobile/app/api/puzzleApi.ts
        |
        v
apps/mobile/app/library/downloadStore.ts
  + downloadManifest.ts
  + nativeDownloadFiles.ts
        |
        v
Documents/perseus/downloads/
        |
        +--> direct scan --> downloadedLibrary.ts --> Downloaded UI
        |
        +--> installed package --> Gameplay.svelte --> PuzzleSession
                                                    |
                                                    v
                                         existing sessions/<id>.json
```

There is deliberately no repository interface, global store, dependency-injection container, index database, sync engine, or download worker.

## API Boundary

### Build-time API base

`apps/mobile/webpack.config.js` injects one global string constant from `PERSEUS_MOBILE_API_BASE` using the existing webpack `DefinePlugin`. When the environment variable is absent, development builds use `http://localhost:4690`, matching the repository's local Worker API.

A small declaration under `apps/mobile/types/` gives TypeScript the global constant type. The app does not add runtime environment/settings plumbing.

### `PuzzleApi`

`apps/mobile/app/api/puzzleApi.ts` is a concrete client over NativeScript `Http.request` and shared `@perseus/types` contracts.

It exposes only HPA-2 operations:

```ts
interface PublicReadyPuzzle extends ReadyPuzzle {
  hasReference?: boolean;
}

interface PuzzleApi {
  listPuzzles(cursor?: string): Promise<PuzzleListResponse>;
  getPuzzle(puzzleId: string): Promise<PublicReadyPuzzle>;
  thumbnailUrl(puzzleId: string): string;
  referenceUrl(puzzleId: string): string;
  pieceImageUrl(puzzleId: string, pieceId: number): string;
}
```

`getPuzzle()` rejects non-ready or malformed responses before a download starts. The gallery can render the first page and append the existing `nextCursor`; no mobile search/filter contract is introduced.

Asset transfer itself stays in the download filesystem adapter so the API client does not become a repository/downloader abstraction.

## Download Manifest

`manifest.json` is a mobile-local contract, not an API type and not a game-core persistence schema.

```ts
interface DownloadManifestV1 {
  schemaVersion: 1;
  puzzleId: string;
  name: string;
  category?: PuzzleCategory;
  aspectRatio?: PuzzleAspectRatio;
  pieceCount: number;
  gridCols: number;
  gridRows: number;
  imageWidth: number;
  imageHeight: number;
  pieces: Array<{
    id: number;
    correctX: number;
    correctY: number;
  }>;
  thumbnailFile: string;
  referenceFile?: string;
  pieceFiles: Record<string, string>;
  downloadedAt: number;
}
```

The manifest intentionally omits:

- remote `imagePath` values;
- server status/version/idempotency fields;
- session state;
- checksums;
- cache/index metadata.

The local codec validates schema version, puzzle identity, positive/grid-consistent counts, unique piece IDs, in-bounds canonical coordinates, an exact piece-file mapping, and safe relative filenames. It then derives the existing game-core shape:

```ts
SessionPuzzleSpec {
  puzzleId: manifest.puzzleId,
  source: 'api',
  pieceCount,
  gridCols,
  gridRows,
  pieces
}
```

A downloaded server puzzle remains `source: 'api'`; “downloaded” is asset availability, not puzzle origin.

## Filesystem Layout

The source of truth remains app-private Documents storage:

```text
Documents/perseus/
  downloads/
    .staging/
      <puzzleId>/
        ...partial assets...
        manifest.json       # only after all assets verify
    <puzzleId>/
      manifest.json
      thumbnail.<ext>
      reference.<ext>       # only when server metadata says available
      pieces/
        <pieceId>.<ext>
  sessions/
    <puzzleId>.json
```

No `downloads.json`, session index, SQLite table, or derived cache is written.

## Atomic Download Lifecycle

`DownloadStore.downloadPuzzle()` owns one deterministic lifecycle:

1. Remove stale staging data for that `puzzleId`.
2. Create `downloads/.staging/<puzzleId>/pieces/`.
3. Download thumbnail, optional reference, and all piece images with at most 5 active asset requests.
4. Require every HTTP response to be 2xx and map supported image Content-Types to `.png`, `.jpg`, or `.webp` filenames.
5. Require every expected local file to exist and be non-empty.
6. Build and validate `DownloadManifestV1` from the canonical ready-puzzle response and returned local filenames.
7. Write `manifest.json` **last** inside staging.
8. Move the complete staging directory to `downloads/<puzzleId>` on the same app-private volume.
9. Only then report the puzzle as installed.

NativeScript's documented `Http.request`/response-content APIs handle the binary fetch; a tiny `nativeDownloadFiles.ts` adapter owns NativeScript `File`/`Folder` operations and the platform directory move needed to move `.staging/<id>` into the finalized directory.

HPA-2 does not decode every downloaded image or add hashes. HTTP completion plus non-empty required files and manifest-last finalization are the integrity boundary for this MVP.

### Failure and cancellation

Any request/validation/write/move failure removes that puzzle's staging directory and returns an error. Retry begins from zero.

The UI exposes one cooperative **Cancel** action while a download is active. It marks the job cancelled; already-started requests may finish, but no new work is scheduled, the package is never finalized, and staging is removed before the operation returns.

No resumable/chunk download state survives app termination. On library startup/refresh, stale children under `.staging` are deleted.

## Direct Library Discovery

`DownloadStore.scanDownloads()` enumerates direct children of `downloads/` every time the Downloaded view loads or refreshes.

For each finalized child directory:

- missing/unparseable/unsupported `manifest.json` => corrupt package;
- valid manifest with missing/empty required assets => corrupt package;
- valid manifest with all required assets => installed package with absolute local asset paths.

The scan returns enough information to render both valid and corrupt rows. It never invents an index and never opens a corrupt package as gameplay input.

A corrupt row exposes **Remove & Download Again**. The action removes the unusable package, fetches fresh canonical metadata through `PuzzleApi`, and starts a clean download. There is no in-place repair.

## Progress Revalidation

`downloadedLibrary.ts` combines a valid installed package with the existing `SessionStorageAdapter`:

```ts
type ProgressState =
  | { kind: 'none' }
  | { kind: 'resumable' }
  | { kind: 'invalid'; reason: string };
```

For each installed manifest:

1. derive `SessionPuzzleSpec`;
2. derive `validationContextFrom(spec)`;
3. call `peekSession(puzzleId, context)`;
4. expose **Resume** only for a loaded snapshot for which `storage.isResumable()` is true;
5. expose invalid retained progress as invalid instead of deleting or partially hydrating it.

**Discard Progress** calls the existing session adapter's `clearSession(puzzleId)`.

**Remove Download** never calls `clearSession`. Therefore removing assets can leave a valid session file behind. After the same stable puzzle ID is downloaded again, the exact same validation path determines whether that retained snapshot is resumable against the new canonical metadata.

If the puzzle's piece/grid metadata changed, the old session is rejected. The player may discard it and start a fresh run; HPA-2 does not migrate it.

## Application UI and Navigation

`App.svelte` remains the composition root and owns a tiny discriminated local screen state:

```ts
type MobileScreen =
  | { kind: 'library' }
  | { kind: 'gameplay'; launch: GameplayLaunch };
```

No navigation library or global store is added.

### Library page

`Library.svelte` provides two concrete sections:

- **Gallery** — paginated ready server puzzles, remote thumbnail/name/piece count, and Download/Downloaded state.
- **Downloaded** — valid installed packages plus corrupt package rows.

The gallery is an online view. Native HTTP/image caching does not count as an installed puzzle; only a finalized manifest/package makes the Downloaded action state true.

The Downloaded view offers only the actions needed by this ticket:

- **Start** for an installed puzzle without resumable progress;
- **Resume** for validated resumable progress;
- **Remove Download**;
- **Discard Progress** when a session exists/invalidates;
- **Remove & Download Again** for corrupt packages.

### Gameplay handoff

`Gameplay.svelte` receives a concrete `GameplayLaunch` containing a resolved installed package and `mode: 'start' | 'resume'`.

It no longer imports `HPA1_FIXTURE` or bundled puzzle assets. It derives the session spec from the manifest and keeps all current HPA-1 session lifecycle/persistence behavior.

For resume, the existing session adapter must load a validated resumable snapshot before constructing `PuzzleSession`. For start, a fresh session is created from the downloaded canonical metadata.

`PuzzleCanvas.svelte` receives the installed `piecePaths: Record<number, string>` and loads every unplaced/placed image dynamically. Piece IDs come from the session/manifest rather than `[0, 1, 2, 3]`.

This ticket deliberately keeps the HPA-1 board interaction/layout. HPA-3 owns production landscape tray/toolbar/gesture parity.

## Deletions

Once downloaded assets drive the same native Canvas path, delete:

- `apps/mobile/app/gameplay/fixture.ts`;
- the four `apps/mobile/app/assets/hpa-1/piece-*.png` fixture files;
- all fixture-specific labels/constants in `Gameplay.svelte` and `PuzzleCanvas.svelte`.

No compatibility branch remains.

## Testing Strategy

### Unit/service tests

HPA-2 adds focused Vitest tests under `apps/mobile/app/` for:

- manifest creation/validation and `SessionPuzzleSpec` projection;
- bounded scheduling and manifest-last/finalize ordering;
- failed/cancelled download staging cleanup;
- stale staging cleanup on scan;
- corrupt/missing manifest and missing-asset detection;
- direct filesystem discovery without an index;
- Remove Download preserving session state;
- retained session becoming resumable after a matching re-download;
- retained session becoming invalid after canonical piece/grid mismatch;
- public API ready-response validation and cursor propagation.

Tests use small in-memory/file-operation fakes around the concrete service seams. They do not reimplement NativeScript itself.

### Native iPad smoke

A final simulator/device smoke is the acceptance proof for platform boundaries:

1. Build with `PERSEUS_MOBILE_API_BASE` targeting a reachable Perseus API.
2. Browse Gallery and download one ready puzzle.
3. Verify a finalized package and no `.staging/<id>` residue.
4. Terminate/relaunch the app and verify Downloaded is reconstructed from disk.
5. Disable networking (or stop the local API), start the downloaded puzzle, place at least one piece, terminate/relaunch, and resume it offline with the placement retained.
6. Remove Download and verify the session file remains while the puzzle disappears from playable Downloaded rows.
7. Re-enable networking, re-download the same puzzle ID, and verify Resume becomes available again after validation.
8. Delete one finalized piece file, relaunch/refresh, and verify the package is blocked as corrupt and offers Remove & Download Again.

No native E2E framework is added for HPA-2.

## Implementation Boundary

Expected production scope is `apps/mobile` plus the existing workspace dependency declaration. No changes are expected in:

- `apps/api`;
- `apps/workflows`;
- `packages/game-core`;
- database schemas/migrations;
- Cloudflare infrastructure.

If implementation discovers that the existing public puzzle endpoints cannot supply one of the required assets or canonical metadata, stop and revise the design rather than adding a parallel mobile backend ad hoc.

## Non-Goals

- SQLite or any library/session index.
- Download queue/background transfer service.
- Partial/resumable downloads.
- Checksums/content-addressed storage.
- ZIP/bundle endpoints.
- Automatic cache-to-offline promotion.
- Local-photo puzzle creation.
- Search/category gallery parity.
- Portrait/adaptive-tablet work.
- Production pinch/pan/toolbar/tray parity.
- Account login, cloud session sync, or completion outbox.
- Backward-compatible mobile manifest migrations.
