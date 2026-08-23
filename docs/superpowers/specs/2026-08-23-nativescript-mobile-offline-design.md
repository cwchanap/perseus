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
- Preserve touch-oriented gameplay parity for the current shipped puzzle loop: timed/relaxed play, rotation, undo/redo, hints, reference modes, tray filters/shuffle, pause/resume, saved progress, and completion summary.
- Do not revive persisted manual tray organization in the mobile MVP. Existing optional organization fields may remain tolerated by the shared codec, but the mobile app does not expose or produce named trays, tray membership, renaming, or movement between trays.
- Optimize gameplay for landscape. Portrait support follows as a separate adaptive-tablet task rather than expanding the main landscape gameplay PR.
- Support both drag-and-drop and tap-piece/tap-cell placement.
- Optional Google login is included for TestFlight/personal distribution. App Store-specific Sign in with Apple and provider-neutral identity migration are deferred.
- Queue server completion submission only for runs completed while an account was already signed in.
- Signing in does not upload/download gameplay sessions or turn local saves into cloud saves in the MVP.

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

Keep the existing synchronous `SessionStorageAdapter` contract. The mobile adapter can use NativeScript's synchronous text-file APIs for the small session JSON records, avoiding a second async session abstraction. Network downloads and large binary asset writes remain asynchronous and are separate from session persistence.

A downloaded server puzzle remains `source: 'api'` in `PersistedPuzzleSessionV1`; download status describes local asset availability, not puzzle identity/origin. Do not add a new `downloaded` session source variant.

### Canvas feasibility gate

The highest-risk assumption is the NativeScript + Svelte Native + native-backed Canvas combination, not moving pure TypeScript files. The first implementation ticket must prove that stack before performing the game-core extraction.

The gate is deliberately small:

1. Scaffold `apps/mobile` with NativeScript + Svelte Native.
2. Build and launch on an iPad simulator/device.
3. Register the selected Canvas component.
4. Load and draw one real Perseus puzzle-piece PNG.
5. Receive tap and drag coordinates over the Canvas.
6. Redraw the piece after a simple transform/position change.

