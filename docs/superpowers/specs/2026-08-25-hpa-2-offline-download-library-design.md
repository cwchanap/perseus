# HPA-2 Explicit Downloads and Offline Library Design

**Date:** 2026-08-25  
**Linear:** HPA-2 — [Perseus Mobile] Add explicit puzzle downloads and the offline library  
**Depends on:** HPA-1 (Done)  
**Blocks:** HPA-3

## Goal

Turn the HPA-1 NativeScript proof into the smallest usable offline mobile library: browse ready Perseus puzzles online, explicitly download one complete puzzle package, reconstruct installed puzzles from files after relaunch, and start or resume those puzzles with networking unavailable.

This ticket replaces the HPA-1 fixture boundary. It does not expand the gameplay feature set, introduce synchronization infrastructure, or add a mobile-specific backend.

## Current State

HPA-1 already proved the high-risk gameplay foundations on iPad:

- NativeScript + Svelte Native + `@nativescript/canvas` renders real Perseus piece images and handles tap/drag input.
- `@perseus/game-core` owns `PuzzleSession`, session codec/validation, history, hints, rotation, inventory helpers, clocks, and run IDs.
- Mobile session persistence is file-backed under `Documents/perseus/sessions` and replaces the canonical JSON through a temp-file path.
- The mobile app still boots directly into one hard-coded `HPA1_FIXTURE`, and `PuzzleCanvas.svelte` loads four bundled `~/assets/hpa-1/piece-N.png` files.

The public API already exposes every HPA-2 asset:

- `GET /api/puzzles`
- `GET /api/puzzles/:id`
- `GET /api/puzzles/:id/thumbnail`
- `GET /api/puzzles/:id/reference`
- `GET /api/puzzles/:id/pieces/:pieceId/image`

No new API route, ZIP endpoint, Workflow output, D1 schema, or R2 layout is required.

## Product Decisions

- Offline play is explicit. Viewing a Gallery row or relying on HTTP/image caching never makes a puzzle installed.
- The **Downloaded** view is the only source of offline-playable puzzles.
- One puzzle may download at a time. There is no queue or background-transfer service in HPA-2.
- One download uses exactly **5** concurrent asset requests.
- A puzzle becomes installed only after every required asset is present, `manifest.json` is written last, and staging is finalized on the same app-private volume.
- Downloads and gameplay progress are independent. **Remove Download** deletes assets only; **Discard Progress** deletes the session only.
- Unknown download-manifest schema versions are corrupt. This pre-release project does not migrate old mobile manifests.
- Retained progress is never partially repaired. It is validated through the existing game-core session codec against the currently downloaded canonical metadata.
- HPA-1 fixture code/assets are deleted once downloaded local paths feed the same Canvas path. There is no compatibility fallback.
- HPA-2 does not add search/category parity, account state, completion sync, portrait layout, production gesture parity, SQLite, a download index, or a generic navigation/state framework.

## Selected Approach

Use direct app-private filesystem packages and concrete mobile-local services.

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
        +--> read-only scan --> downloadedLibrary.ts --> Downloaded UI
        |
        +--> installed package --> Gameplay.svelte --> PuzzleSession
                                                    |
                                                    v
                                         existing sessions/<id>.json
```

There is deliberately no repository interface, global store, dependency-injection container, SQLite catalog, generalized cache, sync engine, or download worker.

## Shared API Contract

The full public puzzle-detail response is an API wire contract, so HPA-2 adds one small type to `@perseus/types` instead of creating another mobile-only fork:

```ts
export interface ReadyPuzzleDetail extends ReadyPuzzle {
	hasReference: boolean;
}
```

The server already returns `hasReference` on ready detail reads. The existing web-local flat `Puzzle` presentation type does not need to be migrated in HPA-2.

### HTTP-boundary validation

`PuzzleApi.getPuzzle()` must reuse the existing `validatePuzzleMetadata()` before any asset requests are scheduled. After shared validation succeeds, it additionally requires:

- `status === 'ready'`;
- response `id` equals the requested puzzle ID;
- `hasReference` is a boolean.

Only then is the value returned as `ReadyPuzzleDetail`.

This prevents malformed ready metadata from causing a full set of piece downloads before failure. The mobile manifest codec still validates the disk contract independently because it has local-only filenames and omits server-only piece fields.

`PuzzleApi.listPuzzles()` remains a small client for the existing `PuzzleListResponse` cursor contract. HPA-2 does not copy the web auth/admin client.

## Mobile API Base and iOS Local Development

`apps/mobile/webpack.config.js` injects one build-time `__PERSEUS_API_BASE__` string from `PERSEUS_MOBILE_API_BASE` using the existing NativeScript webpack `DefinePlugin`. The development fallback remains `http://localhost:4690`, matching the local Worker API.

