# Account Bookmarks — Design Spec

## Summary

Add account-scoped puzzle-family bookmarks across web and NativeScript mobile. A signed-in player can bookmark a puzzle family, browse the same collection on either client, and remove bookmarks from any supported surface.

D1 is the durable bookmark source of truth. KV remains authoritative for puzzle-family metadata. The feature stays deliberately narrow: no generic favorites framework, no local bookmark persistence, no pagination, no folders/tags, and no gameplay/session changes.

## Goals

- Bookmark puzzle families, not individual Easy/Normal/Hard variants.
- Let signed-in web players bookmark from Gallery and browse all bookmarks at `/bookmarks`.
- Let signed-in NativeScript players bookmark from Gallery and browse the same account collection in the existing Library.
- Reuse existing auth, D1, KV family metadata, card, gallery, and mobile account seams.
- Bound the collection so the intentionally unpaginated GET has predictable resource cost.
- Keep web bookmark mutation state in one reusable store.
- Keep mobile epoch-sensitive bookmark transitions in one mandatory pure module.

## Non-goals

- Anonymous/device-local bookmarks.
- Bookmark folders, tags, notes, custom ordering, search, or pagination.
- Public bookmark counts, sharing, feeds, recommendations, or reactions.
- Quick-puzzle or gameplay-screen bookmarks.
- Offline bookmark mutation queues or a local bookmark database/cache.
- Automatic cross-store cleanup/cascades when a family disappears from KV.
- Changes to `@perseus/game-core`, session codecs, or downloaded-puzzle manifests.
- A new mobile navigation/tab framework.
- A new OAuth/cookie E2E subsystem.

## Product model

### Bookmark unit

A bookmark targets a `PuzzleFamilySummary`. Both web `PuzzleCard` and mobile Gallery already present one family with Easy/Normal/Hard variants, so bookmark state means “keep this puzzle” while play/download actions continue to target a concrete difficulty variant.

### Authentication

Bookmarks are account-scoped.

- Web uses the existing player session cookie through `requirePlayerAuth`.
- Mobile uses the existing bearer token through the same middleware.
- Signed-out web users do not issue bookmark requests; `/bookmarks` shows a sign-in state.
- Signed-out mobile users keep Gallery/Downloaded usable, hide bookmark actions, and see `Sign in below to use bookmarks.` in the Bookmarks section.
- Mobile reconnect/offline failure never blocks the offline Library, downloaded puzzles, completion sync, or gameplay.

### Ordering and capacity

Bookmarks are listed newest-first by `createdAt`.

Export a single server-side constant from `@perseus/shared`:

```ts
export const MAX_PLAYER_BOOKMARKS = 200;
```

V1 remains unpaginated. The collection is instead bounded at 200 bookmarks per player so GET has predictable D1/KV fan-out and cannot grow without limit.

When the player is already at the cap:

- re-PUT of an existing bookmark remains an idempotent success,
- PUT of a different family returns `409` with `error: 'bookmark_limit_reached'`,
- DELETE remains available so the player can free capacity.

Clients surface the mutation error through their existing bookmark-specific error state; no special quota UI is required in v1.

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

Use a focused `packages/shared/src/bookmarks.ts` module instead of extending the already broad `repositories.ts`.

Required surface:

```ts
export const MAX_PLAYER_BOOKMARKS = 200;

export type AddPlayerBookmarkResult = 'added' | 'existing' | 'limit_reached';

addPlayerBookmark(
	db: AppDb,
	playerId: string,
	familyId: string,
	createdAt?: number
): Promise<AddPlayerBookmarkResult>;

removePlayerBookmark(db: AppDb, playerId: string, familyId: string): Promise<void>;

listPlayerBookmarks(
	db: AppDb,
	playerId: string
): Promise<Array<{ familyId: string; createdAt: number }>>;
```

`addPlayerBookmark` owns both idempotency and capacity enforcement. Do not implement capacity as a route-level `count → insert` preflight that can race. The persistence operation must distinguish `existing` from `limit_reached` while preventing a new row once the player is at the cap.

`listPlayerBookmarks` is newest-first and applies `.limit(MAX_PLAYER_BOOKMARKS)` as defense in depth. `removePlayerBookmark` is a successful no-op when the row is absent.

No D1 foreign key to KV metadata is introduced.

## Family-resolution reuse

Bookmark GET must not recreate family lookup/enrichment rules inside `player.worker.ts`.