If this gate cannot be made reliable with the chosen stack, stop that ticket and revisit the rendering/UI choice before moving web gameplay code. Do not complete a speculative package extraction without a working native consumer.

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
```

Do not add a downloads/sessions index in the MVP. On launch or library refresh, derive the local library by scanning completed `downloads/*/manifest.json` packages and relevant session/completion files. Add an index only if measurement later shows directory scanning is a real problem.

Use NativeScript `ApplicationSettings` only for small preferences such as last-opened section or sort order.

### Download removal vs progress removal

Keep these operations independent:

- **Remove Download** deletes local puzzle assets and manifest but keeps session progress.
- **Discard Progress** deletes the persisted gameplay session.

If the same stable puzzle ID is downloaded again later, retained progress is revalidated against the freshly downloaded canonical piece/grid metadata before it can resume. A mismatched or invalid session is rejected rather than partially restored.

### Session persistence

Mobile uses the same persisted session schema and validation rules as web. Only the storage adapter differs.

Save after meaningful persisted state changes and at lifecycle boundaries, including placement attempts that change counters, accepted placements, undo/redo, rotation changes, filter/tray-order changes, pause, app backgrounding, and leaving gameplay.

Session writes are small JSON replacements; avoid adding a complex debounce/write-behind system in the MVP. Write through a temporary file and rename/replace it so an interrupted write cannot expose truncated JSON as the current save.

Invalid or corrupt sessions are never partially hydrated. The shared codec rejects them and the mobile UI offers discard/start-over behavior.

## Gameplay UI

### Landscape

Landscape is the primary gameplay target:

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

Portrait support is a separate follow-up after the landscape gameplay path is stable. It keeps the board primary and moves the tray into a bottom panel/drawer. Expanding the tray changes the viewport size, not canonical puzzle coordinates.

The portrait task owns orientation changes during an active session, viewport preservation across layout changes, portrait toolbar/overflow behavior, and a focused portrait smoke path. It must not fork gameplay rules or create a second board implementation.

### Board input

Both interaction methods feed one placement path in the gameplay view model:

- **Drag:** drag a tray piece over the board and release; screen coordinates are transformed into board coordinates and then to a candidate grid cell.
- **Tap:** tap a tray piece to select it, then tap a board cell to attempt placement.

Placement validity remains entirely owned by `PuzzleSession`.

Board gestures in the production landscape gameplay task:

- pinch to zoom;
- two-finger drag to pan;
- double-tap to fit the puzzle to the viewport;
- one-finger drag on a piece is piece placement, not board panning.

Persist viewport zoom/pan using the session schema's existing optional viewport fields.

The first vertical-slice ticket only proves basic tap/drag placement with a fixed or fit-only viewport. It does not need production pinch/pan gesture arbitration or polished placement animation.

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

### Tray behavior

Carry over only the proven simple inventory behavior:

- All / Corners / Edges / Center filters;
- shuffle of unplaced pieces;
- current selection and selected-piece Rotate action;
- remaining-piece count.

Do not add named/staging trays, manual grouping, multi-select, piece-to-tray membership, tray renaming/removal, or automatic clustering in the mobile MVP.

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

Authentication affects account completion submission only in the MVP. It does not synchronize downloaded assets, gameplay sessions, tray state, viewport state, or local completion history between devices.

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

Outbox records remain tagged to the account active at completion time. Logging out or switching accounts leaves those records untouched; they are eligible for submission only when that same account is authenticated again.

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
- filesystem session adapter and atomic replacement;
- direct filesystem library discovery;
- completion persistence;
- account-bound outbox behavior;
- retry/terminal completion handling;
- auth token persistence through a fake secure-store boundary.

Use temp directories and fakes; do not require an iOS simulator for pure service tests.

### iPad smoke coverage

Keep native UI smoke coverage small and aligned with the ticket boundary.

The first vertical slice proves: launch, draw a fixture, tap/drag placement, terminate/relaunch, and offline resume.

The landscape gameplay ticket extends that to: download a small puzzle, disable networking, start it, exercise zoom/pan/Fit, background/restore, complete offline, and verify local completion state.

The portrait task adds one focused orientation/portrait journey. Do not block the MVP on reproducing the web Playwright suite in a native E2E framework. Add native UI automation when it proves reliable and cost-effective; keep a short TestFlight/manual smoke checklist until then.

## MVP Scope

### Included

- `apps/mobile` NativeScript + Svelte Native app.
- `packages/game-core` extraction.
- iPad-first layout with later Android-tablet-compatible core.
- Landscape-primary gameplay plus a separate portrait/adaptive tablet follow-up.
- Public online gallery.
- Explicit downloads and Downloaded library.
- Fully offline gameplay for installed puzzles.
- Native Canvas board.
- Drag and tap placement.
- Zoom, pan, and fit.
- Timed and relaxed modes.
- Rotation, undo/redo, hints, reference modes.
- Existing simple tray filters and shuffle.
- Pause/resume and local saved progress.
- Completion summary and local completion history.
- File-backed persistence without a database or derived index.
- Optional Google login for TestFlight/personal distribution.
- Account-bound completion outbox.

### Deferred

- Local-photo puzzle creation.
- Implicit caching/automatic downloads.
- Manual/staging/named tray organization.
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

This document is the architecture-level design for the mobile work, not a request to land the entire app in one oversized PR. The roadmap uses five substantial Linear tickets. Each ticket gets one coherent PR; do not split a ticket into separate refactor/UI PRs unless the scope is explicitly redesigned first.

```text
HPA-1  Shared core + offline proof
   |
   v
HPA-2  Explicit downloads + offline library
   |
   v
HPA-3  Production landscape iPad gameplay parity
   |\
   | \
   v  v
HPA-46 Portrait/adaptive tablet UX     HPA-4 Optional account completion sync
```

HPA-1 through HPA-3 produce a usable landscape-first offline mobile MVP. HPA-46 completes the originally desired portrait/adaptive tablet support. HPA-4 is optional account functionality and may proceed independently of HPA-46 once HPA-3 is complete.

### HPA-1 — Shared core + offline vertical slice

Start with the Canvas feasibility gate. Only after it passes, prove the smallest end-to-end playable architecture:

```text
NativeScript/Svelte Native + Canvas feasibility
  -> minimal game-core extraction
  -> one local fixture/download-package-shaped puzzle
  -> Canvas rendering
  -> basic tap + drag placement
  -> filesystem session adapter
  -> save
  -> terminate/relaunch
  -> offline resume
```

The basic placement proof may use a fixed or fit-only viewport. Production pinch/pan, gesture conflict rules, polished snap/reject feedback, online gallery/downloads, full toolbar parity, portrait layout, and authentication belong to later tickets.

### HPA-2 — Explicit downloads + offline library

Build the downloadable offline product on the proven slice:

- public Gallery and explicit downloads using the existing API;
- atomic staging/finalization and local manifests;
- direct filesystem discovery of completed packages;
- remove-download/discard-progress behavior;
- corrupt/incomplete package handling;
- retained session revalidation after re-download.

Do not add a library index, resumable chunk downloader, ZIP endpoint, SQLite, or generic offline framework.

### HPA-3 — Production landscape iPad gameplay parity

Turn the offline library into the real landscape gameplay experience:

- production Canvas transforms and hit testing;
- pinch zoom, two-finger pan, Fit, drag and tap placement;
- landscape board + persistent right-side tray;
- timed/relaxed setup;
- rotation, undo/redo, hints, reference modes;
- All/Corners/Edges/Center filters and shuffle;
- viewport persistence, pause/resume, background lifecycle;
- restart/discard and completion sheet;
- representative offline completion smoke path.

Do not add portrait layout or manual tray organization in this PR.

### HPA-46 — Portrait and adaptive tablet UX

Add the second tablet layout without changing game rules:

- portrait bottom tray panel/drawer;
- orientation changes during an active session;
- viewport preservation across layout changes;
- portrait toolbar/overflow behavior;
- focused portrait smoke verification and small UX polish required by the adaptive layout.

Do not fork the board renderer, `PuzzleSession`, storage schema, or toolbar framework.

### HPA-4 — Optional account completion sync

Add only the account functionality required by the chosen TestFlight distribution:

- native Google sign-in;
- mobile token-exchange endpoint;
- bearer support through the existing player-session validation path;
- secure token storage/session/logout;
- account-bound completion outbox and retry-on-activation/connectivity behavior.

Do not add save sync, asset sync, Sign in with Apple, provider-neutral account migration, or a generic synchronization system.
