# Account Bookmarks — Implementation Plan

## Objective

Implement bounded, account-scoped puzzle-family bookmarks across web and NativeScript mobile using the existing D1 player data, KV family metadata, authenticated player router, web gallery, and mobile account/Library seams.

The product remains one feature delivered in one implementation PR. Tasks are ordered as phases inside that PR — the server contract lands first, then web and mobile build against it on the same branch:

- **Phase A:** shared/types/API + web + web E2E
- **Phase B:** mobile, built against the Phase A contract

Phase boundaries are internal review checkpoints, not separate PRs; nothing waits on a merge.

## Closed contracts before coding

- Bookmark identity is `PuzzleFamilySummary.id`, never a difficulty variant ID.
- D1 stores only `(playerId, familyId, createdAt)` per bookmark, plus the `family_deletion_tombstones` marker — no KV metadata is copied.
- D1 index name: `idx_player_bookmarks_player_created`.
- `MAX_PLAYER_BOOKMARKS = 200` lives in `@perseus/shared`.
- `listPlayerBookmarks` returns at most 200 `{ familyId, createdAt }` rows newest-first (`familyId` tiebreak).
- `addPlayerBookmark` owns idempotency, cap enforcement, and the deletion fence in one D1 batch and returns `added | existing | limit_reached | family_missing`.
- The deletion fence is the `family_deletion_tombstones` row (migration `0009`), not the `puzzle_families` ownership mirror — the mirror is best-effort on some publish paths, so its absence cannot prove deletion.
- `insertFamilyDeletionTombstone` runs at fence time in `ensureWorkerPuzzleDeletionFence`, before variant tombstones and KV/R2 teardown.
- `completeFamilyDeletionCleanup` atomically re-writes the tombstone, deletes the ownership row, and sweeps all of the family's `player_bookmarks` rows in one batch on every deletion completion path; idempotent under reaper retries. The tombstone is permanent.
- Public `GET /api/puzzle-families` stays unauthenticated and player-agnostic.
- `GET /api/player/bookmarks` returns `PlayerBookmarkListResponse = { families: PuzzleFamilySummary[] }`.
- Do not reuse `PuzzleFamilyListResponse`; it requires catalog pagination fields.
- `PUT /api/player/bookmarks/:familyId`:
  - malformed ID → 400 `bad_request`
  - valid missing/non-ready family → 404 `not_found`
  - deletion-fenced family → 404 `not_found` via the `family_missing` result
  - existing bookmark → idempotent success even at capacity
  - new bookmark at capacity → 409 `bookmark_limit_reached`
- PUT readiness uses direct `getFamily` + `status === 'ready'`; `resolveReadyFamiliesByIds` is GET-only. KV readiness can race family deletion, so the tombstone fence in the same D1 batch as the INSERT is authoritative.
- `DELETE` validates ID format but does not require the family to still exist in KV.
- Web bookmark load/mutation/account-transition logic has one owner: `apps/web/src/lib/stores/bookmarks.ts`.
- Bookmark mutations are non-optimistic and pending is tracked per family.
- `/bookmarks` is auth-aware and `prerender = false`.
- Web bookmark control uses the card’s bottom title row; top-left category and top-right progress stay unchanged.
- Mobile authenticated bookmark I/O stays in `App.svelte` because token/account epoch live there.
- Mobile state transitions/stale-epoch policy live in mandatory pure `library/bookmarkState.ts`.
- Playwright uses raw stateful `page.route` mocks and proves browser wiring only.
- D1 idempotency/isolation/capacity are proven in shared Miniflare tests.

# Phase A — Server Contract + Web

## Task 1 — Add bounded bookmark persistence in `@perseus/shared`

### Files

- `packages/shared/src/schema.ts`
- `packages/shared/src/bookmarks.ts` (new)
- `packages/shared/src/repositories.ts`
- shared export surface
- `packages/shared/drizzle/0008_player_bookmarks.sql`
- `packages/shared/drizzle/0009_family_deletion_tombstones.sql`
- `packages/shared/drizzle/meta/_journal.json`
- next Drizzle snapshots
- `packages/shared/src/__tests__/bookmarks.d1.test.ts` (new)
- `packages/shared/src/__tests__/schema.test.ts`
- reuse `packages/shared/src/__tests__/miniflare-d1.ts`

