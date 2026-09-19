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

Use one dedicated clear-state store plus one pure family resolver.

This follows the existing `bookmarks.ts` pattern closely enough to reuse proven account-transition semantics, but keeps the state purpose-specific: only account clear rows are cached.

### Account clear store

Add:

`apps/web/src/lib/stores/clearedDifficulties.ts`

State shape:

```ts
interface ClearedDifficultiesState {
  accountId: string | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  byFamily: ReadonlyMap<string, ReadonlySet<PuzzleDifficulty>>;
}
```

The store observes `playerAuth` only for identity changes and exposes an explicit `load()`, matching the existing bookmarks store style.

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

Mirror the existing bookmarks store behavior:

- retain the current account snapshot through a transient `playerAuth.status === 'loading'` refresh when the same account is still being resolved;
- when auth becomes anonymous, clear account-derived clears immediately;
- when a different authenticated user id appears, clear the previous map immediately before loading the new account;
- increment a version token on identity change;
- abort the active stats request chain when identity changes;
- ignore any response whose captured version no longer matches.

This prevents old-account clear badges from appearing after logout or account switch.

## Exhaustive account pagination

`load()` must follow `nextCursor` until it is absent.

Pseudo-flow:

```ts
let cursor: string | undefined;
const next = new Map<string, Set<PuzzleDifficulty>>();

do {
  const page = await getPlayerStats({ cursor, signal });
  for (const row of page.stats) {
    if (row.totalCompletions <= 0) continue;
    add(row.familyId, row.difficulty);
  }
  cursor = page.nextCursor;
} while (cursor !== undefined);
```

Do not publish partial pages.

Build the next map in a local variable and commit it to the store only after the final cursor is consumed. This matters because a partial account snapshot can lie about the **highest** clear: an Easy row from page 1 could be published while a Hard row for the same family is still on a later page.

If any page fails:

- leave `byFamily` empty for that account load;
- set status to `error`;
- do not block Gallery or Bookmarks;
- local completion discovery continues independently.

No retry UI is required for this ticket.

## Current-device clear discovery

Keep local completion truth in `stats.ts`.

Add a small helper in the clear-state module:

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

Resolve in descending order:

```ts
hard -> normal -> easy
```

For each difficulty, the family is cleared when either source says so:

- local: `localClearedVariantIds.has(family.variants[difficulty].id)`
- account: `accountClearedByFamily.get(family.id)?.has(difficulty)`

Return the first match; otherwise `null`.

This explicitly permits Hard-only completion. Returning Hard does not claim Easy or Normal were completed.

A convenience helper may build a `ReadonlyMap<familyId, PuzzleDifficulty>` for a route's current family list, but it should remain a thin composition of local discovery + the pure resolver.

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

Derive the current family clear map from:

- current `families`;
- fresh local completion reads;
- `$clearedDifficulties.byFamily`.

Pass:

```svelte
highestClearedDifficulty={highestClearedByFamily.get(family.id) ?? null}
```

to each `PuzzleCard`.

Infinite-scroll append naturally re-derives for newly loaded families.

### Bookmarks

Keep bookmark loading unchanged and add the same clear-state `load()` call for authenticated users.

Derive highest clears from `$bookmarks.families` and the shared account store.

Do not make Bookmarks depend on Gallery state or introduce a cross-route family cache.

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
- existing `DifficultyGems` presentation for the resolved difficulty;
- difficulty-specific gem accent already owned by `DifficultyGems`.

The badge gets:

```text
Highest cleared difficulty: Hard
```

as its explicit accessible label.

Wrap the decorative check + `DifficultyGems` content in an `aria-hidden="true"` child so the badge exposes one concise accessible name rather than duplicate nested labels.

Reuse `family.variants[highestClearedDifficulty].pieceCount` when rendering `DifficultyGems`.

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

- The clear badge has one explicit label: `Highest cleared difficulty: <label>`.
- Decorative child content is hidden from the accessibility tree.
- Existing progress chip behavior remains unchanged.
- Clear + progress coexist as separate siblings in the status stack.
- No new live region is needed; this is persistent state, not an announcement event.

## File map

**Add**

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

- `apps/web/src/lib/services/stats.ts` completion semantics;
- `apps/web/src/lib/services/api.ts` contract;
- `packages/types/**`;
- `PuzzleDifficultyPicker.svelte`;
- backend/workflows/D1;
- NativeScript/mobile code;
- generated assets.

## Test strategy

### Clear-state store / pure resolver

Prove:

- no clears -> null;
- local Easy / Normal / Hard resolve correctly;
- multiple local clears choose the highest;
- account clears resolve correctly;
- local + account merge chooses the highest source result;
- Hard-only returns Hard without synthesizing lower difficulties;
- rows with `totalCompletions === 0` are ignored;
- cursor pages are followed until exhausted;
- no partial snapshot is published before the final page;
- page failure produces error + empty account map;
- logout clears old account state;
- account switch clears old state before the new load;
- stale/aborted old-account responses cannot repopulate the map;
- repeated `load()` for an already-loaded account is deduped.

### PuzzleCard component

Prove:

- no resolved difficulty -> no clear badge;
- Easy / Normal / Hard produce the expected badge;
- accessible label is exact;
- clear badge uses the matching family variant's difficulty presentation;
- progress-only still renders;
- clear-only renders;
- clear + progress render inside the same non-overlapping status stack;
- existing bookmark and difficulty actions remain intact.

### Gallery route

Prove:

- authenticated route requests clear-state loading;
- a local completion is reflected on the family card;
- account-derived clear state reaches the card;
- mixed local/account state resolves to the highest difficulty;
- progress chip and clear badge coexist;
- account clear load failure does not replace the Gallery error/loading state.

### Bookmarks route

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
5. **Badge/progress overlap** — one top-right vertical status stack owns both.
6. **Over-generalization** — dedicated clear store only; no generic fetch/cache abstraction.
7. **Accidental progression semantics** — the resolver returns one displayed maximum only; it does not infer lower clears.
8. **Scope creep into mobile/backend** — explicitly excluded.

## Delivery guardrail

One implementation PR for HPA-467.

This planning branch and draft PR remain the implementation branch/PR. Do not split the clear-state store, Gallery wiring, Bookmarks wiring, or card presentation into separate PRs.
