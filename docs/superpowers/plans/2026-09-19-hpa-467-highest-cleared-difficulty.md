# HPA-467 Highest Cleared Difficulty on Puzzle Cards — Implementation Plan

> Continue implementation on this same branch/PR. One Linear ticket -> one PR.

**Goal:** Show one truthful highest-cleared-difficulty badge on web Gallery and Bookmarks cards by merging current-device completion stats with fully paginated signed-in account stats.

**Architecture:** Keep local completion truth in `stats.ts`. Add `highestClearedDifficulty.ts` as the shared local-read + pure merge service, and keep `clearedDifficulties.ts` account-only. The store reuses bookmarks' identity/version/load-dedupe pattern plus Gallery/Profile abort semantics, exhausts account stats with `limit: 100`, and publishes one final map. Gallery and Bookmarks reactively call the same required family composition helper. `PuzzleCard` receives only the resolved difficulty and renders it in a shared top-right status stack with saved progress.

**Tech stack:** Svelte 5, TypeScript, Svelte stores, existing `getPlayerStats` API client, Vitest + vitest-browser-svelte.

## Global constraints

- One implementation PR; keep implementation on this planning branch/PR.
- No API endpoint, backend, workflow, D1, or completion-write changes.
- Do not change `getStats` / `recordLocalCompletion` semantics.
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
- `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts`
- `apps/web/src/routes/+page.svelte`
- `apps/web/src/routes/page.svelte.test.ts`
- `apps/web/src/routes/bookmarks/+page.svelte`
- `apps/web/src/routes/bookmarks/page.svelte.test.ts`

**Do not modify by default**

- `apps/web/src/lib/services/api.ts`
- `apps/web/src/lib/services/stats.ts`
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
): PuzzleDifficulty | null
```

Walk the shared tuple in reverse rather than introducing another ranking constant:

```ts
for (const difficulty of [...PUZZLE_DIFFICULTIES].toReversed()) {
  // hard -> normal -> easy
}
```

A difficulty matches when either local variant id or account family+difficulty contains it.

No inferred lower clears.

### 1.3 Add local discovery helper

Add a thin helper that reads visible families through existing `getStats`:

```ts
readLocalClearedVariantIds(families)
```

Include a variant only when:

```ts
getStats(variant.id)?.totalCompletions > 0
```

Keep `stats.ts` unchanged.

Add the required route composition helper:

```ts
resolveHighestClearedForFamilies(families, accountClearedByFamily)
```

It returns `ReadonlyMap<familyId, PuzzleDifficulty>`, performs local discovery once for the supplied family list, and calls the pure resolver. Gallery and Bookmarks must use this helper; neither route may inline local discovery + merge logic.

### 1.4 Write failing account-store tests

Model the existing bookmarks store test style.

Cover:

1. anonymous account -> empty/idle;
2. authenticated `load()` fetches stats;
3. rows with `totalCompletions <= 0` are ignored;
4. account rows are grouped by `familyId` and `difficulty`;
5. `nextCursor` is followed until exhausted;
6. intermediate pages do **not** publish partial state;
7. final page publishes one complete map;
8. any page failure yields error + empty account map;
9. repeated load for the same already-loaded account is deduped;
10. logout clears old account data;
11. account switch clears old data before new data arrives;
12. stale old-account response cannot repopulate state;
13. active request chain is aborted on identity change;
14. `AbortError` and stale-version completions are ignored rather than published as failures;
15. a real failure leaves the map empty and does not mark the account loaded, allowing retry;
16. transient auth `loading` for the same observed account does not flicker away a valid loaded snapshot;
17. every stats request uses `limit: 100`.

### 1.5 Implement `createClearedDifficultiesStore`

Reuse `bookmarks.ts` for identity/version/load-dedupe, but copy abort/signal/error handling from Gallery/Profile rather than pretending bookmarks already owns cancellation. Accept an injected auth readable, matching `createBookmarksStore(auth)`, so store tests control account transitions directly.

State:

```ts
{
  accountId,
  status,
  byFamily
}
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
- on real identity change: bump version, abort active request, reset state with new account id.

`load()`:

- return immediately if no account;
- dedupe same-account loaded/in-flight requests;
- create one controller and captured version;
- call `getPlayerStats({ limit: 100, cursor, signal })` on every page;
- follow every cursor page;
- accumulate only `totalCompletions > 0`;
- do not call `set()` with partial pages;
- publish once when pagination is complete and still current;
- ignore `AbortError` and stale-version completion without changing the current identity's status;
- on current non-abort failure publish `status: 'error'` with empty map and leave `loadedAccountId` unset.

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
- exact accessible label `Highest cleared difficulty: <Label>`;
- matching family variant drives `DifficultyGems`;
- progress-only layout still works;
- clear-only layout works;
- clear + progress both render inside one status-stack container;
- the clear badge is independently queryable as `data-testid="card-cleared-difficulty"`;
- both states remain independently queryable;
- at `await page.viewport(390, 844)`, status-stack/title/bookmark bounding boxes do not overlap in the existing narrow `343 / 215` artwork layout;
- restore the default test viewport after the responsive assertion;
- bookmark button and all three difficulty actions remain unchanged.