### Work

1. Add `playerBookmarks`:
   - `playerId TEXT NOT NULL`
   - `familyId TEXT NOT NULL`
   - `createdAt INTEGER NOT NULL`
   - composite PK `(playerId, familyId)`
   - `index('idx_player_bookmarks_player_created').on(playerId, createdAt)`
2. Add `familyDeletionTombstones` beside `puzzleDeletionTombstones`:
   - `familyId TEXT PRIMARY KEY`
   - `deletedAt INTEGER NOT NULL`
3. Add the additive migrations + journal/snapshot metadata (0008 and 0009).
4. Add:

```ts
export const MAX_PLAYER_BOOKMARKS = 200;
export type AddPlayerBookmarkResult = 'added' | 'existing' | 'limit_reached' | 'family_missing';
```

5. Add helpers:
   - `addPlayerBookmark(db, playerId, familyId, createdAt?)`
   - `removePlayerBookmark(db, playerId, familyId)`
   - `listPlayerBookmarks(db, playerId)`
6. `addPlayerBookmark` must enforce capacity and the deletion fence **inside the persistence operation**, not through route-level `count → insert` logic. One D1 batch:
   - INSERT ... SELECT gated on `COUNT(*) < MAX_PLAYER_BOOKMARKS AND NOT EXISTS (SELECT 1 FROM family_deletion_tombstones WHERE family_id = ...)`, with `onConflictDoNothing` on the PK,
   - read back the bookmark row and the tombstone row,
   - result ordering: `added` → `existing` (beats `family_missing` for a persisted row) → `family_missing` (beats `limit_reached` for a tombstoned family at the cap).
   - The fence is the tombstone, not the `puzzle_families` row — the ownership mirror is best-effort on some publish paths, so its absence cannot prove the family is deleted.
7. Re-PUT of an existing `(playerId, familyId)` remains successful at the cap.
8. `listPlayerBookmarks` orders newest-first (`familyId` desc tiebreak) and applies `.limit(MAX_PLAYER_BOOKMARKS)`.
9. `removePlayerBookmark` is idempotent.
10. Add tombstone helpers in `repositories.ts` next to the other family-deletion functions:
    - `insertFamilyDeletionTombstone(db, familyId, deletedAt)` — idempotent via `onConflictDoNothing`; written at deletion-fence time.
    - `completeFamilyDeletionCleanup(db, familyId, deletedAt?)` — one batch: tombstone upsert + `puzzle_families` ownership delete + `player_bookmarks` sweep by `familyId`. Idempotent under reaper retries.
11. Store no KV metadata in D1.

### `bookmarks.d1.test.ts`

Use the existing Miniflare D1 helper and prove:

- add then list,
- repeated add yields one row/result `existing`,
- newest-first order,
- remove/repeated remove,
- player isolation,
- the 200th distinct bookmark succeeds,
- the 201st distinct bookmark returns `limit_reached` and is absent,
- an existing bookmark still returns `existing` when already at 200,
- list never returns over `MAX_PLAYER_BOOKMARKS`,
- `family_missing` once the tombstone exists, with nothing written,
- persisted row prefers `existing` over `family_missing`,
- tombstoned family at the cap returns `family_missing`, not `limit_reached`,
- `completeFamilyDeletionCleanup` sweeps bookmark rows across players, deletes the ownership row, frees cap slots, and is idempotent,
- an insert landing after the fence/cleanup is refused.

### `schema.test.ts`

Update the existing migration test seam to:

- expect the latest journal entry/snapshot to be 0009,
- verify snapshot chaining from 0008,
- include `player_bookmarks` and `family_deletion_tombstones` in the expected table set,
- pin columns/composite PK/index for both new tables,
- add migration-0008 and migration-0009 additivity assertions that reject destructive table/index/trigger operations.

