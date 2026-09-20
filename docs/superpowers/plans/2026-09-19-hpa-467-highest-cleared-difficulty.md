# HPA-467 Highest Cleared Difficulty on Puzzle Cards — Implementation Plan

> Continue implementation on this same branch/PR. One Linear ticket -> one PR.

**Goal:** Show one truthful highest-cleared-difficulty badge on web Gallery and Bookmarks cards by merging current-device completion stats with fully paginated signed-in account stats.

**Architecture:** Keep local completion truth in `stats.ts`. Add `highestClearedDifficulty.ts` as the shared local-read + pure merge service, and keep `clearedDifficulties.ts` account-only. The store reuses bookmarks' identity/version/load-dedupe pattern plus Gallery/Profile abort semantics, exhausts account stats with `limit: 100`, and publicly exposes only the final clear map that consumers use. Gallery and Bookmarks reactively call the same required family composition helper. `PuzzleCard` receives only the resolved difficulty and renders it in a compact, named top-right status stack.

**Tech stack:** Svelte 5, TypeScript, Svelte stores, existing `getPlayerStats` API client, Vitest + vitest-browser-svelte.

## Global constraints

- One implementation PR; keep implementation on this planning branch/PR.
- No API endpoint, backend, workflow, D1, or completion-write changes.
- Do not change `getStats` / `recordLocalCompletion` semantics; the additive `statsRevision` export (bumped only on persisted writes) is permitted so routes can re-run local reads when a write lands mid-view.
- Use `totalCompletions > 0`; never infer clear state from best-time fields.
- No generic remote-state/cache framework.
- No generic progression/account store.
- No per-difficulty completion marks in `PuzzleDifficultyPicker`.
- No NativeScript/mobile work.
- No generated image assets.
- Account clear data is all-or-nothing per load: never publish partial pagination.
- Account stats failure must not block Gallery/Bookmarks or erase local clear badges.

## File map

**Add**

- `apps/web/src/lib/services/gameplay/highestClearedDifficulty.ts`
- `apps/web/src/lib/services/gameplay/highestClearedDifficulty.test.ts`
- `apps/web/src/lib/stores/clearedDifficulties.ts`
- `apps/web/src/lib/stores/clearedDifficulties.test.ts`

**Modify**

- `apps/web/src/lib/components/PuzzleCard.svelte`
- `apps/web/src/lib/components/DifficultyGems.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/DifficultyGems.svelte.test.ts`
- `apps/web/src/routes/+page.svelte`
- `apps/web/src/routes/page.svelte.test.ts`
- `apps/web/src/routes/bookmarks/+page.svelte`
- `apps/web/src/routes/bookmarks/page.svelte.test.ts`

**Do not modify by default**

- `apps/web/src/lib/services/api.ts`
- `apps/web/src/lib/services/stats.ts` completion semantics (the additive `statsRevision` export is the only permitted change)
- `packages/types/**`
- `PuzzleDifficultyPicker.svelte`
- backend/mobile/generated-asset code.

---

## Task 1: Add the shared clear read model and clear-specific account store

### Files

- Create: `apps/web/src/lib/services/gameplay/highestClearedDifficulty.ts`
- Create: `apps/web/src/lib/services/gameplay/highestClearedDifficulty.test.ts`
- Create: `apps/web/src/lib/stores/clearedDifficulties.ts`
- Create: `apps/web/src/lib/stores/clearedDifficulties.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte` (call `invalidate()` after a successful `recordCompletion`)
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

### 1.1 Write failing resolver tests

Cover:

- no local/account clear -> `null`;
- local Easy -> Easy;
- local Normal -> Normal;
- local Hard -> Hard;
- Easy + Hard -> Hard;
- account-only Easy/Normal/Hard;
- mixed local/account chooses the highest;
- Hard-only returns Hard and does not synthesize lower completion state.

The resolver input should be explicit data structures, not `localStorage`, so these tests remain pure.

### 1.2 Implement the pure resolver

Add:

```ts
export function resolveHighestClearedDifficulty(
	family: PuzzleFamilySummary,
	localClearedVariantIds: ReadonlySet<string>,
	accountClearedByFamily: ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>
): PuzzleDifficulty | null;
```

Derive the descending order once at module scope, then reuse it for every family:

```ts
const CLEAR_RANK_DESC: readonly PuzzleDifficulty[] = [...PUZZLE_DIFFICULTIES].reverse();

for (const difficulty of CLEAR_RANK_DESC) {
	// hard -> normal -> easy
}
```

This stays derived from the canonical tuple without a per-family allocation or a new `toReversed()` runtime requirement.

A difficulty matches when either local variant id or account family+difficulty contains it.

No inferred lower clears.

### 1.3 Add local discovery helper

Add a thin helper that reads visible families through existing `getStats`:

```ts
readLocalClearedVariantIds(families);
```

Include a variant only when:

```ts
getStats(variant.id)?.totalCompletions > 0;
```

Keep `stats.ts` unchanged.

Add the required route composition helper:

```ts
resolveHighestClearedForFamilies(families, accountClearedByFamily, _localStatsRevision);
```

It returns `ReadonlyMap<familyId, PuzzleDifficulty>`, performs local discovery once for the supplied family list, and calls the pure resolver. Gallery and Bookmarks must use this helper; neither route may inline local discovery + merge logic.

`_localStatsRevision` is a required reactive tracking input — never read for computation. The helper's `getStats()` localStorage reads register no dependency, so routes pass the `statsRevision` store value (`$lib/services/stats`, bumped after every persisted local mutation) to re-run local discovery when a completion write lands while the route is mounted.

### 1.4 Write failing account-store tests

Model the existing bookmarks store test style.

Cover only observable clear-map/lifecycle behavior:

1. anonymous account publishes an empty map and `load()` is a no-op;
2. authenticated `load()` fetches stats;
3. rows with `totalCompletions <= 0` are ignored;
4. account rows are grouped by `familyId` and `difficulty`;
5. every stats request uses `limit: 100`;
6. `nextCursor` is followed until exhausted;
7. intermediate pages do **not** publish partial state;
8. final page publishes one complete map;
9. repeated load for the same already-loaded account is deduped;
10. logout clears old account data;
11. account switch clears old data before new data arrives;
12. stale old-account response cannot repopulate state;
13. active request chain is aborted on identity change;
14. `AbortError` and stale-version completions leave the published map unchanged;
15. a real failure leaves the map empty and does not mark the account loaded, allowing retry;
16. transient auth `loading` for the same observed account does not flicker away a valid loaded map;
17. `invalidate()` keeps the published map but marks the account unloaded so the next `load()` refetches;
18. an in-flight load is aborted and its results dropped on `invalidate()`;
19. a real current-version failure is logged via `console.error` while abort/stale exits stay silent.

Do not add tests for public loading/error/status fields because the store does not expose them.

### 1.5 Implement `createClearedDifficultiesStore`

Reuse `bookmarks.ts` for identity/version/load-dedupe, but copy abort/signal/error handling from Gallery/Profile rather than pretending bookmarks already owns cancellation. Accept an injected auth readable, matching `createBookmarksStore(auth)`, so store tests control account transitions directly.

Public Svelte store value:

```ts
ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>;
```

Internal fields:

- `currentAccountId`;
- `observedAccountId`;
- `loadedAccountId`;
- `loadPromise`;
- `version`;
- active `AbortController`.

Auth subscription:

- preserve through transient loading for the same tracked account;
- on real identity change: bump version, abort active request, and publish an empty map immediately.

`load()`:

- return immediately if no account;
- dedupe same-account loaded/in-flight requests;
- create one controller and captured version;
- call `getPlayerStats({ limit: 100, cursor, signal })` on every page;
- follow every cursor page;
- accumulate only `totalCompletions > 0`;
- do not call `set()` with partial pages;
- publish the final map once when pagination is complete and still current;
- ignore `AbortError` and stale-version completion without mutating the published map;
- on current non-abort failure keep the published map empty, log it via `console.error`, and leave `loadedAccountId` unset so a later `load()` can retry.