Extract the existing `listFamiliesPage` resolution loop into a focused helper next to it in `apps/api/src/services/storage.worker.ts`:

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
5. Preserve input ID order after skipped entries are removed.
6. Perform independent lookups concurrently, matching `listFamiliesPage`.
7. Do not add per-ID try/catch. Corrupt family metadata already throws from `getFamily`; let the request fail loudly and consistently.

The helper is GET-only. PUT readiness does not need summary enrichment.

## API design

Extend the existing authenticated player router.

### Shared response contract

Add the smallest client-shared response contract to `@perseus/types`:

```ts
export interface PlayerBookmarkListResponse {
	families: PuzzleFamilySummary[];
}

export function isPlayerBookmarkListResponse(
	value: unknown
): value is PlayerBookmarkListResponse;
```

The guard reuses `isPuzzleFamilySummary` for every entry.

Do **not** reuse `PuzzleFamilyListResponse`: the public catalog contract requires `total`, `offset`, and `limit`, while bookmarks intentionally have no pagination fields.

### `GET /api/player/bookmarks`

Requires `requirePlayerAuth`.

Flow:

1. Read at most `MAX_PLAYER_BOOKMARKS` `{ familyId, createdAt }` rows from D1 newest-first.
2. Pass the family IDs to `resolveReadyFamiliesByIds`.
3. Assemble `{ families } satisfies PlayerBookmarkListResponse`.
4. Validate with `isPlayerBookmarkListResponse` before returning.

Missing/deleted/non-ready families are skipped. Corrupt KV metadata fails the request instead of being silently omitted.

### `PUT /api/player/bookmarks/:familyId`

Requires `requirePlayerAuth`.

Closed contract:

- malformed `familyId` by `isPuzzleId` → `400 { error: 'bad_request', ... }`,
- valid but missing/non-ready family → `404 { error: 'not_found', ... }`,
- ready family + capacity available → idempotent success,
- existing bookmark at capacity → idempotent success,
- new bookmark at capacity → `409 { error: 'bookmark_limit_reached', ... }`.

Readiness uses the same direct predicate as family detail:

```ts
const family = await getFamily(kv, familyId);
if (!family || family.status !== 'ready') return 404;
```

Do not call `resolveReadyFamiliesByIds` for PUT merely to answer a boolean.

### `DELETE /api/player/bookmarks/:familyId`

Requires `requirePlayerAuth`.

Validate ID format with `isPuzzleId`; malformed IDs are `400 bad_request`. A valid family does not need to exist in KV because deleting a stale bookmark must remain possible. Deleting an absent row is a successful no-op.

### Public catalog

`GET /api/puzzle-families` remains unauthenticated and player-agnostic. Do not attach per-player bookmark flags to it.

## Web architecture

### One bookmark store

Do not duplicate bookmark fetch/mutation/account-transition logic in Gallery and `/bookmarks`.

Add `apps/web/src/lib/stores/bookmarks.ts` following the existing factory + singleton shape used by `playerAuth.ts`.

The store owns:

- resolved `families`,
- derived `ids`,
- loading/error state,
- per-family `pending` state,
- `load()`,
- `toggle(family)`,
- clearing stale state on logout/account switch,
- stale async result rejection when the authenticated identity changes.

The singleton may observe `playerAuth` only to clear/switch ownership. It should **not** eagerly fetch bookmarks on every route. Gallery and `/bookmarks` call `load()` when they need the collection; repeated loads for the same already-loaded account are deduplicated/no-ops.

API calls remain in the store. Routes are presentation/composition only.

### Gallery card

Extend `PuzzleCard.svelte` with presentation-only state:

- `bookmarked?: boolean`,
- `bookmarkPending?: boolean`,
- `onBookmarkToggle?: (family: PuzzleFamilySummary) => void`.

The callback receives the rendered family object so a successful add can update transient store state without a family-detail refetch.

The bookmark control has a fixed layout slot: use the existing bottom title row, with the title flexing/truncating on the left and a compact bookmark button on the bottom-right. Keep category top-left and progress top-right unchanged.

The control must be accessible, must not activate difficulty links, and is disabled while that family is pending.

Mutation behavior is non-optimistic:

1. mark the family pending in the store,
2. call PUT/DELETE,
3. update store state only after success,
4. preserve prior state on failure,
5. clear pending in `finally`.

### Gallery page

Gallery observes `playerAuth` only for whether bookmark UI should be shown and calls `bookmarks.load()` for an authenticated player. Infinite-scroll/search/category/progress behavior remains unchanged.