### Gate

Run focused shared tests before moving to API work.

## Task 2 — Extract ready-family resolution + typed bookmark response

### Files

- `apps/api/src/services/storage.worker.ts`
- relevant storage tests if present/needed
- `packages/types/src/puzzle-family.ts` or smallest appropriate existing contract module
- package type export surface
- type tests if the package has an existing validator test seam

### Work A — `resolveReadyFamiliesByIds`

Factor the existing `listFamiliesPage` family-resolution loop into:

```ts
export async function resolveReadyFamiliesByIds(
	kv: KVNamespace,
	familyIds: readonly string[]
): Promise<PuzzleFamilySummary[]>;
```

Contract:

1. `Promise.all` over input IDs.
2. `getFamily(kv, id)` for each.
3. return `null` for missing or non-ready families.
4. `enrichFamilySummary(kv, family)` for survivors.
5. filter nulls after the promise list so surviving input order is preserved.
6. no per-ID try/catch; corrupt KV metadata rejects as it does today.
7. refactor `listFamiliesPage` to reuse this helper for its page IDs rather than leaving two copies of the loop.

This helper is for GET/list resolution only.

### Work B — `PlayerBookmarkListResponse`

Add:

```ts
export interface PlayerBookmarkListResponse {
	families: PuzzleFamilySummary[];
}

export function isPlayerBookmarkListResponse(value: unknown): value is PlayerBookmarkListResponse;
```

The guard reuses `isPuzzleFamilySummary`.

Do not reuse `PuzzleFamilyListResponse`; bookmarks have no total/offset/limit/cursor contract.

### Tests

Pin:

- missing family skipped,
- non-ready family skipped,
- input order preserved,
- corrupt family metadata rejects,
- bookmark response guard accepts `{ families }`,
- malformed family entries are rejected.

## Task 3 — Add authenticated bookmark routes + deletion-fence wiring

### Files

- `apps/api/src/routes/player.worker.ts`
- `apps/api/src/routes/player.worker.test.ts`
- `apps/api/src/services/puzzle-deletion.worker.ts`
- `apps/api/src/services/__tests__/puzzle-deletion.worker.test.ts` + reaper/admin suites that mock `@perseus/shared`
- reuse `apps/api/src/routes/__tests__/helpers/family-fixtures.ts`

### Route work

Add:

- `GET /api/player/bookmarks`
- `PUT /api/player/bookmarks/:familyId`
- `DELETE /api/player/bookmarks/:familyId`

All reuse `requirePlayerAuth`, which already accepts web cookie sessions and mobile bearer tokens.

### GET

1. `listPlayerBookmarks(db, playerId)`.
2. `resolveReadyFamiliesByIds(kv, rows.map(row => row.familyId))`.
3. assemble `{ families } satisfies PlayerBookmarkListResponse`.
4. validate with `isPlayerBookmarkListResponse`; malformed server output → 500.

### PUT

1. `!isPuzzleId(familyId)` → 400.
2. direct `getFamily(c.env.PUZZLE_METADATA, familyId)`.
3. missing or `status !== 'ready'` → 404, matching family detail.
4. call `addPlayerBookmark`.
5. `added | existing` → success.
6. `family_missing` → the same 404 as the KV check; the tombstone fence in the D1 batch is authoritative over the KV readiness check, which can race stale KV or a check that ran before deletion was fenced.
7. `limit_reached` → `409 { error: 'bookmark_limit_reached', message: 'Maximum 200 bookmarks reached' }`.

Do not call `resolveReadyFamiliesByIds` for PUT.

### DELETE

1. malformed ID → 400.
2. call `removePlayerBookmark` without KV lookup.
3. repeated DELETE succeeds.

### Deletion-pipeline wiring

