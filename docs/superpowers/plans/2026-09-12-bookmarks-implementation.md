# Account Bookmarks — Implementation Plan

## Objective

Implement account-scoped puzzle-family bookmarks across web and NativeScript mobile using the existing player-auth, D1, KV family metadata, gallery, and mobile Library seams.

This plan deliberately keeps bookmarks as one bounded vertical feature. It does not add a generic favorites framework, local bookmark persistence, new gameplay/session state, or a mobile navigation rewrite.

## Implementation constraints

- One implementation PR.
- D1 is the durable bookmark source of truth.
- KV remains authoritative for puzzle-family metadata.
- Bookmark identity is the puzzle family ID, not a variant ID.
- Web and mobile consume the same authenticated player endpoints.
- No backward-compatibility/migration layer beyond the additive D1 migration.
- Preserve existing gallery pagination/search behavior and mobile offline-library behavior.
- Keep unrelated refactors out of scope.

## Task 1 — Add bookmark persistence in `@perseus/shared`

### Files

- `packages/shared/src/schema.ts`
- `packages/shared/src/bookmarks.ts` (new)
- `packages/shared/src/index.ts` or current shared export surface
- `packages/shared/drizzle/0008_player_bookmarks.sql` (or next available migration number at implementation time)
- Drizzle migration metadata/snapshot files required by the repo
- Shared repository tests in the repo's existing D1/Miniflare test location

### Work

1. Add `playerBookmarks` to the Drizzle schema with:
   - `playerId`
   - `familyId`
   - `createdAt`
   - composite primary key `(playerId, familyId)`
   - player/created-at index for newest-first listing
2. Generate/add the additive SQL migration.
3. Add a focused bookmark repository module:
   - `addPlayerBookmark(db, playerId, familyId, createdAt?)`
   - `removePlayerBookmark(db, playerId, familyId)`
   - `listPlayerBookmarks(db, playerId)`
4. Make add conflict-ignore/idempotent.
5. Make remove a successful no-op when the row is absent.
6. Return only the data the API needs; do not duplicate KV family metadata in D1.

### Tests first

Add tests proving:

- adding then listing returns the family
- repeated add produces one row
- newest bookmark sorts first
- deleting removes the row
- repeated delete is harmless
- one player's bookmarks never leak into another player's list

### Completion gate

Run the focused shared tests and migration/type checks used by `packages/shared` before moving to API work.

## Task 2 — Add authenticated bookmark API endpoints

### Files

- `apps/api/src/routes/player.worker.ts`
- `apps/api/src/services/storage.worker.ts` only if a tiny reusable ready-family resolver is needed
- relevant API route tests
- `packages/types` only if a shared bookmark-list response validator/type is actually required by both clients

### Work

1. Add `GET /api/player/bookmarks` under the existing player router.
2. Add `PUT /api/player/bookmarks/:familyId`.
3. Add `DELETE /api/player/bookmarks/:familyId`.
4. Reuse `requirePlayerAuth` for every endpoint.
5. On PUT:
   - validate/decode `familyId`
   - look up the family in KV
   - require the family to exist and be ready
   - persist via `addPlayerBookmark`
6. On GET:
   - list bookmark rows newest-first
   - resolve each family from KV
   - reuse existing family-summary enrichment
   - skip missing/non-ready families
   - preserve surviving D1 order
7. On DELETE:
   - call the idempotent remove helper
   - do not require the family to still exist in KV
8. Keep the public `/api/puzzle-families` response unchanged.

### Tests first

Add route tests for:

- unauthenticated GET/PUT/DELETE rejected
- authenticated PUT of a ready family succeeds
- PUT of missing/non-ready family is rejected
- duplicate PUT remains one bookmark
- GET returns enriched `PuzzleFamilySummary` values
- GET preserves newest-first order
- stale/missing KV family is skipped
- DELETE removes a bookmark
- duplicate DELETE succeeds

### Completion gate

Run focused API tests before client work.

## Task 3 — Extend the web API client

### Files

- `apps/web/src/lib/services/api.ts`
- `apps/web/src/lib/services/api.test.ts`

### Work

Add:

- `getPlayerBookmarks(signal?)`
- `bookmarkFamily(familyId)`
- `unbookmarkFamily(familyId)`

All three use `credentials: 'include'`.

Do not add bookmark state to the public catalog API response.

### Tests first

Pin:

- exact paths
- GET/PUT/DELETE methods
- credentials
- family ID URL encoding
- response/error behavior consistent with neighboring player API helpers

## Task 4 — Add presentation-only bookmark behavior to web puzzle cards

### Files

- `apps/web/src/lib/components/PuzzleCard.svelte`
- `apps/web/src/lib/components/PuzzleCard.svelte.test.ts`

