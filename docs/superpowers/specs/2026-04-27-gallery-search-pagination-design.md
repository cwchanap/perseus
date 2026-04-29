# Gallery Search & Pagination Design

**Date:** 2026-04-27
**Status:** Approved
**PRD reference:** Requirement 1 — Player discovery and gallery (Search + Pagination / infinite scroll)

---

## Summary

Complete the two unimplemented items in PRD Requirement 1:

- **Search** — text search by puzzle name, composing with the existing category filter
- **Pagination / infinite scroll** — load puzzles in batches of 20 with automatic loading on scroll

---

## Decisions

| Question                | Decision                                            |
| ----------------------- | --------------------------------------------------- |
| Expected catalog size   | Large (200+) — server-side work is worth it         |
| Pagination style        | Infinite scroll (auto-load next batch on scroll)    |
| Search scope            | Puzzle name only; composes with category filter     |
| Batch size              | 20 puzzles per page                                 |
| Search placement        | Search bar above category chips                     |
| Implementation approach | Worker-side filter + offset pagination (Approach A) |

---

## API

### `GET /api/puzzles`

Gains four optional query parameters:

| Param      | Type           | Default | Validation                                                      |
| ---------- | -------------- | ------- | --------------------------------------------------------------- |
| `q`        | string         | —       | Case-insensitive substring match on `name`; omit to skip        |
| `category` | PuzzleCategory | —       | Exact match against valid category list; invalid values ignored |
| `offset`   | integer ≥ 0    | `0`     | Non-numeric or negative values fall back to `0`                 |
| `limit`    | integer 1–100  | `20`    | Non-numeric or out-of-range values fall back to `20`            |

Response shape (replaces the existing `{ puzzles: PuzzleSummary[] }`):

```ts
{
  puzzles: PuzzleSummary[]   // page slice only
  total: number              // total matching puzzles (after filter, before pagination)
  offset: number             // echoed from request
  limit: number              // echoed from request
}
```

`total` lets the client determine when there are no more pages: `offset + puzzles.length >= total`.

Invalid pagination params (negative offset, zero limit, non-numeric) fall back to defaults — they do not return a 400. The gallery should never hard-error from a bad URL param.

The Bun route (`puzzles.ts`) gets the same params for runtime parity.

### Shared type update

`PuzzleListResponse` in `packages/types/src/index.ts` adds `total`, `offset`, `limit`:

```ts
export interface PuzzleListResponse {
	puzzles: PuzzleSummary[];
	total: number;
	offset: number;
	limit: number;
}
```

---

## Storage layer

### New function: `listPuzzlesPage`

Added to `apps/api/src/services/storage.worker.ts` (and its Bun counterpart):

```ts
listPuzzlesPage(
  kv: KVNamespace,
  params: { q?: string; category?: PuzzleCategory; offset: number; limit: number }
): Promise<{ puzzles: PuzzleSummary[]; total: number; offset: number; limit: number }>
```

Internal steps:

1. Fetch all puzzle metadata from KV (`Promise.all` — same pattern as `listPuzzles`)
2. Filter to `status === 'ready'`
3. Apply `category` exact match if provided
4. Apply `q` case-insensitive substring match on `name` if provided
5. Sort by `createdAt` descending
6. Record `total` (filtered list length)
7. Slice `[offset, offset + limit]`
8. Return `{ puzzles, total, offset, limit }`

The existing `listPuzzles` function is unchanged — the admin route continues to use it.

The public puzzle route (`puzzles.worker.ts`) switches from `listPuzzles` to `listPuzzlesPage`, parsing and clamping query params before calling.

---

## Frontend

### New component: `SearchBar.svelte`

`apps/web/src/lib/components/SearchBar.svelte`

- Single controlled `<input>` with arcade styling (monospace font, cyan border-focus, search icon prefix)
- Props: `value: string`, `onInput: (value: string) => void`
- No internal debounce — parent owns that

### Changes to `+page.svelte`

**New state:**

```ts
let searchQuery = $state(''); // raw input value
let debouncedQuery = $state(''); // sent to API after 300ms idle
let total = $state(0);
let loadingMore = $state(false);
let hasMore = $derived(offset + puzzles.length < total);
```

**Search debounce:** A `$effect` watches `searchQuery`, sets a 300ms timeout to copy it to `debouncedQuery`, and clears the timeout on each keystroke (cancel-and-reset pattern).

