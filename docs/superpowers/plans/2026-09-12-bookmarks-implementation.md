# Account Bookmarks — Implementation Plan

## Objective

Implement account-scoped puzzle-family bookmarks across web and NativeScript mobile using the existing D1 player data, KV family metadata, authenticated player router, web gallery, and mobile Library seams.

Keep this as one bounded vertical feature. Do not add a generic favorites framework, local bookmark persistence, bookmark pagination, gameplay/session state, or a new mobile navigation system.

## Closed contracts before coding

These decisions are fixed for this PR:

- Bookmark identity is `PuzzleFamilySummary.id`, never a difficulty variant ID.
- D1 stores only `(playerId, familyId, createdAt)`.
- D1 bookmark index name is `idx_player_bookmarks_player_created`, matching existing `idx_*` schema naming.
- `listPlayerBookmarks` returns `{ familyId, createdAt }[]` newest-first.
- Public `GET /api/puzzle-families` stays unauthenticated and player-agnostic.
- `GET /api/player/bookmarks` returns `PlayerBookmarkListResponse = { families: PuzzleFamilySummary[] }`.
- Do not reuse `PuzzleFamilyListResponse`; it requires catalog pagination fields.
- `PUT /api/player/bookmarks/:familyId`:
  - malformed `isPuzzleId` → 400 `bad_request`
  - valid but missing/non-ready family → 404 `not_found`
  - ready family → idempotent success
- `DELETE` validates ID format but does not require the family to still exist in KV.
- Bookmark mutations are non-optimistic and pending is tracked per family.
- `/bookmarks` is a dedicated auth-gated route with `prerender = false`.
- Mobile bookmark state lives in `App.svelte` beside `accountEpoch`.
- Playwright uses stateful mocked bookmark routes; D1 persistence is tested in shared/API worker tests.

## Task 1 — Add D1 bookmark persistence

### Files

- `packages/shared/src/schema.ts`
- `packages/shared/src/bookmarks.ts` (new)
- shared export surface
- `packages/shared/drizzle/0008_player_bookmarks.sql` or the next free migration number at implementation time
- required Drizzle metadata/snapshot files
- existing shared/Miniflare repository tests

### Work

1. Add `playerBookmarks`:
   - `playerId TEXT NOT NULL`
   - `familyId TEXT NOT NULL`
   - `createdAt INTEGER NOT NULL`
   - composite PK `(playerId, familyId)`
   - `index('idx_player_bookmarks_player_created').on(playerId, createdAt)`
2. Add the additive migration.
3. Add focused helpers:
   - `addPlayerBookmark(db, playerId, familyId, createdAt?)`
   - `removePlayerBookmark(db, playerId, familyId)`
   - `listPlayerBookmarks(db, playerId)`
4. `addPlayerBookmark` uses `onConflictDoNothing`, following the repository's existing idempotent-insert style.
5. `removePlayerBookmark` is a no-op when absent.
6. `listPlayerBookmarks` returns only `{ familyId, createdAt }[]`, newest-first.
7. Do not duplicate KV family metadata in D1.

### Tests first

Prove:

- add then list,
- repeated add gives one row,
- newest-first order,
- remove,
- repeated remove harmless,
- player isolation.

### Gate

Run the focused shared/Miniflare tests and migration/type checks before API work.

## Task 2 — Add ready-family resolution reuse and typed response contract

### Files

- `apps/api/src/services/storage.worker.ts`
- `packages/types/src/puzzle-family.ts` or the smallest existing player/family contract module
- `packages/types/src/index.ts`/current export surface as needed
- focused type/storage tests if the repo has a matching seam

### Work A — `resolveReadyFamiliesByIds`

Add next to `listFamiliesPage`:

```ts
export async function resolveReadyFamiliesByIds(
	kv: KVNamespace,
	familyIds: readonly string[]
): Promise<PuzzleFamilySummary[]>
```

Implementation contract:

