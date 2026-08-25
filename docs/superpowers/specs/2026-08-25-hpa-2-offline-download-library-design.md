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
- One puzzle download at a time, with fixed-size chunks of at most **5** active asset requests.
- Show simple `done / total` download progress; no queue, background transfer, or resumable chunks.
- Manifest-last + same-volume directory move is the install boundary.
- Remove Download deletes assets only; Discard Progress deletes session only.
- Unknown manifest schemas are corrupt; no pre-release migration compatibility.
- Retained progress is validated against freshly downloaded canonical metadata through the existing game-core codec.
- A valid zero-activity save is disposable implementation residue and behaves as no progress; meaningful activity or a sealed completion is protected until explicit Discard.
- HPA-1 fixture code/assets are deleted after the real package path works; no fallback branch.
- No SQLite/index, checksum system, search/category parity, account sync, portrait work, or HPA-3 gameplay parity.

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

`App.svelte` remains the composition root. It owns the concrete API/download/session services and the single active download job. `Library.svelte` owns only gallery/downloaded presentation and disk/network reads.

No repository interface, DI container, generic cache, sync engine, or database catalog is added.

## Public Puzzle Boundary

`PuzzleApi` is mobile-local. It copies the public URL pattern from the web client rather than importing the SvelteKit-bound web service.

`PuzzleApi.getPuzzle()` calls existing `validatePuzzleMetadata()` before any asset scheduling, then requires:

- `status === 'ready'`;
- returned ID equals the requested ID.

It returns a clean `ReadyPuzzle` projection containing only the existing shared metadata fields. HPA-2 does **not** add `ReadyPuzzleDetail` or change web/E2E types just to model `hasReference`.

The server's `hasReference` field is display-only and can degrade to false when its R2 head check fails. Mobile therefore does not persist or trust it as the install contract.

### Reference download

Every download attempts `GET /api/puzzles/:id/reference` once:

- `2xx` => save the reference and record `referenceFile`;
- `404` => reference is absent; continue the install;
- any other HTTP/transport/write error => fail the download like another asset error.

This avoids baking a transient `hasReference: false` into an otherwise permanent offline package.

## API Base and iOS Local Development

`apps/mobile/webpack.config.js` injects `__PERSEUS_API_BASE__` from `PERSEUS_MOBILE_API_BASE`. The constructor strips trailing `/` characters before building URLs. Development fallback is `http://localhost:4690`; remote/TestFlight bases use HTTPS.

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

HPA-1 gated unproven native assumptions before depending on them; HPA-2 keeps that sequencing.

### Gate A — JSON transport

At the end of Task 1, temporarily call the real `nativePuzzleJsonRequest()` against `/api/puzzles` on the target iOS runtime and prove a real 2xx JSON response. Remove the probe before commit.

Failure stops HPA-2 before manifest/store work.

### Gate B — binary file + directory finalization

Immediately after native download files exist:

1. fetch a real thumbnail through `Http.request()` + `content.toFile()`;
2. prove the file is non-empty;
3. create a staging directory with a sentinel;
4. move the staging directory to a sibling finalized path on the same app-private volume;
5. prove staging is gone and the sentinel is at destination;
6. remove probe data.

HPA-1 already proved the iOS `NSFileManager` URL bridge exists through `replaceItemAtURL...`, so the HPA-2 move uses the same `(globalThis as any)` bridge style and tries the URL-form move first, with path-form move as one fallback. If neither directory move works, stop before UI and revise finalization; copy/delete is not silently substituted for the install boundary.

Android directory finalization is out of scope for this iPad ticket. The native adapter throws `download_directory_move_unsupported` outside iOS rather than shipping an untested `java.io.File.renameTo()` branch.

Final HPA-2 smoke still proves the complete feature, but it is not the first native proof.

## Download Manifest

`manifest.json` is a small mobile-local wrapper around metadata already validated by shared code:

```ts
interface DownloadManifestV1 {
	schemaVersion: 1;
	puzzle: ReadyPuzzle;
	files: {
		thumbnailFile: string;
		referenceFile?: string;
		pieceFiles: Record<string, string>;
	};
	downloadedAt: number;
}
```

`puzzle` retains the validated server metadata, including `version`, `createdAt`, edges, and remote `imagePath` strings. Those remote paths are never used for local asset resolution; only `files` resolves installed assets.

The manifest parser owns only local/disk concerns plus delegation to existing validators:

1. require `schemaVersion === 1`;
2. require `validatePuzzleMetadata(puzzle)` and `puzzle.status === 'ready'`;
3. require a finite `downloadedAt`;
4. require safe relative thumbnail/reference filenames;
5. require `pieceFiles` to contain exactly one safe relative filename for every piece ID present in `puzzle.pieces`, with no extra keys.

