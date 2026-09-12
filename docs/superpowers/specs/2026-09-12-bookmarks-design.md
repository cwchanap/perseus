# Account Bookmarks — Design Spec

## Summary

Add account-scoped puzzle-family bookmarks across the web and NativeScript mobile clients. A signed-in player can bookmark a puzzle family from the gallery, view a dedicated bookmarked collection, and remove bookmarks from either surface. Bookmarks sync across devices because D1 is the durable source of truth; puzzle metadata remains KV-authoritative.

This is a bounded player feature. It does not introduce a generic favorites/reactions framework, anonymous bookmarks, local bookmark persistence, folders/tags, public counts, or gameplay/session changes.

## Goals

- Bookmark puzzle families, not individual Easy/Normal/Hard variants.
- Let signed-in web players bookmark from the gallery and browse all bookmarks at `/bookmarks`.
- Let signed-in NativeScript players bookmark from Gallery and browse the same collection in the existing Library.
- Keep bookmark state account-scoped and cross-device.
- Reuse existing family metadata resolution, auth, card, gallery, and mobile Library seams.
- Keep the implementation in one cohesive PR.

## Non-goals

- Anonymous/device-local bookmarks.
- Bookmark folders, tags, notes, custom ordering, search, or pagination.
- Public bookmark counts, sharing, feeds, recommendations, or reactions.
- Quick-puzzle or gameplay-screen bookmarks.
- Offline bookmark mutation queues or a local bookmark database/cache.
- Automatic cross-store cleanup/cascades when a family disappears from KV.
- Changes to `@perseus/game-core`, session codecs, or downloaded-puzzle manifests.
- A new mobile navigation/tab framework.

## Product model

### Bookmark unit

A bookmark targets a `PuzzleFamilySummary`. Web `PuzzleCard` and mobile Gallery already present one family with Easy/Normal/Hard variants, so the bookmark means “keep this puzzle” while play/download actions continue to target a concrete variant.

### Authentication

Bookmarks are account-scoped.

- Web uses the existing player session cookie through `requirePlayerAuth`.
- Mobile uses the existing bearer token through the same middleware.
- Signed-out web users do not issue bookmark requests; `/bookmarks` shows the normal sign-in state.
- Signed-out mobile users keep Gallery/Downloaded usable, hide bookmark actions, and see `Sign in below to use bookmarks.` in the Bookmarks section.
- Mobile reconnect/offline failure never blocks the offline Library, downloaded puzzles, or gameplay.

### Ordering

Bookmarks are listed newest-first by `createdAt`. No user-controlled sorting is added in v1.

## Data design

Add an additive D1 table using the next migration number available at implementation time; `0008_player_bookmarks.sql` is the current expected slot.

```sql
CREATE TABLE player_bookmarks (
	player_id TEXT NOT NULL,
	family_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (player_id, family_id)
);

CREATE INDEX idx_player_bookmarks_player_created
	ON player_bookmarks (player_id, created_at DESC);
```

The table stores only ownership and family identity. Do not copy name, category, status, variants, piece counts, or asset URLs from KV.

### Shared repository boundary

Prefer a focused `packages/shared/src/bookmarks.ts` module instead of extending the already broad `repositories.ts`.

Required operations:

- `addPlayerBookmark(db, playerId, familyId, createdAt?)`
- `removePlayerBookmark(db, playerId, familyId)`
- `listPlayerBookmarks(db, playerId): Promise<Array<{ familyId: string; createdAt: number }>>`

`addPlayerBookmark` follows the existing idempotent insert pattern with `onConflictDoNothing`. `removePlayerBookmark` is a successful no-op when the row is absent. `listPlayerBookmarks` returns newest-first rows and does not resolve KV metadata.

## Family-resolution reuse

Bookmark routes must not recreate family lookup/enrichment rules inside `player.worker.ts`.

Add this focused helper next to `listFamiliesPage` in `apps/api/src/services/storage.worker.ts`:

```ts
resolveReadyFamiliesByIds(
	kv: KVNamespace,
	familyIds: readonly string[]
): Promise<PuzzleFamilySummary[]>
```

Contract:

1. Resolve every ID with the existing `getFamily`.
2. Skip `null` families.
3. Skip families whose status is not `ready`.
4. Enrich survivors with the existing `enrichFamilySummary`.
5. Preserve the input ID order after skipped entries are removed.
6. Perform independent lookups concurrently, matching the existing `listFamiliesPage` pattern.
7. Do not catch corrupt-family errors per ID. `getFamily` already treats corrupt metadata as an error; let the request fail consistently with catalog behavior.

The helper exists because bookmark GET needs the same “IDs → ready family summaries” operation as catalog code. It is not a new storage abstraction.

## API design

Extend the existing authenticated player router.

### Shared response contract

Add the smallest client-shared response type to `@perseus/types`:

```ts
export interface PlayerBookmarkListResponse {
	families: PuzzleFamilySummary[];
}
```

Add `isPlayerBookmarkListResponse(value)` using the existing `isPuzzleFamilySummary` guard.

Do **not** reuse `PuzzleFamilyListResponse`: that public-catalog contract requires `total`, `offset`, and `limit`, while bookmark GET intentionally has no pagination fields.