Remote/TestFlight builds must use HTTPS.

For simulator/LAN development, `apps/mobile/App_Resources/iOS/Info.plist` declares only the narrow local-network intent:

```xml
<key>NSAppTransportSecurity</key>
<dict>
	<key>NSAllowsLocalNetworking</key>
	<true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to a local Perseus development server.</string>
```

Do not add `NSAllowsArbitraryLoads` or a production-wide insecure HTTP exception.

## Early Native Gates

HPA-1 gated its unproven filesystem replacement before depending on it. HPA-2 applies the same rule to new native boundaries rather than waiting until final acceptance.

### Gate A — JSON transport and local-network policy

At the end of the API-client task, before download/store work proceeds:

1. start a reachable Perseus API;
2. run the iOS app with `PERSEUS_MOBILE_API_BASE` pointed at it;
3. temporarily call the real `nativePuzzleJsonRequest()` against `/api/puzzles` from the app;
4. prove a 2xx JSON response reaches JavaScript on the target simulator/iPad;
5. remove the temporary probe before the task commit.

Failure here stops HPA-2 before manifest/download UI work.

### Gate B — binary `toFile` and directory finalization

Immediately after `nativeDownloadFiles.ts` exists, before Downloaded/Gallery call sites:

1. download one real thumbnail through `Http.request()` + `response.content.toFile()`;
2. verify the resulting file is non-empty;
3. create a staging directory with a sentinel file;
4. move that directory to a sibling finalized location on the same app-private volume;
5. verify the sentinel exists at the destination and staging is gone;
6. clean the probe files.

For iOS directory movement, try the direct `NSFileManager.moveItemAtPath...` bridge first. If that bridge shape is unavailable, use the equivalent URL-based `moveItemAtURL...` API. Both preserve the same same-volume move contract. If neither works reliably, stop before Task 4/UI and revise the finalization design; do not silently fall back to a non-atomic copy/delete package install.

The final HPA-2 smoke remains necessary, but it is no longer the first proof of these native assumptions.

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

The manifest intentionally omits remote `imagePath`, piece edge geometry, server status/version/idempotency fields, session state, checksums, and index/cache metadata.

The disk codec validates:

- schema version;
- stable puzzle identity;
- positive dimensions and exact grid/piece count consistency;
- piece IDs exactly `0..pieceCount - 1`;
- unique, in-bounds canonical coordinates;
- exact piece-file mapping;
- safe relative thumbnail/reference/piece filenames.

It then projects the existing game-core shape:

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

A downloaded server puzzle remains `source: 'api'`; “downloaded” is local asset availability, not puzzle origin.

## Filesystem Layout

The app-private Documents directory remains the source of truth:

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

## Download Lifecycle

`DownloadStore.downloadPuzzle()` owns one lifecycle:

1. reject if the finalized package already exists;
2. remove stale staging for the same puzzle ID;
3. create `downloads/.staging/<puzzleId>/pieces/`;
4. download thumbnail, optional reference, and every piece using at most 5 active requests;
5. stop scheduling new work after the first error/cancel request, but wait for already-started writes to settle;
6. require every expected file to exist and be non-empty;
7. build and validate `DownloadManifestV1`;
8. write `manifest.json` **last** in staging;
9. move the complete staging directory to `downloads/<puzzleId>` on the same app-private volume;
10. only then report the package as installed.

Any request/validation/write/move failure removes that puzzle's staging directory only after in-flight writes have settled. Retry restarts from zero.

The UI exposes one cooperative **Cancel** action. Already-started native requests may finish, but no additional assets are scheduled, no final package is created, and staging is removed before the operation returns.

## Staging Cleanup Is Separate from Discovery

`scanDownloads()` is read-only. It never removes staging and never depends on every UI caller remembering whether a download is active.

`cleanupStaleStaging()` is a separate `DownloadStore` operation and is called once during application/library startup before any HPA-2 download can begin. It removes abandoned direct children of `.staging` left by a terminated/failed previous process.