It does **not** reimplement grid math, aspect-ratio rules, coordinate bounds, unique piece IDs, or unique canonical cells. `validatePuzzleMetadata()` owns the shared wire checks and `createPuzzleSession()` remains the documented game-core invariant boundary for the stronger gameplay geometry checks.

The manifest does not invent the stricter rule that piece IDs must be `0..pieceCount - 1`; download requests use the IDs actually present in `puzzle.pieces`.

`sessionSpecFromManifest()` is only a projection:

```ts
SessionPuzzleSpec {
	puzzleId: manifest.puzzle.id,
	source: 'api',
	pieceCount: manifest.puzzle.pieceCount,
	gridCols: manifest.puzzle.gridCols,
	gridRows: manifest.puzzle.gridRows,
	pieces: manifest.puzzle.pieces.map(({ id, correctX, correctY }) => ({
		id,
		correctX,
		correctY
	}))
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

1. reject an existing finalized package;
2. remove stale staging for this same ID only;
3. create `.staging/<id>/pieces`;
4. build thumbnail, reference, and piece requests from the validated puzzle detail;
5. process requests in sequential chunks of at most 5 using `Promise.allSettled()`;
6. after each settled request, advance optional `onProgress(done, total)`;
7. after a chunk, stop before scheduling another chunk if cancellation or any required asset failure occurred;
8. require every required local file to be non-empty;
9. create/validate the manifest;
10. write `manifest.json` **last**;
11. move complete staging directory to finalized package;
12. return installed package only after the move succeeds.

Chunking copies the bounded-concurrency pattern already used by `apps/api/src/services/reaper.ts`. Per-chunk head-of-line blocking is acceptable for one explicit install and removes the custom worker-pool state machine.

`Promise.allSettled()` makes cleanup ordering structural: all already-started writes in the current chunk settle before a failure/cancel escapes and staging is removed. Retry starts from zero.

## Cleanup and Discovery Are Separate

`scanDownloads()` is read-only. It never creates directories and never removes staging.

`cleanupStaleStaging()` is separate and runs once from persistent `App.svelte` startup, before downloads can begin. It is not called from Library mount, gameplay return, refresh, tab changes, download completion, or remove actions.

Manual/tab refresh calls only `scanDownloads()` and is safe while an active download writes under `.staging`.

## Direct Library Discovery

`scanDownloads()` ignores `.staging` and inspects finalized direct child directories only.

- missing/unparseable/unsupported manifest => corrupt;
- folder name not equal to `manifest.puzzle.id` => corrupt;
- missing/empty referenced thumbnail/reference/piece asset => corrupt;
- valid manifest + all assets => installed package with absolute local paths.

The full required-asset verification stays in the scan for HPA-2. It is a simple, bounded correctness fence for the ticket's explicit “missing files are corrupt” acceptance behavior and keeps corruption handling in one place. Moving piece verification to gameplay would require a second launch-time corruption state/redirect path. If filesystem measurement later shows scanning at most `MAX_PIECES` files per installed puzzle is a real UI problem, optimize that proven hotspot then.

Corrupt rows cannot launch. **Remove & Download Again** removes the corrupt package then runs the normal validated clean download path. No in-place repair.

## Saved Progress State

`downloadedLibrary.ts` uses only `peekSession()` + `isResumable()`:

```ts
type ProgressState =
	| { kind: 'none' }
	| { kind: 'resumable' }
	| { kind: 'protected' }
	| { kind: 'invalid'; reason: string };
```

Interpretation:

- `none` — no save, or a valid loaded snapshot with neither `hasUserActivity` nor a sealed completion;
- `resumable` — valid loaded snapshot and `storage.isResumable(snapshot)` is true;
- `protected` — valid non-resumable snapshot with `hasUserActivity === true` or `sealedCompletion !== null`;
- `invalid` — file exists but shared codec rejects it against current canonical metadata.

This deliberately treats HPA-1's immediately persisted zero-activity snapshot as `none`, so opening a puzzle and leaving without interacting does not force a pointless Discard before Start. Completed/meaningful state remains protected from silent overwrite.

### Actions

A pure `actionsForProgress()` function owns the action matrix and is table-tested:

- `none` => Start, Remove Download;
- `resumable` => Resume, Discard Progress, Remove Download;
- `protected` => Discard Progress, Remove Download;
- `invalid` => Discard Progress, Remove Download.

Only Discard calls `clearSession()`.

Remove Download never touches session storage. Re-downloading the same stable ID re-runs the same validation and may expose Resume again.

## Gameplay Entry Is Non-Destructive

Gameplay derives the manifest spec/context and calls `peekSession()` again at entry.

- Resume proceeds only from loaded + resumable.
- Start proceeds when the current persisted result is missing **or** is a valid zero-activity snapshot with no sealed completion.
- `protected`, invalid, or stale/non-resumable Resume entry returns to Library without creating a fresh session or deleting/overwriting the file.

HPA-2 mobile code never calls `loadSession()`.

For Start over a zero-activity snapshot, the fresh session simply replaces that no-activity record at the existing persistence checkpoint; there is no user progress to preserve.

## Application Ownership

`App.svelte` stays the composition root:

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };
```