Both web and mobile should consume this one response contract. Do not let each client invent a weaker check.

### `GET /api/player/bookmarks`

Requires `requirePlayerAuth`.

Flow:

1. Read `{ familyId, createdAt }[]` from D1 newest-first.
2. Pass the family IDs to `resolveReadyFamiliesByIds`.
3. Return `{ families } satisfies PlayerBookmarkListResponse`.
4. Validate the assembled response with `isPlayerBookmarkListResponse` before returning, matching existing defense-in-depth response validation style.

Missing/deleted/non-ready KV families are skipped. Corrupt KV metadata fails the request instead of being silently skipped.

No pagination is added in v1.

### `PUT /api/player/bookmarks/:familyId`

Requires `requirePlayerAuth`.

Closed status contract:

- malformed `familyId` by `isPuzzleId` → `400 { error: 'bad_request', ... }`
- syntactically valid but missing/non-ready family → `404 { error: 'not_found', ... }`
- ready family → idempotent insert and success

The ID and readiness semantics must match `GET /api/puzzle-families/:familyId`; do not invent a second interpretation in the player route. The implementation may use `resolveReadyFamiliesByIds(kv, [familyId])` for the readiness check so the predicate stays aligned with bookmark GET.

### `DELETE /api/player/bookmarks/:familyId`

Requires `requirePlayerAuth`.

Validate the ID format with `isPuzzleId`; malformed IDs are `400 bad_request`. A valid ID does not need to exist in KV because removing a stale bookmark should still be possible. Deleting an absent row is a successful no-op.

### Public catalog

`GET /api/puzzle-families` remains unauthenticated and unchanged. Do not attach per-player bookmark flags to catalog responses.

## Web UX

### Gallery card

Extend `PuzzleCard.svelte` with presentation-only state, for example:

- `bookmarked?: boolean`
- `bookmarkPending?: boolean`
- `onBookmarkToggle?: (family: PuzzleFamilySummary) => void`

The callback receives the family object. This lets callers update their transient collection after a successful add without refetching family metadata.

The card does not call bookmark APIs itself.

Show an accessible bookmark control near/on the artwork without colliding with category/progress badges or activating difficulty links.

Use non-optimistic mutation behavior:

1. mark that family pending,
2. disable repeat interaction for that family,
3. call PUT/DELETE,
4. update state only after success,
5. clear pending in `finally`.

### Gallery page state

When `playerAuth` is authenticated, fetch bookmarks once independently of catalog pagination and derive a `Set<familyId>`. Newly loaded infinite-scroll cards read membership from the same set; loading another catalog page does not refetch bookmarks.

On logout/account transition, clear bookmark UI state belonging to the old account without disturbing catalog/search/progress state.

### `/bookmarks`

Use a dedicated route, not an All/Bookmarked filter on the infinite-scroll gallery. A loaded-page filter could hide bookmarked families that are not in the currently fetched catalog pages.

Files include:

- `apps/web/src/routes/bookmarks/+page.svelte`
- `apps/web/src/routes/bookmarks/+page.ts`

`+page.ts` must set:

```ts
export const prerender = false;
```

This matches the auth-gated `/profile` route under the static adapter and prevents `/bookmarks` from being emitted as anonymous prerendered chrome.

Route states:

- auth loading
- anonymous/sign-in
- authenticated + bookmark loading
- authenticated + empty
- authenticated + populated
- bookmark request error

Successful unbookmark removes the family from the displayed collection after DELETE succeeds.

### Navigation

`ArcadeShell.svelte` owns a closed `ArcadeRoute` union and one shared nav item list. Add `/bookmarks` to both.

Update the existing shell/layout browser test in `apps/web/src/routes/layout.svelte.test.ts` to pin the Bookmarks nav item alongside the existing links. There is no separate `ArcadeShell.svelte.test.ts` on current `main`; use the existing layout test seam rather than creating a redundant test file.

## Web E2E boundary

Playwright is a client-wiring test for this feature, **not** the D1 persistence test.

The existing auth persona only stubs `GET /api/auth/session`; it does not mint a real session cookie/token. Therefore bookmark E2E must not accidentally call the real authenticated `/api/player/*` backend.

Follow the existing profile/progression style:

1. install an authenticated session persona or equivalent session route,
2. install stateful in-memory `page.route` handlers for `GET/PUT/DELETE /api/player/bookmarks`,
3. keep catalog routes mocked as existing gallery E2E already does,
4. bookmark a family,
5. navigate to `/bookmarks`,
6. reload and verify the GET handler rehydrates the same in-memory bookmark state,
7. unbookmark and verify removal.

This proves browser routing, mutation, reload, and rendering wiring. D1 idempotency/persistence/isolation are proven in shared/API worker tests. Do not add OAuth/cookie seeding or a new E2E auth subsystem.

## Mobile UX

The NativeScript app currently uses one Library screen with Gallery and Downloaded sections in one scroll. Keep that architecture.

The order becomes:

1. `GALLERY`
2. `BOOKMARKS`
3. `DOWNLOADED`