- `ensureWorkerPuzzleDeletionFence` calls `insertFamilyDeletionTombstone` right after `writeCleanupRecord` and before the per-variant `beginPuzzleDeletion` tombstones, so PUTs are refused for the whole deletion window.
- `completeWorkerPuzzleDeletion` calls `completeFamilyDeletionCleanup` first — one batch covering tombstone, ownership row, and bookmark sweep — so a racing PUT either commits first and is swept or lands after and is refused. This also covers deletion paths that never ran the fence.
- A cleanup throw surfaces as `step: 'finish'` (or fails the fence step) so reaper paths retry; both helpers are idempotent.

### Test-seam work

`player.worker.test.ts` mocks `@perseus/shared`, so extend that mock with bookmark helpers/results. Do not use this suite to claim real D1 duplicate/cap behavior.

For KV-dependent behavior:

- reuse `makeFamilyMetadata` from `routes/__tests__/helpers/family-fixtures.ts`,
- add a minimal in-test `KVNamespace` mock that supports the `get(..., 'json')` path used by `getFamily`, following the repository’s existing route-test mock style,
- include `PUZZLE_METADATA` in the test env for bookmark cases.

### Route tests

Prove:

- GET/PUT/DELETE require auth,
- malformed PUT/DELETE → 400,
- missing/non-ready PUT → 404,
- mocked `family_missing` → the same 404,
- ready PUT calls the repository helper,
- `existing` also succeeds,
- mocked `limit_reached` → 409/error code,
- GET returns typed enriched family summaries,
- GET skips missing/non-ready KV rows and preserves surviving order,
- corrupt KV metadata causes 500 rather than silent omission,
- DELETE/repeated DELETE route semantics succeed,
- deletion-pipeline tests prove the family tombstone is written at fence time and `completeFamilyDeletionCleanup` runs on every completion path (retried on failure).

Real duplicate-row/cap persistence remains Task 1 coverage only.

## Task 4 — Extend the web API client and add one bookmark store

### Files

- `apps/web/src/lib/services/api.ts`
- `apps/web/src/lib/services/api.test.ts`
- `apps/web/src/lib/stores/bookmarks.ts` (new)
- `apps/web/src/lib/stores/bookmarks.test.ts` (new)
- reuse/inject `apps/web/src/lib/stores/playerAuth.ts`

### API client

Add:

- `getPlayerBookmarks(signal?)`
- `bookmarkFamily(familyId)`
- `unbookmarkFamily(familyId)`

Rules:

- `credentials: 'include'`,
- URL-encode family IDs,
- GET validates `PlayerBookmarkListResponse`,
- preserve existing `ApiError` behavior including 409.

### Bookmark store

Follow the factory + singleton pattern from `playerAuth.ts`.

State owns:

- current account/owner identity,
- resolved `families`,
- derived `ids`,
- load status/error,
- per-family pending IDs,
- operation/version token for stale async rejection.

Expose the minimal surface:

- `subscribe`
- `load()`
- `toggle(family)`
- `clear()` if useful for tests/internal auth handling

Behavior:

1. Observe/inject `playerAuth` only to detect anonymous/account-switch state and clear old bookmark state.
2. Do not auto-fetch on every authenticated route.
3. Gallery and `/bookmarks` call `load()` only when they need data.
4. Repeated `load()` for an already-loaded same account is a no-op/deduped.
5. `toggle(family)` owns PUT/DELETE, per-family pending, success update, error isolation.
6. Add uses the passed `PuzzleFamilySummary`; no detail refetch.
7. Account switch/logout invalidates in-flight results.
8. 409 remains state/error feedback; prior membership is unchanged.

### Store tests

Unit-test once:

- authenticated load,
- load dedupe,
- anonymous does not fetch,
- bookmark success,
- unbookmark success,
- failed/409 mutation preserves prior membership,
- same family cannot double-submit while pending,
- different families can be pending independently,
- logout/account switch clears old state,
- stale old-account load/mutation result is ignored.

This replaces duplicated route-level mutation state/tests.

## Task 5 — Extend `PuzzleCard` and wire Gallery presentation

### Files