**Fetch trigger:** A `$effect` watching `debouncedQuery` and `selectedCategory`:

1. Cancels any in-flight request via `AbortController`
2. Resets `puzzles = []`, `offset = 0`
3. Fetches the first page

**`loadNextPage()`:** Fetches with `offset = puzzles.length`, appends results to `puzzles`, updates `total`.

**Infinite scroll:** A `<div data-testid="scroll-sentinel">` below the grid. `IntersectionObserver` (set up in `onMount`, torn down on unmount) calls `loadNextPage()` when sentinel enters the viewport, guarded by `hasMore && !loadingMore`.

**Layout order (within the existing `<header>`):**

1. Title row (unchanged)
2. Horizontal rule (unchanged)
3. `SearchBar` — full width, shown once initial load completes (`!loading`)
4. `CategoryFilter` — below search, shown once initial load completes (`!loading`)

### Changes to `api.ts`

`fetchPuzzles` updated signature:

```ts
fetchPuzzles(params?: {
  q?: string
  category?: PuzzleCategory | typeof CATEGORY_ALL
  offset?: number
  limit?: number
}): Promise<{ puzzles: PuzzleSummary[]; total: number; offset: number; limit: number }>
```

Builds `URLSearchParams`, omitting params that are undefined or equal to their defaults (`CATEGORY_ALL`, `offset=0`, `limit=20`). Returns the full response object (not just `.puzzles`).

### Empty states

| Condition                                | State shown                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| No puzzles exist at all                  | Existing "NO MISSIONS AVAILABLE" empty state (unchanged)                                                                    |
| Active query/filter returns zero results | New "NO MISSIONS MATCH YOUR SCAN" state with a "CLEAR FILTERS" button that resets both `searchQuery` and `selectedCategory` |

### Error handling

- **Debounce race / stale responses:** Each filter/search change creates a new `AbortController` and cancels the previous in-flight fetch. Stale responses are silently dropped.
- **`loadingMore` guard:** `loadNextPage()` is a no-op if `loadingMore === true` or `!hasMore`.
- **`total` drift:** If a puzzle is deleted while the user is scrolling, the next page response returns a fresh `total`. `hasMore` recalculates correctly.
- **Load-more network error:** Shows an inline retry prompt below the grid (not a full-page error — the already-loaded cards remain usable).
- **Initial load error:** Unchanged from today (full-page `SYS_ERR` panel with RETRY SCAN).

---

## Testing

### Storage unit tests (`storage.worker.test.ts`)

- No results → returns `{ puzzles: [], total: 0, offset: 0, limit: 20 }`
- Correct page slice (offset + limit)
- `q` filter: case-insensitive, partial match on name
- `category` filter: exact match
- Combined `q + category` filter
- `offset` beyond `total` → returns empty puzzles, correct `total`
- Invalid `offset`/`limit` fall back to defaults

### API route tests (`puzzles.worker.test.ts`)

- No params → first 20, includes `total/offset/limit` fields
- `?q=forest` → filters by name
- `?category=Nature` → filters by category
- `?q=forest&category=Nature` → composed filter
- `?offset=20&limit=20` → correct slice
- Invalid params (`offset=-1`, `limit=0`, `limit=999`) → defaults applied, not 400

### `api.ts` unit tests

- Query param serialisation: omitted params not appended as empty strings
- `CATEGORY_ALL` not appended to URL
- Returns full `{ puzzles, total, offset, limit }` shape

### `SearchBar.svelte` component test

- Renders input with correct placeholder
- Calls `onInput` on change

### `+page.svelte` component tests

- Existing tests updated to mock paginated response shape
- Search input triggers fetch with `q` param after debounce
- Scroll sentinel intersection triggers `loadNextPage`
- "No results" state shown when `total === 0` and query is active
- "CLEAR FILTERS" resets both search and category

### E2E (`gallery.spec.ts`)

- Existing mock payloads updated to paginated shape
- Type into search → grid updates
- Scroll to bottom → second page appended to grid

---

## Out of scope

- Server-side full-text search index (not needed at this scale)
- Search by fields other than `name`
- Cursor-based KV pagination (offset is sufficient since full list is always loaded internally)
- Virtualized rendering / windowing (200–500 cards is fine for DOM)