### 2.2 Extend `PuzzleCard` props

Add:

```ts
highestClearedDifficulty?: PuzzleDifficulty | null;
```

No stats objects, account state, or resolver logic inside the component.

### 2.3 Replace the single progress position with a status stack

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

### 2.4 Render the clear badge

Render:

- compact translucent background matching existing card status chrome;
- small check mark;
- existing `DifficultyGems` for the resolved difficulty;
- explicit badge `aria-label` built with the existing `getDifficultyLabel(highestClearedDifficulty)` helper rather than another label table.

Use:

```ts
family.variants[highestClearedDifficulty].pieceCount
```

for `DifficultyGems`.

Wrap the decorative visual content in `aria-hidden="true"` so the badge contributes only:

```text
Highest cleared difficulty: Hard
```

No new image asset.

### 2.5 Run focused component tests

```bash
bun run --cwd apps/web test:unit -- src/lib/components/__tests__/PuzzleCard.svelte.test.ts
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
- account clear map produces the expected card badge;
- local Easy + account Hard shows Hard;
- just-remounted Gallery reads current local stats rather than a stale cached local snapshot;
- clear + saved progress coexist on one card;
- account store error/empty map does not replace Gallery content or local clear state;
- appended infinite-scroll family rows get the same read-model treatment.

Prefer observable card DOM over asserting implementation details.

Before adding these tests, extend the existing Gallery mocks deliberately:

- `$lib/services/stats` currently exposes only `getBestTime`; add `getStats` for local-clear scenarios (or seed localStorage while preserving the real `getStats`);
- mock `$lib/stores/clearedDifficulties` like the existing bookmarks store;
- keep `$lib/services/gameplay/highestClearedDifficulty` real so route tests exercise the actual local/account composition helper;
- do not add `getPlayerStats` to the Gallery API mock when the account store itself is mocked.

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

Derive through the required helper so async account results and infinite-scroll appends both update the cards:

```ts
const highestClearedByFamily = $derived(
  resolveHighestClearedForFamilies(families, $clearedDifficulties.byFamily)
);
```

Pass the resolved value into `PuzzleCard`.

Do not couple this to saved-progress discovery; completion and in-progress are independent states.

### 3.3 Add failing Bookmarks tests

Mock the new account store alongside the existing bookmark/auth stores, but keep `highestClearedDifficulty.ts` real.

Cover:

- authenticated Bookmarks calls both `bookmarks.load()` and `clearedDifficulties.load()`;
- bookmarked family receives local clear state;
- bookmarked family receives account clear state;
- equivalent input yields the same displayed badge as Gallery;
- account stats failure does not block bookmark cards;
- clear state disappears after shared store identity reset/logout.

### 3.4 Wire Bookmarks

Keep bookmark store behavior unchanged.

Add the same clear-state load call and derive through the same required helper:

```ts
const highestClearedByFamily = $derived(
  resolveHighestClearedForFamilies($bookmarks.families, $clearedDifficulties.byFamily)
);
```

Pass `highestClearedDifficulty` into each `PuzzleCard`.

No second account pagination implementation is allowed in the route.

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

Run the repo's existing web/unit command used by CI if focused tests pass.

Do not add a new E2E spec by default.

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
- [ ] 2. Add `PuzzleCard` clear badge + shared top-right status stack
- [ ] 3. Wire Gallery and Bookmarks through the same clear read model
- [ ] 4. Run focused tests, `bun run check`, broader web unit gate, and scope review

## Risks

- **Later-page Hard clear hidden by partial data:** publish account state only after cursor exhaustion.
- **Old account badges after switch/logout:** clear on identity change, abort, and version-guard results.
- **Assisted/rotation/relaxed clears missing:** use `totalCompletions`, never best time.
- **Local completion appears late:** read local stats fresh from visible families; do not cache local clear state.
- **Status collision:** clear + progress share one vertical status stack; a 390×844 browser test pins it away from the title/bookmark row.
- **Mock drift:** route tests extend the existing stats/store mocks intentionally and keep the real clear read-model service.
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
- `PUZZLE_DIFFICULTIES` is the canonical Easy/Normal/Hard order; the resolver reverses it rather than hardcoding a second ranking.
- Gallery's current stats mock exposes only `getBestTime`; implementation must extend it intentionally for local clear coverage.
- Vitest browser mode supports `page.viewport(width, height)`, so the narrow-card overlap check stays in the existing component test suite.
- Profile's My Puzzles `PuzzleCard` surface remains outside HPA-467.
- No generated art task is required.
- Planning branch remains documentation-only until implementation starts.