- `apps/web/src/lib/components/PuzzleCard.svelte`
- `apps/web/src/lib/components/PuzzleCard.svelte.test.ts`
- `apps/web/src/routes/+page.svelte`
- `apps/web/src/routes/page.svelte.test.ts`

### `PuzzleCard`

Add presentation props equivalent to:

- `bookmarked?: boolean`
- `bookmarkPending?: boolean`
- `onBookmarkToggle?: (family: PuzzleFamilySummary) => void`

Fixed layout:

- category stays top-left,
- progress stays top-right,
- bottom overlay becomes one title/action row,
- title flexes/truncates on the left,
- compact bookmark button sits bottom-right.

The bookmark button:

- has an accessible name for add/remove state,
- does not activate difficulty links,
- is disabled while pending.

### Gallery route

Gallery must not own bookmark network/mutation logic.

It:

1. observes `playerAuth` only to decide authenticated bookmark presentation,
2. calls `bookmarks.load()` when authenticated and the page needs bookmark data,
3. reads `ids/pending` from the bookmark store,
4. passes `toggle` to `PuzzleCard`,
5. leaves search/category/cursor/abort/version/progress-discovery logic untouched.

Loading more catalog rows uses the same already-loaded bookmark membership set.

### Gallery test blast radius

`page.svelte.test.ts` currently mocks `$lib/services/api` with an explicit allowlist and does not mock auth. After this change:

- keep its API mock focused on catalog functions (`fetchPuzzles`, etc.),
- add an explicit `$lib/stores/playerAuth` mock following `layout.svelte.test.ts`,
- add an explicit `$lib/stores/bookmarks` mock,
- test only Gallery presentation/integration with those stores.

Do **not** duplicate bookmark API mutation tests here; `bookmarks.test.ts` owns them.

### Tests

- card add/remove accessible states,
- callback receives family,
- pending disabled,
- difficulty links unaffected,
- authenticated Gallery loads/renders store membership,
- anonymous Gallery hides bookmark actions/does not request store load,
- newly appended infinite-scroll rows read current membership without a second network contract.

## Task 6 — Add `/bookmarks` and shell navigation

### Files

- `apps/web/src/routes/bookmarks/+page.svelte` (new)
- `apps/web/src/routes/bookmarks/+page.ts` (new)
- focused bookmarks route browser/unit test
- `apps/web/src/lib/components/ArcadeShell.svelte`
- `apps/web/src/routes/layout.svelte.test.ts`

### Static-adapter contract

Create:

```ts
export const prerender = false;
```

matching `/profile`.

### Page

The page is presentation over `playerAuth` + the shared bookmark store.

States:

- auth loading,
- anonymous/sign-in,
- bookmark loading,
- empty,
- populated,
- error.

Call `bookmarks.load()` when authenticated. Unbookmark uses the same store `toggle(family)` path as Gallery.

Do not implement a second pending set or second mutation handler.

### Shell

1. extend closed `ArcadeRoute` with `/bookmarks`,
2. add Bookmarks to the shared `navItems`,
3. update `layout.svelte.test.ts` for the nav item/active path.

There is no `ArcadeShell.svelte.test.ts` on current `main`; do not create one solely for this.

### Route tests

Mock `playerAuth` and `bookmarks` stores and cover presentation only:

- auth loading,
- anonymous,
- loading,
- empty,
- populated,
- store error,
- shared toggle called for removal,
- `prerender = false` contract.

## Task 7 — Add raw-route web E2E + accessibility coverage

### Files

- `apps/web/e2e/gallery.spec.ts`
- reuse `apps/web/e2e/support/accessibility.ts`

### Chosen E2E style

Stay in the existing Gallery raw-route style. Do **not** introduce `createAuthPersona`/`GameplayPage` diagnostics for this non-gameplay flow.

Install `page.route` handlers for:

- `GET /api/auth/session` → authenticated user,
- gallery catalog response,
- `GET /api/player/bookmarks`,
- `PUT /api/player/bookmarks/:familyId`,
- `DELETE /api/player/bookmarks/:familyId`.

The bookmark routes share an in-memory collection for the test lifetime.

