# HPA-2 Explicit Downloads and Offline Library Design

**Date:** 2026-08-25  
**Linear:** HPA-2 — [Perseus Mobile] Add explicit puzzle downloads and the offline library  
**Depends on:** HPA-1 (Done)  
**Blocks:** HPA-3

## Goal

Turn the HPA-1 NativeScript proof into the smallest usable offline mobile library: browse ready Perseus puzzles online, explicitly download one complete puzzle package, reconstruct installed puzzles from files after relaunch, and start or resume those puzzles with networking unavailable.

HPA-2 replaces the HPA-1 fixture boundary. It does not add a mobile-specific backend, synchronization framework, or production gameplay parity.

## Current State

HPA-1 already proved:

- NativeScript + Svelte Native + `@nativescript/canvas` on iPad;
- real piece image rendering, tap/drag input, and redraw;
- shared `@perseus/game-core` `PuzzleSession` + persistence codec;
- file-backed mobile sessions under `Documents/perseus/sessions`;
- atomic small-session file replacement;
- offline terminate/relaunch resume.

The mobile app still boots directly into `HPA1_FIXTURE`, and `PuzzleCanvas.svelte` still loads four bundled `~/assets/hpa-1/piece-N.png` files.

The public API already provides all HPA-2 data/assets:

- `GET /api/puzzles`
- `GET /api/puzzles/:id`
- `GET /api/puzzles/:id/thumbnail`
- `GET /api/puzzles/:id/reference`
- `GET /api/puzzles/:id/pieces/:pieceId/image`

No new route, ZIP bundle, Workflow output, DB schema, or R2 layout is required.

## Product Decisions

- Offline play is explicit; HTTP/image caching never counts as installed.
- Downloaded is the only offline-playable library.
- One puzzle download at a time, with exactly 5 active asset requests inside it.
- Manifest-last + same-volume directory move is the install boundary.
- Remove Download deletes assets only; Discard Progress deletes session only.
- Unknown manifest schemas are corrupt; no pre-release migration compatibility.
- Retained progress is validated against freshly downloaded canonical metadata through the existing game-core codec.
- HPA-1 fixture code/assets are deleted after the real package path works; no fallback branch.
- No SQLite/index, queue/background transfer, resumable chunks, checksum system, search/category parity, account sync, portrait work, or HPA-3 gameplay parity.

## Architecture

```text
existing public API
      |
      v
PuzzleApi
      |
      v
DownloadStore + DownloadManifestV1
      |
      v
Documents/perseus/downloads/
      |
      +--> read-only scan --> downloadedLibrary.ts --> Library UI
      |
      +--> InstalledDownload --> Gameplay.svelte --> PuzzleSession
                                                   |
                                                   v
                                      existing sessions/<id>.json
```

No repository interface, DI container, global store, generic cache, sync engine, or database catalog is added.

## Shared Puzzle Detail Contract

The ready detail response is a wire contract and already includes `hasReference`, so HPA-2 adds one type to `@perseus/types`:

```ts
export interface ReadyPuzzleDetail extends ReadyPuzzle {
	hasReference: boolean;
}
```

The existing web-local flat `Puzzle` presentation type remains unchanged in this ticket.

### HTTP-boundary validation

`PuzzleApi.getPuzzle()` calls existing `validatePuzzleMetadata()` before any asset scheduling, then requires:

- `status === 'ready'`;
- returned ID equals requested ID;
- `hasReference` is boolean.

Only then does mobile receive `ReadyPuzzleDetail`.

This prevents malformed ready metadata from downloading a full asset set before failing. The local manifest still performs its own disk-boundary validation because it stores a different local shape.

## API Base and iOS Local Development

`apps/mobile/webpack.config.js` injects `__PERSEUS_API_BASE__` from `PERSEUS_MOBILE_API_BASE`. Development fallback is `http://localhost:4690`; remote/TestFlight bases use HTTPS.

For local simulator/LAN development, iOS declares only narrow local-network intent:

```xml
<key>NSAppTransportSecurity</key>
<dict>
	<key>NSAllowsLocalNetworking</key>
	<true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to a local Perseus development server.</string>
```

Do not set `NSAllowsArbitraryLoads`.

## Native Stop Gates

HPA-1 gated unproven native assumptions before depending on them; HPA-2 does the same.

### Gate A — JSON transport