Newly loaded catalog cards read membership from the same store; loading another catalog page never performs another bookmark GET once the store is loaded for that account.

### `/bookmarks`

Use a dedicated route, not an All/Bookmarked client filter on the infinite-scroll gallery.

Files:

- `apps/web/src/routes/bookmarks/+page.svelte`,
- `apps/web/src/routes/bookmarks/+page.ts`.

`+page.ts` must contain:

```ts
export const prerender = false;
```

The page renders the shared bookmark store states:

- auth loading,
- anonymous/sign-in,
- bookmark loading,
- empty,
- populated,
- error.

Unbookmark calls the same store `toggle(family)` path used by Gallery.

### Navigation

Add `/bookmarks` to the closed `ArcadeRoute` union and the shared `navItems` array in `ArcadeShell.svelte`.

Update the existing shell test seam in `apps/web/src/routes/layout.svelte.test.ts`; do not create a redundant `ArcadeShell.svelte.test.ts`.

## Web E2E boundary

Playwright proves browser wiring only; shared/API tests prove D1 persistence and capacity.

Use the existing raw `page.route` style in `apps/web/e2e/gallery.spec.ts` for this scenario. Do **not** mix in `createAuthPersona`/`GameplayPage` diagnostics for a non-gameplay gallery flow.

Install raw stateful routes for:

- `GET /api/auth/session`,
- public catalog endpoints used by the test,
- `GET /api/player/bookmarks`,
- `PUT /api/player/bookmarks/:familyId`,
- `DELETE /api/player/bookmarks/:familyId`.

Keep an in-memory bookmark collection for the duration of the browser test. Reload must rehydrate from that mocked GET state.

Reuse `apps/web/e2e/support/accessibility.ts` and run the existing axe helper against the populated `/bookmarks` page/navigation instead of introducing bespoke accessibility plumbing.

## Mobile architecture

The NativeScript app keeps one Library screen. Its order becomes:

1. `GALLERY`
2. `BOOKMARKS`
3. `DOWNLOADED`

### Why bookmark I/O stays in `App.svelte`

`Library.svelte` owns public gallery fetching through injected `puzzleApi`, but account bookmarks are different: the bearer token, active account, secure-session lifecycle, and `accountEpoch` already live in `App.svelte`.

Keep authenticated bookmark I/O in `App.svelte` rather than passing bearer/session ownership down into Library. `Library.svelte` receives only presentation state and handlers.

### Mandatory pure bookmark state module

Add `apps/mobile/app/library/bookmarkState.ts` with no NativeScript imports and no network/storage I/O.

It owns pure transitions for:

- empty/cleared state,
- applying a loaded family collection,
- applying successful add/remove,
- pending/error updates,
- rejecting results when `requestEpoch !== currentEpoch`.

`App.svelte` captures `accountEpoch` before each bookmark fetch/mutation, performs the API call, then applies the result through this module. Cross-account stale-result behavior is therefore unit-testable and not left inline in the NativeScript component.

The helper is mandatory, not optional.

### `FamilyCard.svelte`

Extract the current family card from `Gallery.svelte` into one presentation component reused by Gallery and Bookmarks.

It contains:

- thumbnail/title,
- Easy/Normal/Hard rows,
- per-variant installed/download state,
- active download progress/cancel action,
- optional bookmark state/action.

On mobile the bookmark action sits in the family title row next to the title. Do not create a generic list/card framework.

### Bookmarks section

`Bookmarks.svelte` receives resolved families plus the same install/download state and handlers as Gallery/`FamilyCard`.

States:

- signed out: `Sign in below to use bookmarks.`,
- authenticated + loading: activity indicator,
- authenticated + empty: `No bookmarked puzzles yet.`,
- authenticated + populated: newest-first cards,
- bookmark-specific error.

Successful unbookmark removes the family after DELETE succeeds. No local bookmark queue/cache is created.

### Mobile API client

Extend `apps/mobile/app/api/playerApi.ts`:

- `PlayerHttpRequest.method` becomes `GET | POST | PUT | DELETE`,
- `getBookmarks(token): Promise<PlayerBookmarkListResponse>`,
- `bookmarkFamily(familyId, token)`,
- `unbookmarkFamily(familyId, token)`,
- GET validates with `isPlayerBookmarkListResponse`,
- current bearer-auth and thin NativeScript HTTP transport remain unchanged.

