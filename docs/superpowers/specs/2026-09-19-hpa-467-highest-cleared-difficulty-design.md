# HPA-467: Highest Cleared Difficulty on Puzzle Cards — Design

**Linear:** HPA-467  
**Status:** Design for implementation  
**Date:** 2026-09-19

## Context

HPA-467 is the next actionable Perseus ticket after HPA-466: it is High priority, unblocked, and the repository currently has no open implementation PR.

The requested behavior is deliberately small: show one family-level badge for the highest difficulty the player has actually completed in the web Gallery and Bookmarks.

Current code already provides the needed seams:

- `PuzzleCard.svelte` owns the artwork status area. It already renders the saved-progress chip in the top-right corner and is reused by Gallery and Bookmarks.
- `apps/web/src/lib/services/stats.ts` is the current-device completion source. `getStats(variant.id)?.totalCompletions > 0` is the correct local clear signal.
- `getPlayerStats()` already wraps authenticated `GET /api/player/stats` and exposes cursor pagination.
- `PlayerStatRow` is already family-scoped: `familyId`, `difficulty`, and `totalCompletions`.
- `playerAuth` exposes a stable account id and the existing bookmarks store already demonstrates the correct login/logout/account-switch stale-response guard.
- Gallery already derives current-device saved progress and Bookmarks already renders the same `PuzzleCard`; neither needs a new backend contract.

The implementation should reuse those seams rather than introduce a new progression subsystem.

## Goals

1. Show no clear badge for a family with no completed difficulty.
2. Otherwise show exactly one badge for the highest cleared difficulty in the order Easy < Normal < Hard.
3. Count any completion where `totalCompletions > 0`; do not infer clears from best-time fields.
4. Merge current-device and signed-in-account clears.
5. Load every page of account stats before publishing the account clear snapshot.
6. Clear old-account data immediately when the authenticated account changes or logs out, and ignore stale responses.
7. Keep Gallery and Bookmarks behavior identical through one shared clear-state seam.
8. Keep the clear badge visually separate from current saved progress; both may be visible on one card.
9. Reflect a just-completed local run when the user returns to Gallery without waiting for server refresh.
10. Keep failure non-blocking: local clear badges remain available if account stats cannot load.

## Non-goals

- New completion tables, D1 migrations, endpoints, or completion-write behavior.
- Changes to points, achievements, mastery, leaderboard, result classes, or best-time rules.
- Per-difficulty completion marks inside `PuzzleDifficultyPicker`.
- A generic remote-state framework, generic account store, or generalized progression cache.
- NativeScript/mobile parity.
- New generated artwork, sound, haptics, or animation framework.
- Changing `PuzzleDifficultyPicker` behavior unless a tiny visual adjustment is needed after the badge lands.

## Selected architecture

Use one dedicated account-clear store plus one small clear read-model service:

- `apps/web/src/lib/stores/clearedDifficulties.ts` owns **account state only**: auth identity, request lifecycle, exhaustive stats pagination, stale rejection, and the final family -> cleared-difficulties map.
- `apps/web/src/lib/services/gameplay/highestClearedDifficulty.ts` owns local `getStats` reads plus the pure local/account merge used by both routes.

This follows the existing `bookmarks.ts` identity/version/load-dedupe pattern without turning clears into a generic remote-state framework. Abort/signal behavior comes from the existing Gallery/Profile request pattern, because `bookmarks.ts` itself does not use `AbortController`.

### Account clear store

Add:

`apps/web/src/lib/stores/clearedDifficulties.ts`

Public value shape:

```ts
ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>
```

The store observes `playerAuth` only for identity changes and exposes `subscribe` plus an explicit `load()`, matching the existing bookmarks store's lifecycle pattern without copying its UI-facing status/error state.

`currentAccountId`, `loadedAccountId`, in-flight promise/error state, version, and abort controller stay internal because no HPA-467 consumer renders them.

It does **not** own localStorage completion data.

### Why a small store is justified

Gallery and Bookmarks are separate routes. If each route independently implemented:

- auth transition handling;
- cursor traversal;
- stale-response rejection;
- account-switch clearing;
- failure fallback;

the ticket would immediately duplicate the hardest logic.

A dedicated `clearedDifficulties` store avoids that duplication without becoming a generic API/cache abstraction.

## Account identity and stale-response rules

Reuse the existing bookmarks store's **identity/version/load-dedupe** behavior:

- inject the auth readable into `createClearedDifficultiesStore(auth = playerAuth)` so identity transitions are directly testable;
- retain the current account snapshot through a transient `playerAuth.status === 'loading'` refresh when the same account is still being resolved;
- when auth becomes anonymous, clear account-derived clears immediately;
- when a different authenticated user id appears, clear the previous map immediately before loading the new account;
- increment a version token on identity change;
- abort the active stats request chain when identity changes;
- ignore any response whose captured version no longer matches.

For cancellation, follow Gallery/Profile rather than `bookmarks.ts`: an `AbortError` or a result that has become stale is expected control flow and must not mutate the currently published clear map.

This prevents old-account clear badges from appearing after logout or account switch.

## Exhaustive account pagination

`load()` must follow `nextCursor` until it is absent.

Pseudo-flow:

```ts
let cursor: string | undefined;
const next = new Map<string, Set<PuzzleDifficulty>>();

do {
  const page = await getPlayerStats({ limit: 100, cursor, signal });
  for (const row of page.stats) {
    if (row.totalCompletions <= 0) continue;
    add(row.familyId, row.difficulty);
  }
  cursor = page.nextCursor;
} while (cursor !== undefined);
```

Use the API/repository's existing maximum page size, `limit: 100`, on **every** page. The route defaults to 20 while the repository already clamps at 100, so using 100 reduces round trips without changing any contract.

Do not publish partial pages.

Build the next map in a local variable and commit it to the store only after the final cursor is consumed. This matters because a partial account snapshot can lie about the **highest** clear: an Easy row from page 1 could be published while a Hard row for the same family is still on a later page.

If any current, non-abort page fails:

- leave the published map empty for that account load;
- do **not** mark the account as loaded, so a later `load()` may retry;
- do not block Gallery or Bookmarks;
- local completion discovery continues independently.

If the request is aborted or its captured version is stale, ignore it without changing the published map.

No retry UI is required for this ticket.

## Current-device clear discovery

Keep local completion truth in `stats.ts`.

Add a small helper in `apps/web/src/lib/services/gameplay/highestClearedDifficulty.ts`:

```ts
function readLocalClearedVariantIds(
  families: readonly PuzzleFamilySummary[]
): ReadonlySet<string>
```

For every family variant, include `variant.id` only when:

```ts
getStats(variant.id)?.totalCompletions > 0
```

Do not use `standardBestTime`.

This helper is intentionally uncached. Gallery/Bookmarks have bounded visible family lists, and rereading three local records per rendered family is simpler than introducing invalidation infrastructure.

When returning from a completed puzzle, the Gallery route remounts/re-evaluates its family read model and sees the freshly written local stats immediately.

## Pure highest-difficulty resolver

Keep ranking/merge logic pure:

```ts
export function resolveHighestClearedDifficulty(
  family: PuzzleFamilySummary,
  localClearedVariantIds: ReadonlySet<string>,
  accountClearedByFamily: ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>
): PuzzleDifficulty | null
```

Derive descending canonical order once at module scope rather than allocating per family:

```ts
const CLEAR_RANK_DESC: readonly PuzzleDifficulty[] = [...PUZZLE_DIFFICULTIES].reverse();

for (const difficulty of CLEAR_RANK_DESC) {
  // hard -> normal -> easy from the shared canonical tuple
}
```

This keeps one ranking source while avoiding a new `toReversed()` baseline and repeated array allocation.

For each difficulty, the family is cleared when either source says so:

- local: `localClearedVariantIds.has(family.variants[difficulty].id)`
- account: `accountClearedByFamily.get(family.id)?.has(difficulty)`

Return the first match; otherwise `null`.

This explicitly permits Hard-only completion. Returning Hard does not claim Easy or Normal were completed.

The shared family-list composition helper is **required**, not optional:

```ts
export function resolveHighestClearedForFamilies(
  families: readonly PuzzleFamilySummary[],
  accountClearedByFamily: ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>
): ReadonlyMap<string, PuzzleDifficulty>
```

It performs the fresh local discovery once for the supplied families and calls the pure resolver for each family. Gallery and Bookmarks must call this helper rather than duplicating local discovery + merge logic.

## Route integration

### Gallery

Gallery already has:

- `families`;
- auth observation;
- a `PuzzleCard` loop.

Add one load call beside the existing bookmark load:

```ts
if ($playerAuth.status === 'authenticated') {
  void bookmarks.load();
  void clearedDifficulties.load();
}
```

Keep the family result reactive to both infinite-scroll family changes and the async account snapshot:

```ts
const highestClearedByFamily = $derived(
  resolveHighestClearedForFamilies(families, $clearedDifficulties)
);
```

Pass:

```svelte
highestClearedDifficulty={highestClearedByFamily.get(family.id) ?? null}
```

to each `PuzzleCard`.

Infinite-scroll append naturally re-derives for newly loaded families.

### Bookmarks

Keep bookmark loading unchanged and add the same clear-state `load()` call for authenticated users.

Use the same required helper reactively:

```ts
const highestClearedByFamily = $derived(
  resolveHighestClearedForFamilies($bookmarks.families, $clearedDifficulties)
);
```

Do not make Bookmarks depend on Gallery state or introduce a cross-route family cache.

Bookmarks does **not** currently discover or pass `progressByVariantId`. HPA-467 keeps that existing behavior: clear-state parity between Gallery and Bookmarks is required, but adding saved-progress discovery to Bookmarks is a separate product change. The shared `PuzzleCard` status stack still supports clear + progress coexistence, and Gallery covers that combined state.

`profile/+page.svelte` also renders `PuzzleCard` for the separate **My Puzzles** ownership surface. Leave that route unchanged in HPA-467: the product slice is browse Gallery + Bookmarks, and Profile already owns its own results/stat presentation.

## PuzzleCard presentation

Extend `PuzzleCard` with:

```ts
highestClearedDifficulty?: PuzzleDifficulty | null;
```

Do not pass raw stats into the component. It receives the already-resolved presentation value only.

### Status stack

Today the saved-progress chip is absolutely positioned at `top-3 right-3`.

Replace that single absolute chip with one absolute vertical status stack:

```
[top-right status stack]
  clear badge   (when present)
  progress chip (when present)
```

This guarantees clear and in-progress state can coexist without overlap.

No other card geometry changes are required.

### Clear badge

Use the existing Galaxy Arcade language:

- compact dark translucent chip;
- a small check/clear mark;
- existing `DifficultyGems` gem count/accent for the resolved difficulty;
- **no piece-count text inside the clear badge** — the difficulty picker immediately below already displays it, and removing it protects the narrow two-column card.

The badge gets one explicit accessible label using the existing `getDifficultyLabel()` helper rather than another Easy/Normal/Hard label table:

```ts
`Highest cleared difficulty: ${getDifficultyLabel(highestClearedDifficulty)}`
```

Render the badge itself as:

```svelte
<span
  role="img"
  aria-label={`Highest cleared difficulty: ${getDifficultyLabel(highestClearedDifficulty)}`}
  data-testid="card-cleared-difficulty"
>
  <span aria-hidden="true">
    <!-- check + compact DifficultyGems -->
  </span>
</span>
```

The explicit `role="img"` makes the authored label reliably nameable by assistive technology.

Extend `DifficultyGems` with one backward-compatible presentation prop:

```ts
showPieceCount?: boolean // default true
```

The clear badge passes `showPieceCount={false}`; existing picker callers remain unchanged. Keep passing the variant piece count so the component's existing difficulty semantics/accessibility stay intact outside the badge, while the badge's decorative child is hidden from the accessibility tree.

No new icon asset is needed; use a tiny inline check SVG or text glyph consistent with existing inline card icons.

## Failure behavior

Account stats are enhancement data, not a route gate.

If `getPlayerStats` fails:

- Gallery still loads normally;
- Bookmarks still loads normally;
- local clear state still renders;
- account-derived clear state stays empty for that load;
- no global error banner is introduced.

This keeps the ticket presentation-only from the user's perspective.

## Accessibility

- The clear badge is `role="img"` with one explicit label: `Highest cleared difficulty: <label>`.
- Tests resolve it by role + accessible name, not merely by an `aria-label` attribute.
- Decorative child content is hidden from the accessibility tree.
- Existing progress chip behavior remains unchanged.
- Clear + progress coexist as separate siblings in the status stack.
- No new live region is needed; this is persistent state, not an announcement event.

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

- `apps/web/src/lib/services/stats.ts` completion semantics;
- `apps/web/src/lib/services/api.ts` contract;
- `packages/types/**`;
- `PuzzleDifficultyPicker.svelte`;
- backend/workflows/D1;
- NativeScript/mobile code;
- generated assets.