At the end of Task 1, temporarily call the real `nativePuzzleJsonRequest()` against `/api/puzzles` on the target iOS runtime and prove a real 2xx JSON response. Remove the probe before commit.

Failure stops HPA-2 before manifest/store work.

### Gate B — binary file + directory finalization

Immediately after native download files exist:

1. fetch a real thumbnail through `Http.request()` + `content.toFile()`;
2. prove the file is non-empty;
3. create a staging directory with a sentinel;
4. move the staging directory to a sibling finalized path on the same app-private volume;
5. prove staging is gone and sentinel is at destination;
6. remove probe data.

For iOS movement, try the path-based `NSFileManager` bridge first and equivalent URL-based move second. If both fail, stop before UI and revise finalization. Do not silently replace the contract with copy/delete.

Final HPA-2 smoke still proves the complete feature, but it is no longer the first native proof.

## Download Manifest

`manifest.json` is mobile-local:

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
	pieces: Array<{ id: number; correctX: number; correctY: number }>;
	thumbnailFile: string;
	referenceFile?: string;
	pieceFiles: Record<string, string>;
	downloadedAt: number;
}
```

It omits remote `imagePath`, edges, server status/version/idempotency, session state, checksums, and index metadata.

The codec validates schema version, identity, positive dimensions, exact grid/piece count, IDs `0..pieceCount - 1`, unique in-bounds canonical cells, exact file mappings, and safe relative filenames.

It projects:

```ts
SessionPuzzleSpec {
	puzzleId,
	source: 'api',
	pieceCount,
	gridCols,
	gridRows,
	pieces
}
```

Downloaded is asset availability, not a new puzzle source.

## Filesystem Layout

```text
Documents/perseus/
  downloads/
    .staging/
      <puzzleId>/
        pieces/
        ...partial assets...
        manifest.json       # written last
    <puzzleId>/
      manifest.json
      thumbnail.<ext>
      reference.<ext>       # optional
      pieces/<pieceId>.<ext>
  sessions/<puzzleId>.json
```

No downloads/session index is written.

## Download Lifecycle

`DownloadStore.downloadPuzzle()`:

1. reject existing finalized package;
2. remove stale staging for this same ID only;
3. create `.staging/<id>/pieces`;
4. schedule thumbnail, optional reference, and every piece with five workers;
5. after first error/cancel, schedule no new work but wait for already-started writes to settle;
6. verify every required file is non-empty;
7. create/validate manifest;
8. write `manifest.json` last;
9. move complete staging directory to finalized package;
10. return installed package only after move succeeds.

Failure/cancel cleans this job's staging only after in-flight writes settle. Retry starts from zero.

## Cleanup and Discovery Are Separate

`scanDownloads()` is read-only. It never creates directories and never removes staging.

`cleanupStaleStaging()` is separate and runs **once from persistent `App.svelte` startup**, before `Library.svelte` is mounted. It is not called from Library mount, gameplay return, refresh, tab changes, download completion, or remove actions.

This matters because `Library.svelte` remounts after gameplay; putting cleanup there would turn a later remount into a destructive “startup” operation.

Manual/tab refresh calls only `scanDownloads()` and is safe even while an active download is writing under `.staging`.

## Direct Library Discovery

`scanDownloads()` ignores `.staging` and inspects finalized direct child directories only.

- missing/unparseable/unsupported manifest => corrupt;
- folder/manifest ID mismatch => corrupt;
- missing/empty referenced asset => corrupt;
- valid manifest + all assets => installed package with absolute local paths.

Corrupt rows cannot launch. **Remove & Download Again** removes the corrupt package then runs the normal validated clean download path. No in-place repair.

## Saved Progress State

`downloadedLibrary.ts` uses only `peekSession()` + `isResumable()`:

```ts
type ProgressState =
	| { kind: 'none' }
	| { kind: 'resumable' }
	| { kind: 'present' }
	| { kind: 'invalid'; reason: string };
