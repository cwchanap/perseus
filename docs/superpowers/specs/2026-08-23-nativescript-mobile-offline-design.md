# NativeScript Offline Mobile App Design

**Date:** 2026-08-23

## Goal

Add an iPad-first NativeScript mobile client for Perseus that can explicitly download gallery puzzles, play them completely offline, resume local progress, and optionally submit signed-in completion stats when connectivity returns.

The mobile client should reuse Perseus gameplay rules instead of reimplementing them, while keeping rendering, gestures, filesystem persistence, and tablet layout native to the mobile app.

## Product Decisions

- Target iPad first, while keeping shared gameplay and persistence platform-neutral for a later Android tablet port.
- Use NativeScript with Svelte Native and TypeScript.
- Use a native-backed 2D Canvas for the puzzle board. Surrounding UI remains ordinary Svelte Native controls.
- Reuse a focused shared headless game package rather than a WebView or duplicated mobile engine.
- Offline play is available only for puzzles the player explicitly downloads.
- Mobile storage is local-first and file-backed; no SQLite in the MVP.
- Use stable puzzle/run IDs and the existing persisted session schema so future cloud sync is possible without redesigning gameplay state.
- Preserve touch-oriented gameplay parity: timed/relaxed play, rotation, undo/redo, hints, reference modes, tray filtering/shuffle/organization, pause/resume, saved progress, and completion summary.
- Optimize gameplay for landscape, but support portrait with a bottom tray panel.
- Support both drag-and-drop and tap-piece/tap-cell placement.
- Optional Google login is included for TestFlight/personal distribution. App Store-specific Sign in with Apple and provider-neutral identity migration are deferred.
- Queue server completion submission only for runs completed while an account was already signed in.

## Architecture

The monorepo gains one focused gameplay package and one mobile app:

```text
packages/types
  API and shared wire contracts
       |
       v
packages/game-core
  PuzzleSession
  session contracts + pure persistence codec
  history / hints / rotation / inventory
       |                         |
       v                         v
apps/web                     apps/mobile
SvelteKit UI                 Svelte Native UI
localStorage adapter         filesystem adapter
                             Canvas board
                             download store
                             optional native auth
```

`@perseus/game-core` must remain pure TypeScript. It must not import Svelte, NativeScript, the DOM, browser storage, filesystem APIs, fetch, Cloudflare APIs, or analytics.

The existing `PuzzleSession` is already intentionally framework-independent. The extraction should move that engine and its pure dependencies rather than create a second engine.

`@perseus/types` remains focused on API/shared wire contracts. Gameplay-specific runtime types belong in `@perseus/game-core` rather than turning `@perseus/types` into a general shared-code package.

### Game-core extraction

Move or adapt these pure concerns into `packages/game-core`:

- `PuzzleSession` and its action/outcome/state contracts.
- History helper.
- Hint selection.
- Rotation helpers and deterministic rotation generation.
- Inventory filter matching.
- Session serialization and validation codec.
- Retryability policy that is part of persisted session validation.

Do not move browser storage enumeration or `localStorage` handling into game-core. Split the current persistence module so the portable codec lives in game-core while the web keeps its concrete `Storage` adapter.

The mobile app implements the same `SessionStorageAdapter` contract with JSON files.

## Mobile Application Shape

`apps/mobile` has four product-level areas:

1. **Gallery** — fetch the public server gallery and expose an explicit Download action.
2. **Downloaded** — show locally installed puzzles; start, resume, replay, remove download, or discard progress.
3. **Gameplay** — native Canvas board plus Svelte Native tray, toolbar, sheets, and dialogs backed by `PuzzleSession`.
4. **Account** — optional Google sign-in, account state, and completion-sync status.

Keep application services concrete and small:

- `PuzzleApi`
- `DownloadStore`
- `SessionStore`
- `CompletionStore`
- `CompletionOutbox`
- `AuthService`

Do not add a Redux-style global store, dependency-injection container, generic repository framework, generalized sync engine, or background job framework.

## Offline Download Model

Use the existing public puzzle endpoints. The client downloads metadata, thumbnail, reference image when available, and every generated piece image.

A completed local puzzle package looks like:

```text
Documents/perseus/downloads/<puzzleId>/
  manifest.json
  thumbnail.<ext>
  reference.<ext>        # when available
  pieces/
    <pieceId>.<ext>
```

`manifest.json` is a mobile-local contract with its own schema version. It contains:

- `schemaVersion`
- stable `puzzleId`
- name/category/aspect ratio
- piece count and grid dimensions
- image dimensions
- canonical piece metadata needed by the game core
- local thumbnail/reference filenames
- piece ID to local filename mapping
- `downloadedAt`

Do not reuse remote `imagePath` values as local paths. Asset resolution belongs to the mobile download manifest/store.

### Atomic download lifecycle