`invalidate()` (called by the puzzle route after a successful `recordCompletion`, because clear writes bypass the store):

- bump `version` so in-flight results are dropped;
- clear `loadedAccountId` and `loadPromise`;
- abort the active controller;
- leave the published map unchanged as last-known-good until the next `load()` lands.

Keep loading/error bookkeeping private; no HPA-467 UI reads it.

Export singleton:

```ts
export const clearedDifficulties = createClearedDifficultiesStore();
```

### 1.6 Run focused read-model/store tests

Use the repo's actual browser-mode unit command rather than a second invocation shape:

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/highestClearedDifficulty.test.ts \
  src/lib/stores/clearedDifficulties.test.ts
```

Expected: pass.

---

## Task 2: Add the clear badge and shared card status stack

### Files

- Modify: `apps/web/src/lib/components/PuzzleCard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts`

### 2.1 Add failing component tests

Cover:

- absent/null `highestClearedDifficulty` -> no badge;
- Easy / Normal / Hard render;
- exact accessible name `Highest cleared difficulty: <Label>` resolved via `getByRole('img', { name: ... })`;
- matching difficulty drives the existing gem count/accent with piece-count text omitted in badge mode;
- `DifficultyGems` default behavior still shows piece count for the picker;
- progress-only layout still works;
- clear-only layout works;
- clear + progress both render inside one status-stack container;
- the clear badge is independently queryable as `data-testid="card-cleared-difficulty"`;
- both states remain independently queryable;
- at `await page.viewport(390, 844)`, the status-stack bounding box intersects neither the title/bookmark row nor the full 34×34 top-left category-status wrapper in the existing narrow `343 / 215` artwork layout; add a stable card-level test id to that wrapper so the test measures its real footprint rather than only the nested 16px category icon;
- restore the default test viewport in `finally`, following `ArcadeShell.svelte.test.ts`;
- bookmark button and all three difficulty actions remain unchanged.

### 2.2 Add compact `DifficultyGems` mode without changing picker behavior

Add one optional prop:

```ts
showPieceCount?: boolean // default true
```

When false, render the existing difficulty gems/accent without the visible piece-count span. Extend `DifficultyGems.svelte.test.ts` to prove the default remains unchanged and compact mode omits only the visible count.

### 2.3 Extend `PuzzleCard` props

Add:

```ts
highestClearedDifficulty?: PuzzleDifficulty | null;
```

No stats objects, account state, or resolver logic inside the component.

### 2.4 Replace the single progress position with a status stack

Today `card-progress` owns `absolute top-3 right-3`.

Introduce one top-right container only when either status exists:

```svelte
<div data-testid="card-status-stack" class="absolute top-3 right-3 ...">
	{#if highestClearedDifficulty}...clear badge...{/if}
	{#if featuredProgress}...existing progress chip...{/if}
</div>
```

Move the current progress chip into this stack and remove its own absolute positioning.

Use a small vertical gap; no card size change.

### 2.5 Render the clear badge

Render:

- compact translucent background matching existing card status chrome;
- small check mark;
- existing `DifficultyGems` with `showPieceCount={false}`;
- badge wrapper `role="img"`;
- explicit accessible name built with existing `getDifficultyLabel(highestClearedDifficulty)`.

Keep the check + gems inside an `aria-hidden="true"` child so the outer badge contributes exactly:

```text
Highest cleared difficulty: Hard
```

Do not duplicate the piece count in the badge; it already appears in the difficulty picker directly below and is the main horizontal-space risk on 2-column mobile cards.

No new image asset.

### 2.6 Run focused component tests

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/components/__tests__/DifficultyGems.svelte.test.ts \
  src/lib/components/__tests__/PuzzleCard.svelte.test.ts
```

Expected: pass.

---

## Task 3: Wire Gallery and Bookmarks through the shared read model

### Files

- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`
- Modify: `apps/web/src/routes/bookmarks/+page.svelte`
- Modify: `apps/web/src/routes/bookmarks/page.svelte.test.ts`

### 3.1 Add failing Gallery tests

Cover:

- authenticated Gallery calls `clearedDifficulties.load()`;
- local completion produces the expected card badge;
- a local stats write landing after mount updates the badge without a remount (mount while the write is pending, then bump `statsRevision`);
- account clear map produces the expected card badge;
- local Easy + account Hard shows Hard;
- just-remounted Gallery reads current local stats rather than a stale cached local snapshot;
- clear + saved progress coexist on one card;
- account store error/empty map does not replace Gallery content or local clear state;
- appended infinite-scroll family rows get the same read-model treatment.

Prefer observable card DOM over asserting implementation details.

Before adding these tests, use one consistent local-stats strategy in both route suites:

- Gallery already mocks `$lib/services/stats`; extend that mock with a controllable `getStats` alongside `getBestTime`;
- Bookmarks must add the same `getBestTime` + controllable `getStats` module mock rather than seeding localStorage;
- mock `$lib/stores/clearedDifficulties` as a readable `ReadonlyMap` store with `load()`;
- keep `$lib/services/gameplay/highestClearedDifficulty` real so both route suites exercise the actual local/account composition helper;
- do not add `getPlayerStats` to route API mocks when the account store itself is mocked.

### 3.2 Wire Gallery

Import:

- `clearedDifficulties`;
- clear read-model helper.

Extend the existing authenticated load effect:

```ts
if ($playerAuth.status === 'authenticated') {
	void bookmarks.load();
	void clearedDifficulties.load();
}
```

Derive through the required helper so async account results, infinite-scroll appends, and local stats writes landing mid-view all update the cards:

```ts
const highestClearedByFamily = $derived(
	resolveHighestClearedForFamilies(families, $clearedDifficulties, $statsRevision)
);
```

Pass the resolved value into `PuzzleCard`.

Do not couple this to saved-progress discovery; completion and in-progress are independent states.

### 3.3 Add failing Bookmarks tests

Mock the new account store as a readable clear map alongside the existing bookmark/auth stores, add the same controllable `getStats` module mock used by Gallery, and keep `highestClearedDifficulty.ts` real.

Cover:

- authenticated Bookmarks calls both `bookmarks.load()` and `clearedDifficulties.load()`;
- bookmarked family receives local clear state;
- a local stats write landing after mount updates the badge without a remount;
- bookmarked family receives account clear state;
- equivalent input yields the same displayed badge as Gallery;
- account stats failure does not block bookmark cards;
- clear state disappears after shared store identity reset/logout.

### 3.4 Wire Bookmarks

Keep bookmark store behavior unchanged.

Add the same clear-state load call and derive through the same required helper:

```ts
const highestClearedByFamily = $derived(
	resolveHighestClearedForFamilies($bookmarks.families, $clearedDifficulties, $statsRevision)
);
```

Pass `highestClearedDifficulty` into each `PuzzleCard`.

No second account pagination implementation is allowed in the route.

Bookmarks currently does not pass `progressByVariantId` to `PuzzleCard`. Keep that existing behavior in HPA-467: this ticket guarantees **clear-state parity**, while Gallery remains the route that exercises clear + saved-progress coexistence. Do not add a second saved-progress discovery path to Bookmarks here.

Do not wire `profile/+page.svelte` in this ticket. Its `PuzzleCard` usage is the separate My Puzzles ownership surface, and Profile already owns a dedicated Puzzle Results section.

### 3.5 Run focused route tests

```bash
bun run --cwd apps/web test:unit -- \
  src/routes/page.svelte.test.ts \
  src/routes/bookmarks/page.svelte.test.ts
```

Expected: pass.

---

## Task 4: Final verification and scope review

### 4.1 Run all focused HPA-467 tests

Use the same command shape as CI:

```bash
bun run --cwd apps/web test:unit -- \
  src/lib/services/gameplay/highestClearedDifficulty.test.ts \
  src/lib/stores/clearedDifficulties.test.ts \
  src/lib/components/__tests__/DifficultyGems.svelte.test.ts \
  src/lib/components/__tests__/PuzzleCard.svelte.test.ts \
  src/routes/page.svelte.test.ts \
  src/routes/bookmarks/page.svelte.test.ts
```

### 4.2 Type/Svelte check

```bash
bun run check
```

Expected: 0 TypeScript/Svelte errors.

### 4.3 Broader web unit gate

Run the exact existing web unit command:

```bash
bun run --cwd apps/web test:unit
```

Do not substitute `bun run test`; that also invokes E2E. Do not add a new E2E spec by default.

### 4.4 Scope review

Confirm the implementation does **not** add:

- backend/API/D1 changes;
- completion persistence changes;
- a generic remote-state framework;
- a second auth/account owner;
- per-difficulty card-button checkmarks;
- new mobile behavior;
- generated image assets;
- unrelated Gallery/Bookmarks refactors.

## Implementation checklist

- [ ] 1. Add shared clear read model + clear-specific account store with canonical ranking, limit-100 pagination, abort/stale guards
- [ ] 2. Add compact `DifficultyGems` mode + accessible `PuzzleCard` clear badge + collision-tested status stack
- [ ] 3. Wire Gallery and Bookmarks through the same clear read model
- [ ] 4. Run focused tests, `bun run check`, broader web unit gate, and scope review

## Risks

- **Later-page Hard clear hidden by partial data:** publish account state only after cursor exhaustion.
- **Old account badges after switch/logout:** clear on identity change, abort, and version-guard results.
- **Assisted/rotation/relaxed clears missing:** use `totalCompletions`, never best time.
- **Local completion appears late:** read local stats fresh from visible families; do not cache local clear state. Because the Web-Lock `recordLocalCompletion` write can still be in flight when the route mounts, routes also track `statsRevision` so a late-landing write re-runs local discovery without a remount — critical for anonymous players, who never trigger an account-map fetch.
- **Status collision:** the badge omits duplicate piece-count text; a 390×844 browser test checks both vertical collision with the title/bookmark row and horizontal collision with the category badge.
- **Accessible-name loss:** the badge is `role="img"` and is tested by role + name, not only an attribute.
- **Mock drift:** both route suites use the same controllable `getStats` mock shape and keep the real clear read-model service.
- **Over-engineering:** one purpose-built store plus one narrow service; no reusable remote-state abstraction.
- **Wrong implied progression:** display one highest observed clear only; never synthesize lower clears.

## Planning verification

- HPA-467 is High priority, In Progress, and attached to draft PR #88.
- HPA-466 is complete and merged; PR #88 is the only current HPA-467 implementation/planning PR.
- `PuzzleCard` is shared by Gallery and Bookmarks and already owns the artwork status area.
- `getStats` exposes the correct local `totalCompletions` aggregate.
- `getPlayerStats` already supports cursor + abort signal.
- `PlayerStatRow` already carries family id, difficulty, and total completions, so no family/variant lookup endpoint is needed for account rows.
- `bookmarks.ts` provides account identity/version/load-dedupe; Gallery/Profile provide abort/signal handling.
- `/api/player/stats` defaults to 20 while `listPlayerStats` clamps at 100; this plan explicitly requests `limit: 100` on every page.
- `PUZZLE_DIFFICULTIES` is the canonical Easy/Normal/Hard order; one module-level `CLEAR_RANK_DESC` reverses it once rather than hardcoding another ranking or allocating per family.
- Gallery's current stats mock exposes only `getBestTime`; Gallery and Bookmarks will both use the same controllable `getStats` module-mock shape for local clear coverage.
- Vitest browser mode supports `page.viewport(width, height)`, so the narrow-card overlap check stays in the existing component test suite.
- Profile's My Puzzles `PuzzleCard` surface remains outside HPA-467.
- No generated art task is required.
- Planning branch remains documentation-only until implementation starts.
