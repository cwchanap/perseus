# Account Bookmarks — Design Spec

## Summary

Add account-scoped puzzle-family bookmarks across the web and NativeScript mobile clients. A signed-in player can bookmark a puzzle family from the gallery, view a dedicated bookmarked collection, and remove bookmarks from either surface. Bookmarks sync across devices because D1 is the source of truth; puzzle metadata remains KV-authoritative.

This is intentionally a narrow player feature. It does not introduce a generic reactions/favorites framework, anonymous bookmarks, folders/tags, public counts, or changes to gameplay/session persistence.

## Goals

- Let signed-in players bookmark puzzle families from the web gallery.
- Provide a dedicated `/bookmarks` web page that lists all bookmarked families.
- Let signed-in mobile players bookmark puzzle families from the NativeScript Gallery.
- Show a mobile `BOOKMARKS` section in the existing Library flow, between Gallery and Downloaded.
- Sync bookmark state across web and mobile through the existing player account.
- Reuse the current puzzle-family presentation and download/difficulty behavior rather than create a parallel puzzle model.
- Keep the feature small enough for one implementation PR.

## Non-goals

- Anonymous or device-local bookmarks.
- Bookmark folders, tags, notes, ordering controls, or search within bookmarks.
- Public bookmark counts, social feeds, sharing, or recommendations.
- Quick-puzzle bookmarks.
- Gameplay-screen bookmark actions.
- Offline bookmark mutation queues or a local bookmark database.
- Bookmark pagination in v1.
- Automatic cleanup/cascades when a puzzle family disappears from KV.
- Changes to `@perseus/game-core`, session codecs, or downloaded-puzzle storage.
- A generic favorites/reactions subsystem.

## Product model

### Bookmark unit

Bookmarks apply to a `PuzzleFamilySummary`, not to an individual difficulty variant. A family already represents one puzzle across Easy/Normal/Hard variants, and both web and mobile UIs present those variants together. The bookmark therefore answers “I want to keep this puzzle,” while download/play actions continue to target a specific variant.

### Authentication

Bookmarks are account-scoped.

- Signed-in users can add, remove, and list bookmarks.
- Signed-out web users do not issue bookmark API requests; `/bookmarks` presents a sign-in state.
- Signed-out mobile users keep the Library fully usable; bookmark controls are hidden and the Bookmarks section points to the existing sign-in control.
- A reconnecting/offline mobile account never blocks the offline Library, downloaded puzzles, or gameplay. Bookmark failures are isolated to bookmark UI.

### Ordering

Bookmarked families are returned newest-first by bookmark creation time. No user-controlled sorting is added in v1.

## Data design

Add a D1 table via the next additive shared migration:

```sql
CREATE TABLE player_bookmarks (
	player_id TEXT NOT NULL,
	family_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (player_id, family_id)
);

CREATE INDEX player_bookmarks_player_created_idx
	ON player_bookmarks (player_id, created_at DESC);
```

The table stores only account ownership and family identity. It must not copy family name, category, status, variant metadata, or asset URLs from KV.

### Why no foreign key to puzzle families?

Puzzle-family metadata is KV-authoritative, not D1-authoritative. Creating a cross-store referential model would add coordination without improving the user experience. If a bookmarked family later disappears or is no longer ready, list resolution simply skips it.

### Shared repository boundary

Prefer a focused `packages/shared/src/bookmarks.ts` module rather than adding more bookmark-specific code to the already broad repository module.

Required operations:

- `addPlayerBookmark(db, playerId, familyId, createdAt?)`
- `removePlayerBookmark(db, playerId, familyId)`
- `listPlayerBookmarks(db, playerId)`

`addPlayerBookmark` uses conflict-ignore semantics so repeated PUT requests are idempotent. `removePlayerBookmark` is also idempotent.

## API design

Extend the existing authenticated player route; do not add another route subsystem.

### `GET /api/player/bookmarks`

Requires player authentication.

Response:

```json
{
	"families": []
}
```

Resolution flow:

1. Read bookmarked family IDs from D1 in newest-first order.
2. Resolve each family through the existing KV family lookup.
3. Reuse family-summary enrichment so the response shape matches normal gallery families.
4. Skip missing, deleted, or non-ready families.
5. Preserve the bookmark order of all surviving families.

No pagination is added for v1. Bookmark collections are expected to remain small, and introducing another cursor contract now would add complexity without a demonstrated need.

### `PUT /api/player/bookmarks/:familyId`

Requires player authentication.