## Test strategy

### Clear read-model service

Prove:

- local discovery reads `getStats(variant.id)?.totalCompletions > 0`;
- ranking follows one module-level `CLEAR_RANK_DESC` derived from `PUZZLE_DIFFICULTIES`;
- no clears -> null;
- local Easy / Normal / Hard resolve correctly;
- multiple local clears choose the highest;
- account clears resolve correctly;
- local + account merge chooses the highest source result;
- Hard-only returns Hard without synthesizing lower difficulties;
- `resolveHighestClearedForFamilies` returns the same family map for both route consumers.

### Account clear store

Prove:

- rows with `totalCompletions === 0` are ignored;
- every request uses `limit: 100`;
- cursor pages are followed until exhausted;
- no partial snapshot is published before the final page;
- page failure leaves the published map empty and the account retryable;
- logout clears old account state;
- account switch clears old state before the new load;
- stale/aborted old-account responses cannot repopulate the map;
- `AbortError` is ignored without mutating the published map;
- real failure does not set `loadedAccountId`;
- repeated `load()` for an already-loaded account is deduped.

### PuzzleCard component

Prove:

- no resolved difficulty -> no clear badge;
- Easy / Normal / Hard produce the expected badge;
- `getByRole('img', { name: 'Highest cleared difficulty: Hard' })` resolves the badge;
- clear badge uses the matching family variant's difficulty presentation with piece-count text hidden;
- progress-only still renders;
- clear-only renders;
- clear + progress render inside the same non-overlapping status stack;
- the badge uses `data-testid="card-cleared-difficulty"`;
- at a 390×844 viewport, the two-status stack does not overlap the title/bookmark row **or** the top-left category badge in the existing 343/215 mobile artwork layout;
- existing bookmark and difficulty actions remain intact.

### Gallery route

Before adding route coverage, extend the existing module mocks deliberately: both Gallery and Bookmarks route suites should mock `$lib/services/stats` with the same `getBestTime` + controllable `getStats` shape. Gallery already mocks that module and must add `getStats`; Bookmarks must add the same stats mock rather than switching to a different localStorage-seeding strategy. Mock `clearedDifficulties` as a readable clear-map store while leaving the `highestClearedDifficulty` service real; do not mock away the pure/local composition helper.

Prove:

- authenticated route requests clear-state loading;
- a local completion is reflected on the family card;
- account-derived clear state reaches the card;
- mixed local/account state resolves to the highest difficulty;
- progress chip and clear badge coexist;
- account clear load failure does not replace the Gallery error/loading state.

### Bookmarks route

Mock the new account store alongside the existing bookmark/auth stores, add the same controllable `getStats` module mock used by Gallery, and keep the clear read-model service real.

Prove:

- authenticated route requests both bookmark and clear-state loading;
- bookmarked cards receive the same resolved clear state as Gallery for equivalent inputs;
- account failure does not block bookmark rendering;
- logout/auth change removes old account-derived badge state through the shared store.

No new E2E spec is required unless implementation uncovers a layout regression that component/browser tests cannot cover.

## Risks and fences

1. **Partial account pagination** — publish only after all cursors are consumed.
2. **Old-account leakage** — clear on identity change and guard every async result with version + abort.
3. **Incorrect completion signal** — use `totalCompletions > 0` only.
4. **Local state staleness** — do not cache local stats; derive from current localStorage-backed `getStats`.
5. **Badge collisions** — the compact clear badge omits duplicate piece-count text, and a 390×844 browser test asserts the top-right stack intersects neither the title/bookmark row nor the category badge.
6. **Over-generalization** — dedicated clear store only; no generic fetch/cache abstraction.
7. **Accidental progression semantics** — the resolver returns one displayed maximum only; it does not infer lower clears.
8. **Accessible-name loss** — the badge uses `role="img"` + accessible name and is tested by role.
9. **Mock drift** — both route suites use the same controllable `getStats` mock shape and do not replace the real clear read-model service.
10. **Scope creep into Bookmarks progress/Profile/mobile/backend** — Profile My Puzzles, NativeScript, API, and D1 remain unchanged.

## Delivery guardrail

One implementation PR for HPA-467.

This planning branch and draft PR remain the implementation branch/PR. Do not split the clear-state store, Gallery wiring, Bookmarks wiring, or card presentation into separate PRs.