### Work

1. Add presentation props for:
   - current bookmark state
   - pending state
   - toggle callback
2. Add an accessible bookmark control to the card artwork/title area.
3. Keep category/progress badges readable; adjust layout only as needed to avoid overlap.
4. Stop bookmark interaction from activating difficulty navigation/card actions.
5. Disable repeated interaction while that family is pending.
6. Keep API/state ownership outside the component.

### Tests first

Cover:

- unbookmarked visual/accessibility state
- bookmarked state
- callback receives `family.id`
- pending control disabled
- difficulty links/click behavior unaffected

## Task 5 — Wire bookmarks into the web gallery

### Files

- `apps/web/src/routes/+page.svelte`
- relevant gallery route/component tests

### Work

1. Observe the existing `playerAuth` state.
2. When authenticated, fetch the full bookmark collection independently of catalog requests.
3. Derive a `Set<string>` of bookmarked family IDs.
4. Track pending mutations by family ID.
5. On toggle:
   - ignore if family already pending
   - call PUT/DELETE based on current membership
   - update the set only after success
   - clear pending state in `finally`
6. On logout/account transition:
   - clear bookmark UI state belonging to the old account
   - do not affect catalog/progress state
7. Keep search, category, infinite-scroll cursor, abort/version, and progress-discovery code unchanged except for passing bookmark props into cards.

### Tests first

Cover:

- authenticated load marks matching visible cards
- anonymous view issues no bookmark fetch
- successful bookmark updates the card
- successful unbookmark updates the card
- failed mutation leaves previous state intact
- loading more gallery rows does not require another bookmark fetch and newly rendered cards get correct membership

## Task 6 — Add the web Bookmarks page and navigation

### Files

- `apps/web/src/routes/bookmarks/+page.svelte` (new)
- route tests for bookmarks
- `apps/web/src/lib/components/ArcadeShell.svelte`
- ArcadeShell tests if present

### Work

1. Add `/bookmarks` to the shell route union and nav entries.
2. Build the page from the authenticated player bookmark endpoint.
3. Reuse `PuzzleCard`.
4. Implement states for:
   - auth loading
   - anonymous/sign-in
   - bookmark loading
   - empty
   - populated
   - error/retry if neighboring route style supports retry
5. Track pending mutations per family.
6. After successful unbookmark, remove the family from the displayed list.
7. Do not add search/filter/pagination UI.

### Tests first

Cover all route states plus successful removal and mutation failure.

## Task 7 — Extend the mobile player API boundary

### Files

- `apps/mobile/app/api/playerApi.ts`
- `apps/mobile/app/api/playerApi.test.ts`
- `apps/mobile/app/api/nativeHttp.ts` only where its request type requires the expanded method union
- `apps/mobile/app/api/nativeHttp.test.ts` if needed by the method change

### Work

1. Expand `PlayerHttpRequest.method` from `GET | POST` to include `PUT | DELETE`.
2. Add:
   - `getBookmarks(token)`
   - `bookmarkFamily(familyId, token)`
   - `unbookmarkFamily(familyId, token)`
3. Use the existing bearer Authorization contract.
4. Keep `nativePlayerHttpTransport` as a dumb `Http.request` pass-through.
5. Reuse the shared bookmark response type/guard only if Task 2 introduced one.

### Tests first

Pin:

- GET path + bearer header
- PUT path/method + bearer header
- DELETE path/method + bearer header
- family ID URL encoding
- non-2xx behavior
- response validation for GET if a guard exists

## Task 8 — Extract a reusable mobile family card

### Files

- `apps/mobile/app/library/FamilyCard.svelte` (new)
- `apps/mobile/app/library/Gallery.svelte`
- relevant mobile unit/component tests where supported

### Work

1. Move one family's current Gallery rendering into `FamilyCard.svelte`:
   - thumbnail
   - family title
   - Easy/Normal/Hard rows
   - download progress
   - installed/unavailable state
   - download/cancel handlers
2. Add optional bookmark props/handler to the extracted card.
3. Render the bookmark control only when an authenticated bookmark handler/state is supplied.
4. Keep all download behavior semantically identical to the current Gallery.
5. Replace the Gallery inline markup with `FamilyCard` usage.

### Completion gate

Before adding the Bookmarks section, confirm Gallery still behaves identically for downloading/installed state/load-more.

## Task 9 — Add mobile bookmark state and Bookmarks section

### Files

- `apps/mobile/app/App.svelte`
- `apps/mobile/app/library/Library.svelte`
- `apps/mobile/app/library/Bookmarks.svelte` (new)
- optionally one small pure helper/test file if needed to make account-switch/stale-result rules testable
- `apps/mobile/app/app.css`