Before writing, validate that the family exists in KV and is ready. A missing/unavailable family is rejected rather than creating a stale bookmark immediately.

The operation is idempotent: bookmarking an already-bookmarked family succeeds without creating a duplicate.

### `DELETE /api/player/bookmarks/:familyId`

Requires player authentication.

The operation is idempotent: deleting a missing bookmark is a successful no-op.

### Shared response types

If a response type/guard is needed by both clients, add the smallest bookmark response contract to `@perseus/types`. Do not create a larger bookmark domain model unless the implementation actually needs one.

## Web UX

### Gallery card

Extend `PuzzleCard.svelte` with presentation-only bookmark inputs, for example:

- `bookmarked?: boolean`
- `bookmarkPending?: boolean`
- `onBookmarkToggle?: (familyId: string) => void`

The card does not own API calls.

Show a bookmark control as an artwork overlay. It must not collide with the existing progress/category badges and must not interfere with Easy/Normal/Hard links.

Use a non-optimistic mutation model:

1. Mark that family pending.
2. Disable repeated bookmark taps.
3. Call PUT or DELETE.
4. Update local bookmark state after success.
5. Clear pending state.

This avoids rollback/race machinery for a low-latency, low-frequency action.

### Gallery page state

When player auth becomes authenticated, fetch bookmarks once and derive a `Set<familyId>` used by visible cards. Bookmark state is independent from catalog pagination: loading more families only checks membership in the same set.

The public puzzle-family catalog remains unchanged. Do not add user-specific bookmark state to its response because the web catalog can be fetched independently of authenticated player requests.

### `/bookmarks`

Add a dedicated route rather than an “All / Bookmarked” client filter on the infinite-scroll gallery.

Reasons:

- The gallery already owns search, category filters, cursor pagination, request abort/version handling, progress discovery, and infinite scrolling.
- A client-side “bookmarked” filter would only know about families already fetched by infinite scroll and could silently hide bookmarks that live on later catalog pages.
- The player endpoint can return the complete bookmark collection directly.

Route states:

- auth loading: normal loading state
- anonymous: sign-in prompt/state
- authenticated + loading: bookmark loading state
- authenticated + empty: useful empty state
- authenticated + populated: normal `PuzzleCard` grid
- error: isolated retry/error presentation

Removing a bookmark from this page removes the card after the DELETE succeeds.

### Navigation

Extend the existing `ArcadeShell` route union/navigation with `/bookmarks` and a `Bookmarks` entry. Reuse its current desktop/mobile navigation generation.

## Mobile UX

The current NativeScript app uses a single Library screen with Gallery and Downloaded sections in one scroll. Do not introduce a new mobile navigation stack or tab system solely for bookmarks.

The Library order becomes:

1. `GALLERY`
2. `BOOKMARKS`
3. `DOWNLOADED`

### Family card reuse

Extract the current mobile gallery family-card markup into a small `FamilyCard.svelte` and reuse it in Gallery and Bookmarks. This extraction is justified because both sections need the same family title, thumbnail, difficulty rows, download state, and actions.

Do not generalize it into a configurable list framework.

### Gallery bookmark action

For authenticated players, show a family-level bookmark control near the family title. Download controls remain per difficulty.

Use bookmark terminology rather than “Save” because Download already represents local/offline persistence in this UI.

When signed out, hide the card bookmark action rather than presenting non-functional controls.

### Bookmarks section

`Bookmarks.svelte` receives resolved bookmarked families plus the same download/install state and handlers needed by `FamilyCard`.

States:

- signed out: `Sign in below to use bookmarks.`
- authenticated + loading: activity indicator
- authenticated + empty: `No bookmarked puzzles yet.`
- authenticated + populated: family cards newest-first
- request failure: bookmark-specific error text without breaking Gallery/Downloaded

Unbookmarking a family removes it from the section after the server succeeds.

A user can therefore bookmark on web, open mobile, find the same family, then download any desired difficulty.

### Mobile account/offline behavior

`App.svelte` already owns the active mobile account/session and intentionally allows the offline Library to boot independently from account probing. Preserve that separation.

Bookmark fetching occurs only when a validated account session/token is available. A bookmark transport/server failure must not:

- clear a valid local account by itself,
- block Gallery rendering,
- block downloaded puzzles,
- block gameplay,
- create a local bookmark queue.

When the active account changes, discard bookmark state belonging to the previous account and load the new account's collection.

### Mobile API client