1. `Promise.all` over the input IDs.
2. `getFamily(kv, id)` for each.
3. return `null` for missing or non-`ready` families.
4. `enrichFamilySummary(kv, family)` for survivors.
5. filter nulls after `Promise.all` so surviving results preserve input order.
6. do not add per-ID try/catch; corrupt `getFamily` data should reject the request exactly as catalog code does today.

This is the shared operation bookmark GET needs. Do not reproduce the same loop in `player.worker.ts`.

### Work B — bookmark list response

Add:

```ts
export interface PlayerBookmarkListResponse {
	families: PuzzleFamilySummary[];
}

export function isPlayerBookmarkListResponse(
	value: unknown
): value is PlayerBookmarkListResponse
```

The guard reuses `isPuzzleFamilySummary` for every family.

Do not reuse `PuzzleFamilyListResponse`; bookmarks intentionally have no `total`, `offset`, `limit`, or cursor fields.

### Tests/gate

Pin:

- resolver skips missing families,
- resolver skips non-ready families,
- resolver preserves input order,
- corrupt family metadata rejects instead of being silently skipped,
- bookmark response guard accepts `{ families }` and rejects malformed summaries/catalog-shape drift.

## Task 3 — Add authenticated bookmark routes

### Files

- `apps/api/src/routes/player.worker.ts`
- existing API worker route tests

### Work

Add to the existing player router:

- `GET /api/player/bookmarks`
- `PUT /api/player/bookmarks/:familyId`
- `DELETE /api/player/bookmarks/:familyId`

Reuse `requirePlayerAuth` for all three; it already accepts web cookie sessions and mobile bearer tokens.

### GET

1. Read D1 rows via `listPlayerBookmarks`.
2. Pass row family IDs to `resolveReadyFamiliesByIds`.
3. Assemble `{ families } satisfies PlayerBookmarkListResponse`.
4. Validate with `isPlayerBookmarkListResponse`; malformed server output is 500.
5. Return newest-first survivors.

No route-local get/enrich loop.

### PUT

1. Read `familyId` from params.
2. `!isPuzzleId(familyId)` → 400 `bad_request` with the same family-ID semantics as family detail.
3. Resolve readiness using the shared ready-family resolution path (one ID is fine) or the exact same `getFamily` + `status === 'ready'` predicate if that avoids unnecessary response construction.
4. Missing/non-ready → 404 `not_found` with the same semantics as `GET /api/puzzle-families/:familyId`.
5. Insert via `addPlayerBookmark`.
6. Return success; duplicate PUT stays successful.

Do not invent 409/422 or a second status policy.

### DELETE

1. malformed ID → 400 `bad_request`.
2. remove D1 row without requiring KV existence/readiness.
3. duplicate DELETE succeeds.

### Tests first

Prove:

- unauthenticated GET/PUT/DELETE → 401,
- malformed PUT/DELETE ID → 400,
- valid missing/non-ready PUT → 404,
- ready PUT succeeds,
- duplicate PUT stays one D1 row,
- GET returns `PlayerBookmarkListResponse`,
- GET skip/order behavior goes through shared resolver,
- corrupt family metadata causes request failure rather than silent omission,
- DELETE and duplicate DELETE succeed.

### Gate

Run focused API worker tests before client work.

## Task 4 — Extend web API client and `PuzzleCard`

### Files

- `apps/web/src/lib/services/api.ts`
- `apps/web/src/lib/services/api.test.ts`
- `apps/web/src/lib/components/PuzzleCard.svelte`
- `apps/web/src/lib/components/PuzzleCard.svelte.test.ts`

### API client work

Add:

- `getPlayerBookmarks(signal?)`
- `bookmarkFamily(familyId)`
- `unbookmarkFamily(familyId)`

Rules:

- use `credentials: 'include'`,
- GET validates/parses `PlayerBookmarkListResponse`,
- URL-encode family IDs,
- do not alter public catalog calls.

### Card work

Add presentation-only props equivalent to:

- `bookmarked?: boolean`
- `bookmarkPending?: boolean`
- `onBookmarkToggle?: (family: PuzzleFamilySummary) => void`

Use the family object rather than only the ID so callers can add the already-rendered summary to transient bookmark state without refetching family detail.

Bookmark UI must:

- be accessible,
- avoid category/progress badge collisions,
- not activate difficulty links,
- disable repeated taps while pending.

### Tests first

API:

- exact paths/methods,
- credentials,
- URL encoding,
- GET response validation.

Card:

- unbookmarked/bookmarked state,
- callback receives the family,
- pending disables interaction,
- difficulty links remain functional.

## Task 5 — Wire bookmarks into the web gallery

### Files

- `apps/web/src/routes/+page.svelte`
- `apps/web/src/routes/page.svelte.test.ts` and/or the existing gallery route test seam

### Work

1. When `playerAuth` becomes authenticated, fetch bookmark GET once independently from catalog requests.
2. Keep the resolved family list only as needed for mutation updates and derive a `Set<string>` for card membership.
3. Track pending IDs per family.
4. On bookmark:
   - call PUT,
   - after success add the card's existing `PuzzleFamilySummary` to transient bookmark state,
   - update membership.
5. On unbookmark:
   - call DELETE,
   - after success remove from transient state.
6. Failed mutation leaves prior state intact.
7. On account/logout transition, clear old bookmark state.
8. Do not refactor search/category/cursor/abort/version/progress-discovery code.
9. Loading more catalog rows reuses the existing bookmark set; no second GET is required.

### Tests first

Cover:

- authenticated bookmark load marks matching visible cards,
- anonymous view issues no bookmark GET,
- add/remove success,
- mutation failure keeps prior state,
- newly loaded infinite-scroll rows read correct membership without another bookmark GET.

## Task 6 — Add `/bookmarks` and shell navigation

### Files

- `apps/web/src/routes/bookmarks/+page.svelte` (new)
- `apps/web/src/routes/bookmarks/+page.ts` (new)
- bookmark route unit/browser test file using the repo's normal route-test style
- `apps/web/src/lib/components/ArcadeShell.svelte`
- `apps/web/src/routes/layout.svelte.test.ts`

### Static-adapter contract

Create:

```ts
// apps/web/src/routes/bookmarks/+page.ts
export const prerender = false;
```

This is required, matching `/profile`; do not leave `/bookmarks` to static prerendering.

### Page work

Reuse `PuzzleCard` and the player bookmark endpoint. Support:

- auth loading,
- anonymous/sign-in,
- bookmark loading,
- empty,
- populated,
- request error.

Track pending by family. Successful DELETE removes the card only after server success.

Do not add search/filter/sort/pagination.

### Shell work

1. Extend closed `ArcadeRoute` with `/bookmarks`.
2. Add the Bookmarks nav item to the existing shared `navItems` array.
3. Update `apps/web/src/routes/layout.svelte.test.ts` to pin the new nav item in the existing desktop/mobile shell seam.

Current `main` does not have a separate `ArcadeShell.svelte.test.ts`; do not create one just to satisfy this feature.

### Tests first

Cover page states, successful/failed unbookmark, `prerender = false`, and nav visibility/active behavior as appropriate to the current layout tests.

## Task 7 — Extend the mobile player API boundary

### Files

- `apps/mobile/app/api/playerApi.ts`
- `apps/mobile/app/api/playerApi.test.ts`
- `apps/mobile/app/api/nativeHttp.ts` only where the request method type requires it
- `apps/mobile/app/api/nativeHttp.test.ts` only if current tests pin the allowed method surface

### Work

1. Expand `PlayerHttpRequest.method` to `GET | POST | PUT | DELETE`.
2. Add:
   - `getBookmarks(token): Promise<PlayerBookmarkListResponse>`
   - `bookmarkFamily(familyId, token)`
   - `unbookmarkFamily(familyId, token)`