```text
Download requested
  -> create downloads/.staging/<puzzleId>/
  -> fetch metadata
  -> fetch thumbnail/reference/pieces with bounded concurrency
  -> verify every required asset exists
  -> write manifest.json last
  -> move staging directory to downloads/<puzzleId>/
  -> puzzle becomes visible in Downloaded
```

Use a small fixed concurrency limit (approximately 4-6 requests). Failed or cancelled downloads delete staging data and do not appear as installed. MVP retries restart the puzzle download rather than implementing resumable partial downloads.

No backend ZIP/bundle endpoint or workflow-generated archive is needed for the MVP.

## Local Persistence

Use app-private file storage as the source of truth:

```text
Documents/perseus/
  downloads/
  sessions/
    <puzzleId>.json
  completions/
    <runId>.json
  outbox/
    <runId>.json
  indexes/
    downloads.json
    sessions.json
```

Indexes are rebuildable caches only. If an index is absent or corrupt, reconstruct it from authoritative manifests/session files.

Use NativeScript `ApplicationSettings` only for small preferences such as last-opened section or sort order.

### Download removal vs progress removal

Keep these operations independent:

- **Remove Download** deletes local puzzle assets and manifest but keeps session progress.
- **Discard Progress** deletes the persisted gameplay session.

If the same stable puzzle ID is downloaded again later, valid retained progress can resume.

### Session persistence

Mobile uses the same persisted session schema and validation rules as web. Only the storage adapter differs.

Save after meaningful persisted state changes and at lifecycle boundaries, including placement attempts that change counters, accepted placements, undo/redo, rotation changes, tray organization changes, pause, app backgrounding, and leaving gameplay.

Session writes are small JSON replacements; avoid adding a complex debounce/write-behind system in the MVP.

Invalid or corrupt sessions are never partially hydrated. The shared codec rejects them and the mobile UI offers discard/start-over behavior.

## Gameplay UI

### Landscape

Landscape is the primary layout:

```text
+---------------------------------------------------------------+
| < Library    Puzzle Name       timer      Undo Redo Hint Ref ...|
+-----------------------------------------------+---------------+
|                                               | PIECES        |
|                                               | filters       |
|                 PUZZLE BOARD                  |               |
|                native Canvas                  | piece grid    |
|                                               |               |
|                                               |               |
+-----------------------------------------------+---------------+
```

The board gets most of the screen. The tray is a persistent right-side panel sized by simple adaptive proportions with a sensible minimum width. Do not add a draggable tray divider in the first mobile release.

### Portrait

Portrait keeps the board primary and moves the tray into a bottom panel/drawer. Expanding the tray changes the viewport size, not canonical puzzle coordinates.

### Board input

Both interaction methods feed one placement path in the gameplay view model:

- **Drag:** drag a tray piece over the board and release; screen coordinates are transformed into board coordinates and then to a candidate grid cell.
- **Tap:** tap a tray piece to select it, then tap a board cell to attempt placement.

Placement validity remains entirely owned by `PuzzleSession`.

Board gestures:

- pinch to zoom;
- two-finger drag to pan;
- double-tap to fit the puzzle to the viewport;
- one-finger drag on a piece is piece placement, not board panning.

Persist viewport zoom/pan using the session schema's existing optional viewport fields.

### Rendering boundary

Use a simple flow:

```text
PuzzleSession
   -> BoardViewModel
   -> Canvas renderer
```

The Canvas draws placed pieces, active/dragged piece, placement feedback, board/reference overlays, and transforms. Toolbar, tray, dialogs, library screens, and completion sheets stay normal Svelte Native UI.

### Rotation

Do not place a Rotate icon over every tray piece. When rotation is enabled, selecting a piece enables a single Rotate action in the tray/toolbar area. All rotation rules still dispatch through `PuzzleSession`.

### Toolbar

Keep frequent controls visible: Undo, Redo, Hint, Reference.

Place lower-frequency actions in one overflow menu: Fit Board, Rotation, Pause, Restart, Discard.

This is one concrete tablet toolbar, not a generic responsive-toolbar framework.

### Backgrounding

When the app resigns active/backgrounds:

1. checkpoint timer state;
2. persist the current session;
3. tell the session clock that the document/app is hidden so elapsed active time stops.

Returning to the app restores the active gameplay view without automatically showing an explicit Pause dialog. Explicit Pause remains a user action.

## Optional Mobile Authentication

The existing web authentication is browser-cookie based, so mobile should not try to reuse the OAuth redirect/cookie mechanics directly.

For the TestFlight MVP:

1. Native Google sign-in obtains a Google ID token.
2. Mobile sends it to a small API endpoint such as `POST /api/mobile/auth/google`.
3. The API reuses existing Google ID-token verification, allowlist checks, player upsert, and player-session creation.
4. The API returns the Perseus player session token, user, and expiry.
5. Mobile stores the Perseus token in native secure storage.