```

- `none`: no session file.
- `resumable`: valid loaded session and `isResumable()` true.
- `present`: valid loaded session but not resumable, including completed/no-activity states.
- `invalid`: file exists but shared codec rejects it against current canonical metadata.

A completed/valid non-resumable save must not collapse to `none`, because Start would silently overwrite it.

### Actions

- `none` => Start, Remove Download.
- `resumable` => Resume, Discard Progress, Remove Download.
- `present` => Discard Progress, Remove Download; Start appears only after explicit discard.
- `invalid` => Discard Progress, Remove Download; never Start/Resume before discard.

Only Discard calls `clearSession()`.

Remove Download never touches session storage. Re-downloading the same stable ID re-runs the same validation and may expose Resume again.

## Gameplay Entry Is Non-Destructive

Gameplay derives the manifest spec/context and calls `peekSession()` again at entry.

- Resume proceeds only from loaded + resumable.
- Start proceeds only when the persisted result is still missing.
- A stale/unavailable launch returns to Library without creating a fresh session or deleting/overwriting the file.

HPA-2 mobile code does not call `loadSession()`.

## Application Ownership

`App.svelte` stays the composition root:

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };
```

It owns concrete `PuzzleApi`, `DownloadStore`, `SessionStorageAdapter`, and one-shot stale-staging cleanup.

`Library.svelte` owns Gallery/Downloaded presentation and one active download job.

While a Library-owned download promise is active, Start/Resume is disabled. This prevents navigating to gameplay from destroying the component that owns the cooperative cancellation/job state and avoids introducing a global download manager.

Once the job settles or is cancelled, launch controls are available again.

## Gameplay Asset Handoff

`Gameplay.svelte` receives an `InstalledDownload`, derives its `SessionPuzzleSpec`, and keeps HPA-1 session lifecycle/persistence behavior.

`PuzzleCanvas.svelte` receives:

```ts
piecePaths: Record<number, string>
```

It loads finalized local paths dynamically rather than fixed `[0,1,2,3]` bundled files.

HPA-2 keeps HPA-1 board/layout behavior. HPA-3 owns the production tablet tray, toolbar, gestures, and control parity.

## Fixture Deletion

Delete:

- `apps/mobile/app/gameplay/fixture.ts`;
- all four `apps/mobile/app/assets/hpa-1/piece-*.png` files;
- fixture-only constants/copy.

No compatibility branch.

## Risks and Fences

1. **Native JSON/local networking** — Task 1 gate before download design is depended on.
2. **Binary response to file** — Task 3 thumbnail gate.
3. **Directory move bridge** — Task 3 path/URL move probe; both failing is a design stop.
4. **Staging race** — cleanup is one-shot at persistent app root; scans are read-only.
5. **Orphan Library job** — gameplay launch disabled while the Library-owned download promise exists.
6. **Invalid-save deletion** — mobile library/gameplay uses `peekSession()`, never `loadSession()`.
7. **Completed-save overwrite** — valid non-resumable state is `present`, not `none`.

## Testing

Focused Vitest tests cover:

- shared `validatePuzzleMetadata()` reuse + `hasReference` detail validation;
- cursor URL behavior;
- manifest codec/projection;
- exactly five active asset workers;
- failure/cancel waiting for in-flight writes before cleanup;
- scan being read-only while staging exists;
- one-shot cleanup behavior at store level;
- corrupt package detection;
- direct filesystem discovery without index;
- Remove Download preserving progress;
- `none/resumable/present/invalid` using the real game-core codec;
- retained progress after matching re-download;
- canonical mismatch becoming invalid.

Native gates prove JSON transport and binary/move boundaries before UI integration.

Final iPad smoke proves download, finalize, read-only refresh during active download, relaunch discovery, offline start/resume, completed-save non-overwrite, Remove Download preservation, matching re-download, and corrupt-package recovery.

No new native E2E framework.

## Implementation Boundary

Expected production changes:

- mobile API/config/library/gameplay files;
- iOS `Info.plist` local-network intent;
- one `ReadyPuzzleDetail` wire type in `packages/types`;
- workspace dependency/lockfile;
- HPA-1 fixture deletions.

No expected production changes in:

- `apps/api`;
- `apps/workflows`;
- `packages/game-core`;
- DB migrations;
- Cloudflare infrastructure.

If existing endpoints or game-core contracts prove insufficient, stop and revise HPA-2 rather than adding a parallel backend/framework ad hoc.

## Non-Goals

- SQLite/index/cache catalog.
- Download queue/background service.
- Partial/resumable downloads.
- Checksums/content-addressed storage.
- ZIP/bundle endpoint.
- Automatic cache promotion.
- Local-photo puzzle creation.
- Search/category parity.
- Portrait/adaptive-tablet work.
- Production pinch/pan/toolbar/tray parity.
- Account/cloud-session/completion sync.
- Backward-compatible mobile manifest migrations.
- Broad ATS disablement or arbitrary insecure remote HTTP.