3. GET runtime-validates with `isPlayerBookmarkListResponse`.
4. Reuse current bearer Authorization behavior.
5. Keep `nativePlayerHttpTransport` a dumb `Http.request` pass-through.

### Tests first

Pin:

- GET path/header/response validation,
- PUT path/method/header,
- DELETE path/method/header,
- URL encoding,
- non-2xx behavior.

## Task 8 — Extract one reusable mobile `FamilyCard`

### Files

- `apps/mobile/app/library/FamilyCard.svelte` (new)
- `apps/mobile/app/library/Gallery.svelte`
- `apps/mobile/app/library/familyGallery.test.ts`

### Work

Move only one family's existing rendering into `FamilyCard.svelte`:

- thumbnail,
- family title,
- Easy/Normal/Hard rows,
- per-variant ready/installed state,
- active download progress,
- download/cancel actions.

Add optional bookmark presentation/handler props. The bookmark callback receives the `PuzzleFamilySummary`.

`Gallery.svelte` remains responsible for iteration, loading/error/empty/load-more state and passes the same family/install/download/progress/cancel inputs through to `FamilyCard`.

Do not extract a list framework or move download state ownership.

### Executable completion gate

This extraction is complete only when:

1. the `Gallery.svelte` diff shows the existing card logic replaced by `FamilyCard` calls without changing Gallery state ownership or download handler semantics,
2. `familyGallery.test.ts` still pins difficulty labels and variant-ID selection,
3. `cd apps/mobile && bun run test:unit` passes.

There is no NativeScript Gallery UI test seam today; do not write a vague “confirm behavior” gate and do not introduce a new native UI framework for this extraction.

## Task 9 — Add mobile bookmark state and Bookmarks section

### Files

- `apps/mobile/app/App.svelte`
- `apps/mobile/app/library/Library.svelte`
- `apps/mobile/app/library/Bookmarks.svelte` (new)
- `apps/mobile/app/app.css`
- optionally `apps/mobile/app/library/bookmarkState.ts` + test if extracting pure epoch/state transitions keeps `App.svelte` smaller and testable

### Ownership

`App.svelte` owns:

- active token/session,
- account identity/epoch,
- bookmark fetch/mutation calls,
- transient bookmarked families,
- bookmark loading/error/pending state.

`Library.svelte` receives presentation state/handlers. It must not read secure session storage itself.

Suggested props/state:

- `bookmarkedFamilies`
- `bookmarkLoading`
- `bookmarkError`
- `bookmarkPendingIds`
- `onBookmarkToggle(family: PuzzleFamilySummary)`
- signed-in/auth-ready state

### Work

1. Load bookmarks only after a validated authenticated session is available.
2. Capture `accountEpoch` when starting bookmark work.
3. Ignore fetch/mutation results when the epoch changed before application.
4. Clear bookmark state on sign-out/account switch.
5. Track mutation pending by family ID.
6. Successful PUT adds the already-present family summary to transient state; no family-detail refetch.
7. Successful DELETE removes the family.
8. Bookmark transport/server errors update bookmark-specific error only.
9. Insert `<Bookmarks>` between Gallery and Downloaded.
10. Reuse `FamilyCard` so bookmarked families retain normal per-difficulty download/install behavior.
11. Signed out: hide Gallery bookmark actions and show `Sign in below to use bookmarks.`
12. Authenticated empty: `No bookmarked puzzles yet.`
13. No local bookmark file/cache/queue.

### Tests first

If a tiny pure helper is extracted, pin:

- stale epoch result ignored,
- sign-out/account switch clears bookmark state,
- add inserts exactly once,
- remove deletes the right family,
- bookmark failure does not touch account/download state.

Also keep `playerApi.test.ts` and the full mobile unit suite green.

## Task 10 — Web E2E and final regression

### Files

- `apps/web/e2e/gallery.spec.ts` or one focused bookmarks E2E file if that is clearer
- existing auth-persona/fixture support only by reuse; do not create a new OAuth/cookie system

### E2E fixture contract