Extend `apps/mobile/app/api/playerApi.ts` rather than introduce another API client.

Add:

- `getBookmarks(token)`
- `bookmarkFamily(familyId, token)`
- `unbookmarkFamily(familyId, token)`

The current mobile HTTP request method union must be expanded to include `PUT` and `DELETE`. The NativeScript transport remains a thin pass-through.

Use bearer authentication consistently with the rest of the mobile player API.

## State and consistency

### One server-authoritative bookmark collection

Web and mobile maintain only transient UI copies of the account's bookmark IDs/families. D1 is the durable source of truth.

No localStorage/file/SQLite bookmark persistence is added.

### Mutation concurrency

Track pending mutations by family ID, not with one global busy flag. A user may mutate two different family bookmarks independently, but repeated taps on the same family are disabled until that request settles.

Do not add a general request queue.

### Stale async results

Client code must avoid applying bookmark results to a different signed-in identity after account/session changes. Web naturally keys work to current auth state; mobile should follow its existing account-epoch/stale-result approach or an equally small identity check when bookmark requests are owned by `App.svelte`.

## Testing strategy

### Shared/D1

- add is idempotent
- newest-first listing
- delete is idempotent
- bookmarks are isolated by player

### API

- auth required for all three endpoints
- PUT rejects missing/non-ready family
- PUT + GET returns resolved family summary
- repeat PUT does not duplicate
- DELETE removes bookmark
- repeat DELETE succeeds
- GET skips a stale D1 row whose KV family is missing/non-ready
- ordering survives KV enrichment

### Web

`api.test.ts`:

- GET/PUT/DELETE paths
- methods
- `credentials: 'include'`

`PuzzleCard.svelte.test.ts`:

- bookmarked/unbookmarked states
- callback receives family ID
- pending state disables repeat interaction
- difficulty links still work

Bookmarks route tests:

- loading/authenticated/anonymous/empty/error states
- populated card rendering
- successful unbookmark removes card

Gallery tests:

- authenticated bookmark set marks matching loaded cards
- successful mutation updates state
- catalog pagination behavior remains unchanged

Existing Playwright gallery coverage:

- signed-in user bookmarks a family
- Bookmarks page shows it
- reload still shows it
- unbookmark removes it

### Mobile

Extend `playerApi.test.ts`:

- GET bookmark list sends bearer token
- PUT bookmark path/method/header
- DELETE bookmark path/method/header
- non-2xx handling

Add focused pure/unit tests for any extracted bookmark-state helper needed to protect account switches/stale results. Do not introduce a NativeScript UI E2E framework for this feature.

Where component behavior can be covered cheaply in the existing test stack, cover `FamilyCard`/Bookmarks presentation; otherwise keep UI logic thin and test its pure inputs/handlers.

## Delivery shape

The implementation remains one PR because it is one cohesive vertical feature:

1. additive D1 bookmark persistence
2. authenticated player endpoints
3. web bookmark UI and dedicated route
4. mobile bookmark UI in the existing Library
5. focused tests across the touched seams

The web and mobile work share the same server contract and product behavior, so splitting them would create an unnecessary period where the account feature exists on only one client.

## Risks and constraints

### Cross-store resolution

D1 contains family IDs while family metadata lives in KV. GET therefore performs KV lookups after the D1 query. This is acceptable for the intentionally unpaginated, expected-small v1 collection. If real collections become large, pagination/batched metadata strategy can be added from observed need.

### Mobile Library complexity

`Library.svelte` already coordinates Gallery and Downloaded state. Bookmark state should stay narrow; if extracting one small bookmark-state helper makes account transitions easier to test, do so, but do not turn this PR into a mobile state-management rewrite.

### Web gallery complexity

The web gallery is already state-heavy. Keep bookmark fetching/mutations orthogonal to search and cursor logic; do not refactor unrelated gallery behavior while adding the feature.

## Acceptance criteria

- A signed-in web player can bookmark/unbookmark a family from the gallery.
- A signed-in web player can view all current bookmarks at `/bookmarks`.
- The bookmark persists after reload.
- A signed-in mobile player sees the same server-backed bookmark collection.
- A signed-in mobile player can bookmark/unbookmark a family from Gallery.
- Mobile Bookmarks cards can download Easy/Normal/Hard variants using the existing download flow.
- Signed-out users cannot create account bookmarks and existing public/offline functionality still works.
- Missing/deleted/non-ready families do not break bookmark listing.
- No session schema, game-core, download manifest, or generic favorites framework is introduced.