### Scenario

1. open Gallery as authenticated,
2. bookmark one family,
3. navigate to `/bookmarks`,
4. assert the family appears,
5. reload,
6. assert mocked GET rehydrates it,
7. run `assertPageAccessible(..., { label: 'bookmarks' })` on the populated page/nav,
8. unbookmark,
9. assert it disappears.

This is browser wiring only. It does not prove D1 persistence.

### Phase A gate

Run the repo’s normal checks for touched packages, including:

- shared Miniflare tests,
- `schema.test.ts`,
- types checks/tests,
- API worker tests,
- web API/store/card/route/layout browser tests,
- bookmark Gallery Playwright flow,
- lint/format/type checks used by CI.

Mobile tasks (8–11) build against this server contract on the same branch; start them once the contract is settled here — no merge gate is required.

# Phase B — Mobile

## Task 8 — Extend the mobile player API boundary

### Files

- `apps/mobile/app/api/playerApi.ts`
- `apps/mobile/app/api/playerApi.test.ts`
- `apps/mobile/app/api/nativeHttp.ts` only where the method type requires it
- `apps/mobile/app/api/nativeHttp.test.ts` only if current tests pin method forwarding

### Work

1. Expand `PlayerHttpRequest.method` to `GET | POST | PUT | DELETE`.
2. Add:
   - `getBookmarks(token): Promise<PlayerBookmarkListResponse>`
   - `bookmarkFamily(familyId, token)`
   - `unbookmarkFamily(familyId, token)`
3. GET validates `isPlayerBookmarkListResponse`.
4. Reuse current bearer `Authorization` behavior.
5. Keep `nativePlayerHttpTransport` as a dumb `Http.request` pass-through.
6. Let non-2xx, including 409, follow existing `requireOk` behavior; App-level bookmark error state surfaces it.

### Tests

- GET path/header/response validation,
- PUT path/method/header,
- DELETE path/method/header,
- URL encoding,
- non-2xx behavior.

## Task 9 — Extract one reusable mobile `FamilyCard`

### Files

- `apps/mobile/app/library/FamilyCard.svelte` (new)
- `apps/mobile/app/library/Gallery.svelte`
- `apps/mobile/app/library/familyGallery.test.ts`

### Work

Move only one family’s existing Gallery rendering into `FamilyCard.svelte`:

- thumbnail,
- family title,
- Easy/Normal/Hard rows,
- per-variant ready/installed state,
- active download progress,
- download/cancel actions.

Add optional bookmark props/handler receiving `PuzzleFamilySummary`.

Use a title row with family title on the left and bookmark action on the right.

`Gallery.svelte` remains responsible for iteration, loading/error/empty/load-more state and passes the same existing family/install/download/progress/cancel inputs through.

Do not move download state ownership or create a generic list framework.

### Executable extraction gate

1. Gallery diff is only card extraction/wiring, not state ownership changes.
2. `familyGallery.test.ts` still passes difficulty-label and variant-ID tests.
3. `cd apps/mobile && bun run test:unit` passes.

No NativeScript UI test framework is added.

## Task 10 — Add mandatory pure mobile bookmark state

### Files

- `apps/mobile/app/library/bookmarkState.ts` (new)
- `apps/mobile/app/library/bookmarkState.test.ts` (new)

### Why mandatory

`App.svelte` already uses pure modules for account/session policy and completion scheduling. Bookmark state is also epoch-sensitive and must not become an untested inline branch in the NativeScript component.

### State/transition contract

Keep the module pure: no NativeScript, secure storage, HTTP, or Svelte component imports.

It should model the smallest state needed for:

- current bookmarked families,
- loading/error,
- per-family pending IDs,
- clear/reset,
- apply load result,
- apply add result,
- apply remove result,
- pending/error transitions,
- stale epoch rejection.

Every apply function that consumes an async result receives `requestEpoch` and `currentEpoch` (or an equivalent explicit guard) and returns the prior state unchanged when stale.

### Tests

Unconditionally pin:

- stale load ignored,
- stale add/remove ignored,
- account clear returns empty state,
- add inserts once,
- remove deletes only target family,
- pending is per-family,
- failure preserves previous family membership and records bookmark error.

## Task 11 — Wire mobile account I/O + Bookmarks section

### Files

- `apps/mobile/app/App.svelte`
- `apps/mobile/app/library/Library.svelte`
- `apps/mobile/app/library/Bookmarks.svelte` (new)
- `apps/mobile/app/app.css`

### Ownership rationale

`Library.svelte` already owns public Gallery fetch through injected `puzzleApi`, but authenticated bookmark fetch/mutations stay in `App.svelte` because that is where the bearer token, persisted session lifecycle, account identity, and `accountEpoch` already live.

Do not push secure-session/token ownership down into Library merely to resemble the public gallery fetch.

### `App.svelte`

1. own transient bookmark state from `bookmarkState.ts`,
2. load bookmarks only after a validated authenticated session is available,
3. capture `accountEpoch` at start of every bookmark fetch/mutation,
4. apply results through pure state transitions using captured/current epoch,
5. clear bookmark state on sign-out/account switch,
6. track pending per family,
7. successful PUT adds the already-rendered family summary; no detail refetch,
8. successful DELETE removes it,
9. bookmark failure touches bookmark error only; it must not clear account/download/completion state.

### `Library.svelte`

Receive only presentation state/handlers:

- signed-in/auth-ready state,
- `bookmarkedFamilies`,
- bookmark loading/error/pending,
- `onBookmarkToggle(family)`.

Insert `Bookmarks.svelte` between Gallery and Downloaded.

### `Bookmarks.svelte`

Reuse `FamilyCard` plus existing download/install state/handlers.

States:

- signed out: `Sign in below to use bookmarks.`,
- loading: activity indicator,
- empty: `No bookmarked puzzles yet.`,
- populated: newest-first family cards,
- bookmark-specific error.

No local bookmark file/cache/queue.

### Phase B gate

Run:

- `playerApi.test.ts`,
- `bookmarkState.test.ts`,
- `familyGallery.test.ts`,
- full `cd apps/mobile && bun run test:unit`,
- mobile TypeScript/build checks used by CI.

# Deliberate exclusions

Stop and reassess rather than silently expanding scope if implementation appears to require:

- generic favorites/reactions tables/APIs,
- anonymous/local bookmarks,
- offline bookmark queues/caches,
- bookmark pagination/search/folders/tags,
- session/save codec changes,
- downloaded-manifest changes,
- mobile routing/tab architecture,
- profile-style client N+1 family-detail enrichment for bookmarks,
- route-level duplicate web mutation state,
- optional/untested mobile epoch logic,
- a new OAuth/cookie E2E subsystem,
- refactoring web infinite-scroll/search architecture,
- refactoring mobile account/completion synchronization beyond narrow bookmark integration.

# Definition of done

The feature is complete when this PR lands and:

- bookmark persistence is player-isolated, idempotent, and bounded at 200,
- new over-cap PUT returns 409 while existing PUT stays idempotent,
- GET uses one ready-family resolver and a typed `PlayerBookmarkListResponse`,
- PUT uses direct family readiness semantics: 400 malformed / 404 missing-or-non-ready-or-deletion-fenced,
- family deletion writes a permanent `family_deletion_tombstones` row at fence time and atomically sweeps bookmark rows plus the ownership mirror in `completeFamilyDeletionCleanup`, so no bookmark PUT can land once deletion is fenced,
- web Gallery and `/bookmarks` share one bookmark store/mutation path,
- `/bookmarks` is `prerender = false` and Bookmarks is in shell navigation,
- raw-route Playwright proves Gallery → Bookmarks → reload → removal and reuses axe helpers,
- mobile Gallery and Bookmarks reuse one `FamilyCard`,
- mobile bookmark async results are guarded by mandatory pure epoch-tested state transitions,
- signed-out/offline mobile functionality remains usable,
- no non-goal subsystem was introduced.