### Ownership

Keep account/token ownership in `App.svelte`, where the mobile session already lives. Pass the minimum bookmark state/handlers needed into `Library`.

A suitable shape is:

- `bookmarkedFamilies`
- `bookmarkLoading`
- `bookmarkError`
- `bookmarkPendingIds`
- `onBookmarkToggle(familyId)`
- enough auth state for Library to decide signed-in vs signed-out presentation

Do not make `Library` discover/read the secure session itself.

### Work

1. Load bookmarks when a validated authenticated mobile session is available.
2. Clear old bookmark state on sign-out/account change.
3. Prevent stale async bookmark results from applying after `accountEpoch` changes.
4. Track pending mutations per family ID.
5. On successful PUT:
   - update transient bookmark collection
6. On successful DELETE:
   - remove family from transient bookmark collection
7. A bookmark request failure only sets bookmark-specific error state; it does not block Library boot or downloads.
8. Insert `Bookmarks.svelte` between `Gallery` and `Downloaded`.
9. `Bookmarks.svelte` reuses `FamilyCard` and receives the existing install/download state so bookmarked families can download variants normally.
10. Signed out: show `Sign in below to use bookmarks.` and hide Gallery bookmark controls.
11. Authenticated empty: show `No bookmarked puzzles yet.`
12. No offline queue/cache is created.

### Tests first

Prefer pure tests around account identity/stale-result transitions if state is extracted. At minimum pin the logic that:

- a result from an old account epoch is ignored
- sign-out clears bookmark UI state
- a failed bookmark request does not clear downloads/account state
- successful add/remove updates the collection once

Keep NativeScript component logic thin enough that lack of full native UI E2E coverage is not a blocker.

## Task 10 — Add end-to-end web coverage and run the regression suite

### Files

- `apps/web/e2e/gallery.spec.ts`
- existing auth/fixture support only where needed

### E2E scenario

1. Start as a signed-in player.
2. Open the gallery.
3. Bookmark a family.
4. Navigate to Bookmarks.
5. Assert the family appears.
6. Reload and assert it still appears.
7. Unbookmark it.
8. Assert it disappears.

Reuse existing E2E fixtures and auth setup. Do not introduce a separate bookmark fixture subsystem unless the current helpers cannot express the scenario.

### Final verification

Run the repo's focused/full commands appropriate to touched packages, including at least:

- formatting/lint/type checks for changed packages
- shared tests
- API tests
- web unit tests
- mobile unit tests
- web Playwright E2E for the bookmark flow

If the repo's normal top-level CI commands are affordable locally, run those before marking the implementation PR ready.

## Suggested implementation order

Use the tasks above sequentially because each step creates a tested seam for the next:

1. D1/shared persistence
2. API contract
3. web API client
4. web card
5. web gallery
6. web bookmarks route/nav
7. mobile API client
8. mobile family-card extraction
9. mobile bookmark state/section
10. E2E + full regression

This order avoids building UI against an unstable contract and makes it possible to keep every intermediate commit/test slice coherent.

## Expected touched surface

### Shared/backend

- one additive D1 migration
- one small shared bookmark repository module
- one schema/export update
- one existing API route module
- focused tests

### Web

- one API service module
- `PuzzleCard`
- gallery route
- one new `/bookmarks` route
- shell navigation
- tests/E2E

### Mobile

- existing player API boundary
- one extracted family-card component
- one new bookmarks section component
- `Library.svelte`
- `App.svelte` transient account bookmark state
- small style/test updates

## Deliberate exclusions during implementation

If any of these appear necessary, stop and reassess instead of silently expanding scope:

- generic favorite/reaction tables or APIs
- anonymous/local bookmarks
- local mobile bookmark persistence or sync queues
- bookmark pagination/search/folders/tags
- changes to puzzle session/save codecs
- changes to downloaded manifest format
- mobile routing/tab/navigation framework work
- refactoring the web gallery's existing infinite-scroll/search architecture
- refactoring mobile account/completion synchronization beyond the minimum bookmark integration

## Definition of done

The implementation PR is ready when:

- bookmarks persist by account in D1
- server endpoints are authenticated and idempotent
- family metadata is resolved from KV rather than duplicated
- web gallery can bookmark/unbookmark
- `/bookmarks` lists the complete collection
- mobile Gallery can bookmark/unbookmark while signed in
- mobile Bookmarks section shows the same cross-device collection
- bookmarked mobile families retain normal per-difficulty download controls
- signed-out/offline behavior remains usable
- stale account transitions cannot apply another account's bookmark result
- focused unit/API/E2E coverage passes
- no non-goal subsystem was introduced