Protected API middleware should accept either the existing web session cookie or `Authorization: Bearer <session-token>`. Web behavior remains unchanged.

`/api/auth/session` and logout should gain equivalent bearer-token handling, or mobile-specific thin session/logout endpoints may wrap the same session service. Prefer the smaller change with one canonical token-validation path.

App Store release is out of scope. Sign in with Apple and provider-neutral account identity are deferred until App Store distribution is planned.

## Completion and Offline Outbox

Every completed run is recorded locally first.

- Logged out: completion stays local only.
- Signed in and online: record locally, then submit to the existing completion endpoint.
- Signed in and offline/network failure: record locally and create an outbox item.

Outbox records are intentionally small:

```ts
interface PendingCompletionV1 {
  schemaVersion: 1;
  puzzleId: string;
  runId: string;
  resultClass: ResultClass;
  elapsedActiveSeconds: number | null;
  accountId: string;
  createdAt: number;
}
```

On app activation/connectivity restoration, process pending items sequentially. Successful submissions remove the item. Retryable failures remain pending; terminal server failures mark the local completion as unsynced/failed and remove the outbox item.

Do not create outbox entries for runs completed while logged out. A later login must not retroactively assign anonymous runs to that account.

Outbox records remain tagged to the account active at completion time. Logging into another account must never submit another account's pending records.

The existing sealed completion/run ID remains the idempotency boundary for retries.

## Error Handling

- Interrupted download: remove staging folder; expose Retry.
- Corrupt/incomplete installed puzzle: hide/mark unavailable and offer Remove & Download Again.
- Corrupt session: reject through shared validator and offer discard/start over.
- Completion network failure: never block local completion; queue only when the run is account-associated.
- Missing server puzzle during completion sync: treat as terminal for server sync while preserving the local completion.

Avoid a generic error framework. Each service returns a small explicit result/error union appropriate to its caller.

## Testing

### Game-core

Move the existing deterministic tests with the extracted pure gameplay code. Unit coverage should pin placement rules, lifecycle, clock behavior, undo/redo, hints, rotation, inventory filtering, serialization, validation, and completion sealing.

These tests are the main parity guarantee between web and mobile.

### Mobile services

Run normal TypeScript tests for:

- download staging/finalization and cleanup;
- manifest validation;
- filesystem session adapter;
- index rebuilds;
- completion persistence;
- account-bound outbox behavior;
- retry/terminal completion handling;
- auth token persistence through a fake secure-store boundary.

Use temp directories and fakes; do not require an iOS simulator for pure service tests.

### iPad smoke coverage

Keep the first native UI smoke surface small:

1. launch app;
2. load gallery;
3. download a small fixture puzzle;
4. disable network;
5. start puzzle;
6. place pieces using drag and tap;
7. exercise zoom/pan;
8. background and restore;
9. kill/relaunch and resume;
10. complete offline and verify local completion state.

Do not block the MVP on reproducing the web Playwright suite in a native E2E framework. Add native UI automation when it proves reliable and cost-effective; keep a short TestFlight/manual smoke checklist until then.

## MVP Scope

### Included

- `apps/mobile` NativeScript + Svelte Native app.
- `packages/game-core` extraction.
- iPad-first layout with later Android-tablet-compatible core.
- Landscape-primary and portrait-supported gameplay.
- Public online gallery.
- Explicit downloads and Downloaded library.
- Fully offline gameplay for installed puzzles.
- Native Canvas board.
- Drag and tap placement.
- Zoom, pan, and fit.
- Timed and relaxed modes.
- Rotation, undo/redo, hints, reference modes.
- Existing tray filtering/shuffle/organization behavior represented by the shared session.
- Pause/resume and local saved progress.
- Completion summary and local completion history.
- File-backed persistence.
- Optional Google login for TestFlight/personal distribution.
- Account-bound completion outbox.

### Deferred

- Local-photo puzzle creation.
- Implicit caching/automatic downloads.
- Web/mobile session sync or cloud save.
- Android release polish.
- Phone-sized UI optimization.
- App Store release.
- Sign in with Apple.
- Provider-neutral account migration.
- Mobile puzzle upload.
- SQLite.
- Backend ZIP/download bundles.
- Background sync daemon.
- Push notifications.

## Delivery Strategy

Implement as a vertical slice rather than extracting every web gameplay file before proving NativeScript rendering:

```text
minimal game-core extraction
  -> NativeScript/Svelte Native shell
  -> small downloaded/fixture puzzle
  -> Canvas rendering
  -> tap + drag placement
  -> save
  -> terminate/relaunch
  -> offline resume
```

Once that path works, layer in remaining toolbar/session features, gallery/download management, portrait behavior, and finally optional account/outbox support.

The first implementation should remain one coherent PR/workstream unless the scope is deliberately decomposed into separate tracked tasks first. Avoid creating multiple PRs for one task merely to separate refactoring from mobile code.