### `FamilyCard.svelte` reuse

Extract the current family card from `Gallery.svelte` into one small `FamilyCard.svelte`. Reuse it from Gallery and Bookmarks.

The component owns presentation only:

- family thumbnail/title,
- Easy/Normal/Hard rows,
- installed/download state,
- download progress/cancel action,
- optional bookmark state/action.

Do not turn this into a list framework.

### Gallery bookmark action

When authenticated, show a family-level bookmark control near the title. The handler receives the `PuzzleFamilySummary`, not just the ID, so a successful add can update `bookmarkedFamilies` without another family-detail request.

When signed out, hide the bookmark action.

### Bookmarks section

`Bookmarks.svelte` receives resolved bookmarked families plus the same install/download state and handlers as Gallery/`FamilyCard`.

States:

- signed out: `Sign in below to use bookmarks.`
- authenticated + loading: activity indicator
- authenticated + empty: `No bookmarked puzzles yet.`
- authenticated + populated: newest-first family cards
- bookmark-specific error text

Unbookmarking removes the card after DELETE succeeds.

### Mobile account/offline ownership

Keep bookmark state in `App.svelte` next to the active session and `accountEpoch`.

- Load bookmarks only for a validated authenticated session.
- Capture the current epoch for bookmark fetch/mutation work.
- Ignore async results after the epoch changes.
- Clear old bookmark state on sign-out/account switch.
- Bookmark failures do not clear the account or affect Gallery, downloads, completion sync, or gameplay.
- Do not create a local bookmark queue/cache.

### Mobile API client

Extend `apps/mobile/app/api/playerApi.ts`:

- expand `PlayerHttpRequest.method` from `GET | POST` to `GET | POST | PUT | DELETE`,
- add `getBookmarks(token): Promise<PlayerBookmarkListResponse>`,
- add `bookmarkFamily(familyId, token)`,
- add `unbookmarkFamily(familyId, token)`,
- validate GET with `isPlayerBookmarkListResponse`,
- keep bearer authentication and the existing thin NativeScript HTTP transport.

## State and consistency

### Server-authoritative collection

D1 is the durable bookmark source of truth. Web and mobile hold transient UI copies only. No localStorage/file/SQLite persistence is added.

### Mutation concurrency

Track pending mutations by family ID. Two different families may mutate independently; repeated taps on one family are disabled until its request settles. No general request queue is added.

### Account identity

Never apply a bookmark fetch/mutation result to a different account after auth/session changes. Mobile uses the existing `accountEpoch`; web keys work to current `playerAuth` identity/state.

## Verification ownership

### Shared/D1

Proves:

- add idempotency,
- newest-first list order,
- delete idempotency,
- player isolation.

### API worker

Proves:

- auth required,
- malformed ID → 400,
- missing/non-ready PUT → 404,
- ready PUT succeeds,
- typed GET response,
- skip/order behavior through `resolveReadyFamiliesByIds`,
- corrupt family metadata fails instead of being silently skipped,
- DELETE behavior.

### Web unit/browser tests

Proves:

- API method/path/credentials/response guard,
- card bookmark state/pending behavior,
- gallery membership/mutation wiring,
- `/bookmarks` route states,
- `prerender = false` route contract,
- ArcadeShell/layout nav update.

### Web Playwright

Uses stateful mocked bookmark routes and proves browser flow only. It does not claim to prove D1 persistence.

### Mobile

- `playerApi.test.ts` pins bearer GET/PUT/DELETE behavior and GET response validation.
- A small pure bookmark/account helper test pins stale-epoch rejection and add/remove state changes if extracting that helper keeps `App.svelte` thin.
- Existing `familyGallery.test.ts` continues to pin difficulty-to-variant selection.
- After `FamilyCard` extraction, `Gallery.svelte` must pass through the same family/install/download/progress/cancel inputs and `cd apps/mobile && bun run test:unit` must remain green.
- Do not introduce a NativeScript UI E2E framework solely for bookmarks.

## Delivery shape

One implementation PR, in this dependency order:

1. D1/shared persistence
2. ready-family resolution helper + typed API contract
3. authenticated player routes
4. web API/card/gallery
5. `/bookmarks` static-adapter route + navigation
6. mobile API
7. mobile `FamilyCard` extraction
8. mobile bookmark state/section
9. focused E2E/regression verification

## Acceptance criteria

- Signed-in web users can bookmark/unbookmark a family from Gallery.
- `/bookmarks` lists the complete server-backed collection and is `prerender = false`.
- Web bookmark state survives a browser reload when the backing API returns the stored collection.
- Signed-in mobile users see the same account collection and can add/remove bookmarks.
- Mobile bookmarked families retain existing per-difficulty download controls.
- PUT returns 400 for malformed IDs and 404 for valid-but-missing/non-ready families.
- GET returns the typed `PlayerBookmarkListResponse` and preserves D1 bookmark order while skipping missing/non-ready families.
- Signed-out/offline behavior remains usable.
- Shared/API tests, not Playwright, prove D1 persistence/idempotency/isolation.
- No session schema, download manifest, generic favorites framework, bookmark pagination, or offline bookmark cache is introduced.