## Verification ownership

### Shared/D1

`packages/shared/src/__tests__/bookmarks.d1.test.ts` reuses the existing Miniflare D1 helper and proves:

- add/list/remove,
- idempotent add/remove,
- newest-first ordering,
- player isolation,
- max-capacity enforcement,
- existing bookmark still succeeds at capacity,
- list never returns more than `MAX_PLAYER_BOOKMARKS`.

`packages/shared/src/__tests__/schema.test.ts` is updated to:

- pin the new journal/snapshot entry,
- pin `player_bookmarks` columns/PK/index,
- assert migration `0008` is additive/non-destructive.

### API worker

`apps/api/src/routes/player.worker.test.ts` proves route mapping only:

- auth required,
- malformed ID → 400,
- missing/non-ready PUT → 404,
- ready PUT calls the repository,
- repository `limit_reached` → 409,
- typed GET response,
- GET skip/order behavior through the real KV resolver,
- corrupt KV metadata fails instead of being silently skipped,
- DELETE behavior.

The route test mocks the D1 repository helpers, so it must **not** claim to prove duplicate-row persistence. That belongs in the Miniflare test above.

For KV-dependent route coverage, reuse `makeFamilyMetadata` from `apps/api/src/routes/__tests__/helpers/family-fixtures.ts` plus a minimal in-test `KVNamespace` mock modeled on existing route tests.

### Web

- `api.test.ts`: methods, paths, credentials, response guard.
- `bookmarks.test.ts`: the single store’s load/toggle/pending/failure/account-switch/stale-result behavior.
- `PuzzleCard.svelte.test.ts`: visual state, accessible control, callback family, pending, difficulty links.
- `page.svelte.test.ts`: mock `playerAuth` and the bookmark store; test gallery presentation only.
- `/bookmarks` route test: mock the same stores; test route states/presentation only.
- `layout.svelte.test.ts`: Bookmarks nav entry.
- Playwright raw-route flow: browser wiring/reload/unbookmark plus existing axe helper.

### Mobile

- `playerApi.test.ts`: bearer GET/PUT/DELETE and GET guard.
- `bookmarkState.test.ts`: stale epoch, account clear/switch, add/remove, pending/error transitions.
- `familyGallery.test.ts`: existing difficulty/variant contract remains green after extraction.
- `cd apps/mobile && bun run test:unit` is the executable extraction/regression gate.

Do not introduce a NativeScript UI E2E framework solely for bookmarks.

## Delivery shape

Implement in two PRs against the same frozen contract.

### Implementation PR A — server + web

Contains:

1. D1 schema/migration/bookmark repository + bounds,
2. ready-family resolver + shared response type,
3. authenticated player endpoints,
4. web API client + bookmark store,
5. `PuzzleCard` + Gallery wiring,
6. `/bookmarks` + `prerender = false` + shell nav,
7. shared/API/web unit tests + raw-route Playwright + accessibility scan.

### Implementation PR B — mobile

Depends on PR A’s merged server contract and contains:

1. mobile player API methods,
2. `FamilyCard` extraction,
3. mandatory pure `bookmarkState.ts`,
4. `App.svelte` authenticated bookmark I/O/epoch wiring,
5. Library `BOOKMARKS` section,
6. focused mobile unit/regression tests.

There is no requirement to temporarily ship both clients together; separating them keeps each implementation review smaller while preserving one product design and one server contract.

## Acceptance criteria

- A player can hold at most 200 bookmarks; over-cap new PUT returns 409 while existing PUT remains idempotent.
- Signed-in web users can bookmark/unbookmark from Gallery.
- `/bookmarks` lists the complete bounded server-backed collection and is `prerender = false`.
- Web Gallery and `/bookmarks` share one bookmark store and mutation path.
- Web bookmark state survives reload when GET returns the stored collection.
- Signed-in mobile users see the same account collection and can add/remove bookmarks.
- Mobile stale epoch results cannot apply to a different account and this is covered by pure unit tests.
- Mobile bookmarked families retain existing per-difficulty download controls.
- PUT uses direct `getFamily` readiness semantics: 400 malformed, 404 missing/non-ready, 409 capacity reached.
- GET returns typed `PlayerBookmarkListResponse` and preserves D1 order while skipping missing/non-ready families.
- Shared/API tests, not Playwright, prove D1 idempotency/isolation/capacity.
- No session schema, download manifest, generic favorites framework, pagination, or offline bookmark cache is introduced.