`createAuthPersona('authenticated')` only mocks `GET /api/auth/session`; it does not create a real player cookie/token. Therefore the test must mock bookmark player endpoints too.

Install a stateful in-memory Playwright route for:

- `GET /api/player/bookmarks`
- `PUT /api/player/bookmarks/:familyId`
- `DELETE /api/player/bookmarks/:familyId`

The route keeps an in-memory bookmarked-family collection for the duration of the test/page context and returns the real `PlayerBookmarkListResponse` shape.

Reuse existing mocked catalog family data. Do not call the real player backend from this browser test.

### E2E scenario

1. install authenticated session persona,
2. install catalog mocks,
3. install stateful bookmark route mocks,
4. open Gallery,
5. bookmark a family,
6. navigate to `/bookmarks`,
7. assert it appears,
8. reload,
9. assert GET rehydrates it from the route's in-memory state,
10. unbookmark,
11. assert it disappears.

This verifies browser client wiring and reload behavior. It does **not** claim to prove D1 persistence; Task 1/3 worker tests own that proof.

### Final verification

Run the repo's normal focused/full checks for touched packages, including at least:

- shared/Miniflare tests,
- API worker tests,
- `@perseus/types` tests/type checks,
- web unit/browser tests,
- mobile `bun run test:unit`,
- bookmark Playwright flow,
- lint/format/type checks used by CI.

## Suggested implementation order

1. D1/shared persistence
2. ready-family resolver + typed response
3. player API routes
4. web API/card
5. web gallery
6. `/bookmarks` + prerender/nav
7. mobile API
8. mobile `FamilyCard` extraction
9. mobile bookmark state/section
10. mocked E2E + regression

Each step should leave a tested seam for the next; do not build both clients against an unpinned server contract.

## Expected touched surface

### Shared/types/backend

- one additive D1 table/migration
- one narrow bookmark repository module
- one narrow ready-family resolver in existing storage service
- one small shared response interface/guard
- three routes in the existing player router
- focused worker/repository tests

### Web

- existing API client
- `PuzzleCard`
- gallery route
- new `/bookmarks/+page.svelte`
- new `/bookmarks/+page.ts`
- ArcadeShell route/nav update
- existing `layout.svelte.test.ts`
- focused route/card/API/E2E coverage

### Mobile

- existing `playerApi`
- one `FamilyCard` extraction
- one `Bookmarks` section
- transient bookmark state in `App.svelte`
- `Library.svelte` wiring
- focused pure/API tests

## Deliberate exclusions

Stop and reassess rather than silently expanding scope if implementation appears to require:

- generic favorites/reactions tables or APIs,
- anonymous/local bookmarks,
- offline bookmark queues/caches,
- bookmark pagination/search/folders/tags,
- session/save codec changes,
- downloaded-manifest changes,
- mobile routing/tab architecture,
- profile-style client N+1 family-detail enrichment for bookmarks,
- a new OAuth/cookie Playwright subsystem,
- refactoring web infinite-scroll/search architecture,
- refactoring mobile account/completion synchronization beyond narrow bookmark integration.

## Definition of done

The implementation PR is ready when:

- D1 bookmark add/remove/list is idempotent and player-isolated,
- API uses one ready-family resolver and returns typed `PlayerBookmarkListResponse`,
- PUT semantics are pinned at 400 malformed / 404 missing-or-non-ready,
- web Gallery can add/remove bookmarks without changing catalog pagination behavior,
- `/bookmarks` is `prerender = false` and lists the full collection,
- Bookmarks is present in existing ArcadeShell/layout nav tests,
- mobile Gallery can add/remove bookmarks while authenticated,
- mobile Bookmarks reuses `FamilyCard` and normal download behavior,
- stale mobile account epochs cannot apply old bookmark results,
- Playwright uses stateful mocked bookmark endpoints rather than pretending to test D1,
- shared/API/web/mobile/E2E checks pass,
- no non-goal subsystem was introduced.