Manual/tab refreshes call only `scanDownloads()`.

This keeps filesystem discovery safe even if future call sites refresh while a download is running.

## Direct Library Discovery

`scanDownloads()` enumerates finalized direct child directories of `downloads/` and ignores `.staging`.

For each finalized child:

- missing/unparseable/unsupported `manifest.json` => corrupt package;
- valid manifest with missing/empty required assets => corrupt package;
- folder-name/manifest-ID mismatch => corrupt package;
- valid manifest with all required assets => installed package with absolute local asset paths.

The scan returns valid and corrupt entries. It never creates an index and never opens a corrupt package as gameplay input.

A corrupt row exposes **Remove & Download Again**. That removes the unusable finalized package, fetches fresh canonical detail through `PuzzleApi`, and runs the normal clean download path. There is no in-place repair.

## Progress Revalidation and Ownership

`downloadedLibrary.ts` combines an installed package with the existing `SessionStorageAdapter` using only `peekSession()` and `isResumable()`.

```ts
type ProgressState =
	| { kind: 'none' }
	| { kind: 'resumable' }
	| { kind: 'present' }
	| { kind: 'invalid'; reason: string };
```

Interpretation:

- `none` — no session file exists;
- `resumable` — valid loaded session and `storage.isResumable(snapshot)` is true;
- `present` — a valid session exists but is not resumable, including completed or no-activity states;
- `invalid` — the file exists but fails the shared codec against current canonical metadata.

A valid non-resumable file must never collapse to `none`; otherwise a completed save can be silently overwritten by a fresh run.

### Downloaded actions

- `none` => **Start**, **Remove Download**.
- `resumable` => **Resume**, **Discard Progress**, **Remove Download**.
- `present` => **Discard Progress**, **Remove Download**. After explicit discard, the row becomes `none` and **Start** appears.
- `invalid` => **Discard Progress**, **Remove Download**; never Start/Resume until the invalid file is explicitly discarded.

Only **Discard Progress** calls `SessionStorageAdapter.clearSession()`.

**Remove Download** has no session dependency and never calls `clearSession()`.

After the same stable puzzle ID is downloaded again, the retained session is re-evaluated against the freshly downloaded canonical metadata and can become resumable again.

## Gameplay Resume Must Be Non-Destructive

`Gameplay.svelte` receives a concrete `GameplayLaunch` containing one installed package and `mode: 'start' | 'resume'`.

For resume, gameplay derives the current validation context and calls `storage.peekSession()` again. It never calls `loadSession()` because `loadSession()` intentionally deletes invalid session data.

If the second peek is loaded and resumable, construct `PuzzleSession` from that snapshot. If it is missing, invalid, or no longer resumable, show “Saved progress is no longer resumable” and return to the library without creating a fresh run or deleting the file.

Fresh start is only reachable from a `ProgressState.none` row, so it cannot silently overwrite a completed/invalid retained session.

## Application UI and Navigation

`App.svelte` remains the composition root with one local discriminated screen state:

```ts
type MobileScreen =
	| { kind: 'library' }
	| { kind: 'gameplay'; launch: GameplayLaunch };
```

No navigation library or global store is added.

`Library.svelte` owns the concrete service orchestration and two sections:

- **Gallery** — ready server puzzles with explicit Download/Downloaded state and existing cursor pagination only;
- **Downloaded** — installed and corrupt disk-derived packages with progress-derived actions.

Online Gallery failure must not clear or block disk-derived Downloaded state.

## Gameplay Asset Handoff

`Gameplay.svelte` no longer imports `HPA1_FIXTURE`. It derives `SessionPuzzleSpec` from the installed manifest and keeps the HPA-1 lifecycle/persistence behavior.

`PuzzleCanvas.svelte` receives:

```ts
piecePaths: Record<number, string>
```

It dynamically loads piece images from finalized local files. Piece IDs come from the manifest/session, not a `[0, 1, 2, 3]` constant.

HPA-2 deliberately keeps the HPA-1 board interaction/layout. HPA-3 owns production landscape tray, toolbar, gestures, and gameplay parity.

## Fixture Deletion

Once a downloaded package drives the same Canvas path, delete:

- `apps/mobile/app/gameplay/fixture.ts`;
- `apps/mobile/app/assets/hpa-1/piece-0.png` through `piece-3.png`;
- fixture-specific labels/constants in `Gameplay.svelte` and `PuzzleCanvas.svelte`.

No compatibility branch remains.

## Risks and Stop Gates

### 1. Native JSON transport / local networking

Risk: this app has not previously used NativeScript HTTP, and iOS local development has transport/privacy policy requirements.

Gate: Task 1 proves a real JSON GET after adding the narrow local-network plist declarations. Failure stops HPA-2 before download-store work.

### 2. Native binary response → file

Risk: HPA-1 did not exercise `Http.request().content.toFile()`.

Gate: Task 3 downloads a real thumbnail to a non-empty app-private file before UI integration.

### 3. Same-volume directory move bridge

Risk: HPA-1 proved file replacement, not directory movement.

Gate: Task 3 moves a real staging directory on the target iOS runtime. Path-based and URL-based `NSFileManager` move APIs are the only planned bridge variants. Failure after both is a design stop, not permission to add a silent copy/delete install.

### 4. Session deletion semantics

Risk: `SessionStorageAdapter.loadSession()` removes invalid saves.

Fence: HPA-2 library and gameplay resume use `peekSession()` only. Explicit Discard remains the owner of `clearSession()`.

### 5. Completed/non-resumable saves

Risk: `isResumable()` is intentionally false for completed/no-activity snapshots.

Fence: valid loaded non-resumable saves map to `ProgressState.present`, not `none`; fresh Start is unavailable until explicit discard.

## Testing Strategy

### Unit/service tests

Focused Vitest tests cover:

- `validatePuzzleMetadata()` reuse and detail `hasReference` validation at the HTTP boundary;
- cursor propagation;
- manifest creation/validation and `SessionPuzzleSpec` projection;
- five-way scheduling and manifest-last/finalize ordering;
- failure/cancel cleanup waiting for in-flight writes;
- `scanDownloads()` being read-only while staging exists;
- startup-only stale staging cleanup;
- corrupt/missing manifest and missing-asset detection;
- direct filesystem discovery without an index;
- Remove Download preserving session state;
- `none` / `resumable` / `present` / `invalid` progress projection using the real codec;
- retained session becoming resumable after a matching re-download;
- retained session becoming invalid after canonical metadata mismatch;
- resume using non-destructive `peekSession()` semantics.

Tests use small in-memory/file-operation fakes around concrete seams and do not reimplement NativeScript.

### Native gates

Task 1 proves real JSON transport/local-network configuration. Task 3 proves binary `toFile` and directory movement before library/gameplay integration.

### Final iPad smoke

The implementation PR still proves the complete product path:

1. browse Gallery and download one ready puzzle;
2. verify finalized package/no staging residue;
3. terminate/relaunch and reconstruct Downloaded from disk;
4. disable networking and start a downloaded puzzle;
5. create progress, terminate/relaunch, and resume offline;
6. Remove Download and verify the session file remains;
7. re-download the same ID and verify Resume returns after validation;
8. corrupt one finalized asset and verify Start/Resume is blocked with Remove & Download Again.

No native E2E framework is added for HPA-2.

## Implementation Boundary

Expected production scope is:

- `apps/mobile` API/config/library/gameplay files;
- `apps/mobile/App_Resources/iOS/Info.plist` for narrow local-development networking intent;
- one small `ReadyPuzzleDetail` API wire type in `packages/types`;
- workspace dependency/lockfile updates.

No production changes are expected in:

- `apps/api`;
- `apps/workflows`;
- `packages/game-core`;
- database schemas/migrations;
- Cloudflare infrastructure.

If the existing public endpoints or shared game-core contract prove insufficient, stop and revise HPA-2 rather than adding a parallel mobile backend or shared framework ad hoc.

## Non-Goals

- SQLite or any library/session index.
- Download queue/background transfer service.
- Partial/resumable downloads.
- Checksums/content-addressed storage.
- ZIP/bundle endpoints.
- Automatic cache-to-offline promotion.
- Local-photo puzzle creation.
- Search/category Gallery parity.
- Portrait/adaptive-tablet work.
- Production pinch/pan/toolbar/tray parity.
- Account login, cloud session sync, or completion outbox.
- Backward-compatible mobile manifest migrations.
- Broad ATS disablement or arbitrary insecure remote HTTP.