It owns:

- `PuzzleApi`;
- `DownloadStore`;
- `SessionStorageAdapter`;
- one-shot stale-staging cleanup;
- the one active download job (`puzzleId`, cancellation flag, `done`, `total`);
- `startDownload()` / `cancelDownload()`.

`Library.svelte` receives job state and callbacks as props. Moving these few fields to the existing composition root is not a download manager; it merely keeps the promise/cancellation owner alive across Library → Gameplay navigation.

Start/Resume therefore remain available while another puzzle downloads. If the user enters gameplay, the active download continues under `App.svelte`; returning to Library re-reads disk state. A small monotonically increasing `downloadRevision` lets a mounted Library refresh after a job settles without adding a store/event bus.

## Gameplay Asset Handoff

`Gameplay.svelte` receives an `InstalledDownload`, derives its `SessionPuzzleSpec`, and keeps HPA-1 session lifecycle/persistence behavior.

`PuzzleCanvas.svelte` receives:

```ts
piecePaths: Record<number, string>
```

It loads finalized local paths dynamically rather than fixed `[0,1,2,3]` bundled files.

HPA-2 keeps HPA-1 board/layout behavior. HPA-3 owns the production tablet tray, toolbar, gestures, and control parity.

The Gallery/Downloaded wiring and dynamic Gameplay conversion land in one implementation task/commit so no intermediate checkpoint renders `<Gameplay launch={...}>` against the old fixture-only component.

## Fixture Deletion

Delete:

- `apps/mobile/app/gameplay/fixture.ts`;
- all four `apps/mobile/app/assets/hpa-1/piece-*.png` files;
- fixture-only constants/copy.

No compatibility branch.

## Risks and Fences

1. **Native JSON/local networking** — Task 1 gate before download design is depended on.
2. **Binary response to file** — Task 3 thumbnail gate.
3. **Directory move bridge** — Task 3 URL-first/path-fallback iOS move probe; both failing is a design stop.
4. **Staging race** — cleanup is one-shot at persistent app root; scans are read-only; failed chunks settle before cleanup.
5. **Download-job lifetime** — job state lives at the composition root, so navigation cannot orphan it.
6. **Invalid-save deletion** — mobile library/gameplay uses `peekSession()`, never `loadSession()`.
7. **Zero-activity lockout** — zero-activity loaded snapshots map to `none`; table tests pin actions.
8. **Completed-save overwrite** — activity/sealed non-resumable snapshots map to `protected`, not `none`.
9. **Android false support** — iOS-only move implementation; other platforms fail explicitly.

## Testing

Focused Vitest tests cover:

- shared `validatePuzzleMetadata()` reuse + cursor/base-URL behavior;
- manifest schema/file-map/safe-path checks and `SessionPuzzleSpec` projection;
- chunking never starts request 6 before the first chunk settles;
- per-request progress accounting;
- failure/cancel waiting for the current chunk before cleanup;
- scan being read-only while staging exists;
- one-shot cleanup behavior at store level;
- corrupt package detection, including missing assets;
- direct filesystem discovery without index;
- Remove Download preserving progress;
- `none/resumable/protected/invalid` using the real game-core codec;
- zero-activity snapshot => `none`;
- completed snapshot => `protected`;
- pure action matrix for every progress arm;
- retained progress after matching re-download;
- canonical mismatch becoming invalid.

Native gates prove JSON transport and binary/move boundaries before UI integration.

The combined Library/Gameplay integration task ends with a real iOS app launch, not only `tsc`, so Svelte prop wiring is compiled before the task commit.

Final iPad smoke proves download progress, finalize, read-only refresh during active download, navigation while a download continues, relaunch discovery, offline start/resume, zero-activity reopen, completed-save non-overwrite, Remove Download preservation, matching re-download, and corrupt-package recovery.

No new native E2E framework.

## Implementation Boundary

Expected production changes:

- mobile API/config/library/gameplay files;
- iOS `Info.plist` local-network intent;
- mobile `@perseus/types` workspace dependency/lockfile;
- HPA-1 fixture deletions.

No expected production changes in:

- `apps/api`;
- `apps/workflows`;
- `packages/types`;
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
- Unrelated web/E2E `hasReference` type cleanup.