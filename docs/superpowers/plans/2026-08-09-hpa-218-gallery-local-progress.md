# HPA-218 Gallery Local Progress and Continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the newest valid unfinished current-device puzzle session in a compact gallery
Continue area, show placed/total progress on matching server gallery cards, and reuse the existing
puzzle route for resume hydration without adding any network request or compatibility path.

**Architecture:** Add one synchronous `galleryProgress` service that converts the server summaries
already held by the gallery plus `listQuick()` metadata into `SessionValidationContext`s, then
delegates loading, current-schema validation, invalid cleanup, and resumability to the existing
`SessionStorageAdapter`. The gallery owns discovery lifecycle and presentation; `PuzzleCard`
receives only an optional placed count. The puzzle route is unchanged.

**Tech Stack:** TypeScript, Svelte 5, SvelteKit, Vitest browser mode, Playwright, Bun, existing
`@perseus/types` grid helpers, existing PuzzleSession persistence codec

## Global Constraints

- Design baseline:
  `docs/superpowers/specs/2026-08-09-hpa-218-gallery-local-progress-design.md`.
- Linear issue:
  `https://linear.app/cwchanap/issue/HPA-218/gameplay-ux-show-local-progress-and-continue-in-the-gallery`.
- HPA-556 is complete; read only `PersistedPuzzleSessionV1` / current schema.
- Do not add migrations, legacy readers, recovery actions, or a retention policy.
- Reuse `createSessionStorageAdapter().loadSession()` for invalid-data cleanup. Do not fork its
  parser or validation rules.
- A valid non-resumable snapshot, especially `lifecycle === 'completed'`, must remain stored.
  Only the adapter's existing invalid path may remove progress.
- A server puzzle is eligible only when it is `ready` and present in the gallery's current
  `puzzles` array. Do not retain a separate catalog across search/filter changes.
- Build server validation geometry from the current summary's `pieceCount + aspectRatio` and the
  production row-major ID contract. Do not fetch puzzle details.
- If a server summary lacks enough current metadata to build a validation context, skip it and
  leave its local record untouched rather than guessing.
- Quick Puzzle candidates come only from `listQuick()`. Do not make session-only Quick Puzzle
  metadata enumerable and do not build a cross-source catalog.
- No API/backend changes, N+1 detail/availability calls, cache layer, global store, storage-event
  listener, analytics, or cloud/account semantics.
- Keep `/puzzle/[id]` as the only hydration/resume route. Do not modify the puzzle route or the
  HPA-557 component boundaries.
- Keep the existing `puzzle-progress-${puzzleId}` key and session schema version.
- Follow the repository's existing TypeScript/Svelte formatting and test conventions.
- Every behavior change starts with a focused failing test and ends with a focused green run.

---

## File Structure

### New files

| File | Responsibility |
| --- | --- |
| `apps/web/src/lib/services/gameplay/galleryProgress.ts` | Build gallery-visible session contexts and discover valid resumable progress |
| `apps/web/src/lib/services/gameplay/galleryProgress.test.ts` | Discovery, ordering, exclusion, cleanup, and no-guess behavior |

### Modified files

| File | Change |
| --- | --- |
| `apps/web/src/lib/components/PuzzleCard.svelte` | Optional placed-count presentation and Continue label |
| `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts` | Play/Continue/progress/non-ready coverage |
| `apps/web/src/routes/+page.svelte` | Run local discovery, render newest Continue area, pass card progress |
| `apps/web/src/routes/page.svelte.test.ts` | Continue area and per-card integration tests |
| `apps/web/e2e/gallery.spec.ts` | One current-schema resume smoke case using HPA-226 persistence helpers |

No API, shared-schema, database, workflow, or puzzle-route file should change.

---

## Task 1: Add Current-Schema Gallery Progress Discovery

**Files:**

- Create: `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- Create: `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`
- Reuse: `apps/web/src/lib/services/gameplay/session/persistence.test-fixtures.ts`

### Contract

```ts
export interface GalleryProgress {
	puzzleId: string;
	name: string;
	source: PuzzleSourceType;
	placedCount: number;
	pieceCount: number;
	lastUpdated: number;
}

export interface GalleryProgressDiscovery {
	byPuzzleId: ReadonlyMap<string, GalleryProgress>;
	newest: GalleryProgress | null;
}

export function discoverGalleryProgress(options: {
	serverPuzzles: readonly PuzzleSummary[];
	quickPuzzles: readonly StoredQuickPuzzle[];
	sessionStorage?: SessionStorageAdapter;
}): GalleryProgressDiscovery;
```

### Server context helper

Keep this helper private to `galleryProgress.ts`:

```ts
function serverValidationContext(puzzle: PuzzleSummary): SessionValidationContext | null {
	if (puzzle.status !== 'ready' || puzzle.aspectRatio === undefined) return null;
	if (!isValidPieceCountForAspectRatio(puzzle.pieceCount, puzzle.aspectRatio)) return null;

	const { rows, cols } = getGridDimensionsForAspectRatio(puzzle.pieceCount, puzzle.aspectRatio);
	const pieces = Array.from({ length: puzzle.pieceCount }, (_, id) => ({
		id,
		correctX: id % cols,
		correctY: Math.floor(id / cols)
	}));

	return {
		puzzleId: puzzle.id,
		source: 'api',
		pieceIds: pieces.map((piece) => piece.id),
		gridCols: cols,
		gridRows: rows,
		pieceCount: puzzle.pieceCount,
		pieces
	};
}
```

### Quick Puzzle context helper

```ts
function quickValidationContext(puzzle: StoredQuickPuzzle): SessionValidationContext {
	return {
		puzzleId: puzzle.id,
		source: 'local',
		pieceIds: puzzle.pieces.map((piece) => piece.id),
		gridCols: puzzle.gridCols,
		gridRows: puzzle.gridRows,
		pieceCount: puzzle.pieceCount,
		pieces: puzzle.pieces.map(({ id, correctX, correctY }) => ({ id, correctX, correctY }))
	};
}
```

- [ ] **Step 1: Write red tests for server discovery and placed counts**

Use `validSnapshot()` and `memoryStorage()` from
`gameplay/session/persistence.test-fixtures.ts`. Store the snapshot under
`puzzle-progress-pz1`, then provide this current server summary:

```ts
const serverPuzzle: PuzzleSummary = {
	id: 'pz1',
	name: 'Resume Me',
	pieceCount: 4,
	aspectRatio: '1:1',
	status: 'ready'
};
```

Create an adapter with:

```ts
const store: Record<string, string> = {
	'puzzle-progress-pz1': JSON.stringify(validSnapshot())
};
const sessionStorage = createSessionStorageAdapter({ storage: memoryStorage(store) });
```

Assert discovery returns:

```ts
expect(result.byPuzzleId.get('pz1')).toMatchObject({
	puzzleId: 'pz1',
	name: 'Resume Me',
	source: 'api',
	placedCount: 2,
	pieceCount: 4,
	lastUpdated: 1_000
});
expect(result.newest?.puzzleId).toBe('pz1');
```

Run:

```bash
bun run test:unit --filter=@perseus/web -- gameplay/galleryProgress.test.ts
```

Expected: FAIL because `galleryProgress.ts` does not exist.

- [ ] **Step 2: Add red tests for selection/exclusion semantics**

Cover in the same file:

- two valid resumable candidates choose the greatest `lastUpdated`;
- a fresh/no-activity snapshot is absent from `byPuzzleId`;
- a later completed snapshot is absent and does not displace an older resumable snapshot;
- the completed snapshot's storage key remains present after discovery;
- processing/failed server summaries are never candidates.

For a completed snapshot, start from `validSnapshot()`, set:

```ts
lifecycle: 'completed',
placedPieces: fullBoardPlacements(),
sealedCompletion: seal(),
lastUpdated: 2_000
```

Do **not** assert that this record is removed.

- [ ] **Step 3: Add red tests for invalid cleanup and no-guess behavior**

Cover:

- `schemaVersion: 999` under a candidate key is removed by discovery through the existing
  adapter;
- a current-schema snapshot with a wrong canonical placement is removed;
- a server summary with no `aspectRatio` is skipped and its raw localStorage entry is left
  untouched because the gallery lacks a validation context.

For geometry corruption, clone `validSnapshot()` and change one placement from
`{ pieceId: 0, x: 0, y: 0 }` to `{ pieceId: 0, x: 1, y: 0 }`.

- [ ] **Step 4: Add red Quick Puzzle coverage**

Create a `StoredQuickPuzzle` with the same 2x2 canonical coordinates, then clone the valid
snapshot with:

```ts
puzzleId: 'q-test',
source: 'local'
```

Assert the returned `GalleryProgress` uses the Quick Puzzle name/source and requires no server
summary.

- [ ] **Step 5: Implement candidate construction and discovery**

In `galleryProgress.ts`:

1. create/use the injected `SessionStorageAdapter`;
2. turn eligible server summaries into validation contexts;
3. turn provided Quick Puzzle metadata into validation contexts;
4. for each candidate call `loadSession(candidate.id, context)`;
5. ignore `missing` results;
6. for `loaded`, call `isResumable(snapshot)` and ignore false without clearing;
7. map resumable snapshots to `GalleryProgress` using `snapshot.placedPieces.length` and
   `snapshot.lastUpdated`;
8. fill one `Map<string, GalleryProgress>`;
9. track the greatest `lastUpdated` in the same pass.

Do not enumerate arbitrary localStorage keys and do not add a second parser.

- [ ] **Step 6: Run focused service tests and web type check**

Run:

```bash
bun run test:unit --filter=@perseus/web -- gameplay/galleryProgress.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  apps/web/src/lib/services/gameplay/galleryProgress.ts \
  apps/web/src/lib/services/gameplay/galleryProgress.test.ts
git commit -m "feat(web): discover resumable gallery progress"
```

---

## Task 2: Make PuzzleCard Present Continue Progress

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleCard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts`

- [ ] **Step 1: Write red component tests**

Add tests for:

```ts
render(PuzzleCard, { puzzle: mockPuzzle, placedCount: 7 });
```

Expected rendering:

- overlay contains `CONTINUE` instead of `PLAY`;
- metadata contains `7/25 PLACED`;
- card href remains `/puzzle/test-puzzle-123`.

Also add/retain assertions that:

- no `placedCount` keeps `PLAY` and `25 PCS`;
- a processing or failed card does not expose `CONTINUE` even if a caller supplies
  `placedCount`.

Run:

```bash
bun run test:unit --filter=@perseus/web -- PuzzleCard.svelte.test.ts
```

Expected: FAIL because `placedCount` is not a component prop and Continue is not rendered.

- [ ] **Step 2: Add the optional prop and derived presentation state**

Change the prop contract to:

```ts
interface Props {
	puzzle: PuzzleSummary;
	placedCount?: number;
}

let { puzzle, placedCount }: Props = $props();
const hasProgress = $derived(isReady && placedCount !== undefined);
```

Use `hasProgress` only for presentation. Do not validate or read persistence inside the card.

Change the ready overlay label to:

```svelte
▶ {hasProgress ? 'CONTINUE' : 'PLAY'}
```

Change the compact piece line to:

```svelte
{#if hasProgress}
	{placedCount}/{puzzle.pieceCount} PLACED
{:else}
	{puzzle.pieceCount} PCS
{/if}
```

Do not change the link destination, thumbnail behavior, category badge, best-time read, or
processing/failed card behavior.

- [ ] **Step 3: Run component tests and type check**

Run:

```bash
bun run test:unit --filter=@perseus/web -- PuzzleCard.svelte.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add \
  apps/web/src/lib/components/PuzzleCard.svelte \
  apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts
git commit -m "feat(web): show Continue progress on gallery cards"
```

---

## Task 3: Wire Discovery into the Gallery Page

**Files:**

- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`

### Page state

Add imports:

```ts
import { listQuick } from '$lib/services/quickPuzzle';
import {
	discoverGalleryProgress,
	type GalleryProgressDiscovery
} from '$lib/services/gameplay/galleryProgress';
```

Initialize an empty discovery result:

```ts
let localProgress: GalleryProgressDiscovery = $state({
	byPuzzleId: new Map(),
	newest: null
});
```

Add one client-side effect tied to the current server results:

```ts
$effect(() => {
	const serverPuzzles = puzzles;
	localProgress = discoverGalleryProgress({
		serverPuzzles,
		quickPuzzles: listQuick()
	});
});
```

Do not add timers, storage listeners, or retained catalogs.

- [ ] **Step 1: Add deterministic mocks to the route test**

In `page.svelte.test.ts`, mock only the new boundaries needed by page rendering:

```ts
vi.mock('$lib/services/quickPuzzle', () => ({
	listQuick: vi.fn().mockReturnValue([])
}));

vi.mock('$lib/services/gameplay/galleryProgress', () => ({
	discoverGalleryProgress: vi.fn().mockReturnValue({
		byPuzzleId: new Map(),
		newest: null
	})
}));
```

Reset the discovery mock in `beforeEach` so existing gallery tests remain isolated.

- [ ] **Step 2: Write a red test for the Continue on this device section**

Return:

```ts
{
	byPuzzleId: new Map(),
	newest: {
		puzzleId: 'q-local',
		name: 'Local Sunset',
		source: 'local',
		placedCount: 3,
		pieceCount: 16,
		lastUpdated: 2_000
	}
}
```

Assert the page renders:

- a `continue-on-device` region;
- `Local Sunset`;
- `3/16 PLACED`;
- a link with `href="/puzzle/q-local"`.

This test proves Quick Puzzle continuation presentation without adding Quick Puzzle cards to the
server grid.

- [ ] **Step 3: Write a red test for matching server-card progress**

Mock `fetchPuzzles` with two ready summaries and return discovery with only `p1` in
`byPuzzleId`. Assert:

- `p1` renders `CONTINUE` and its placed/total progress;
- `p2` retains `PLAY` / normal piece count.

This confirms the page, not `PuzzleCard`, decides which persisted session is valid.

- [ ] **Step 4: Render the standalone Continue section**

Place the compact section after the gallery header/search controls and before the main
loading/error/grid branch so a valid local Quick Puzzle continuation remains visible even when
the server list is loading or unavailable.

Use the existing design tokens and one normal link:

```svelte
{#if localProgress.newest}
	<section data-testid="continue-on-device" aria-labelledby="continue-on-device-title">
		<h2 id="continue-on-device-title">Continue on this device</h2>
		<p>{localProgress.newest.name}</p>
		<span>
			{localProgress.newest.placedCount}/{localProgress.newest.pieceCount} PLACED
		</span>
		<a href={resolve(`/puzzle/${localProgress.newest.puzzleId}`)}>CONTINUE</a>
	</section>
{/if}
```

Keep it deliberately compact: no carousel, history expansion, delete/recovery action, or image
fetch.

- [ ] **Step 5: Pass progress into matching server cards**

Change only the card invocation:

```svelte
{#each puzzles as puzzle (puzzle.id)}
	<PuzzleCard
		{puzzle}
		placedCount={localProgress.byPuzzleId.get(puzzle.id)?.placedCount}
	/>
{/each}
```

Do not modify search, pagination, total counts, or fetch parameters.

- [ ] **Step 6: Run the focused route/component/service fence**

Run:

```bash
bun run test:unit --filter=@perseus/web -- \
  gameplay/galleryProgress.test.ts \
  PuzzleCard.svelte.test.ts \
  routes/page.svelte.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/+page.svelte apps/web/src/routes/page.svelte.test.ts
git commit -m "feat(web): surface resumable progress in gallery"
```

---

## Task 4: Add One End-to-End Resume Smoke Case

**Files:**

- Modify: `apps/web/e2e/gallery.spec.ts`
- Reuse: `apps/web/e2e/gameplay-fixtures/persisted-state.ts`
- Reuse: `apps/web/e2e/gameplay-fixtures/catalog.ts`

- [ ] **Step 1: Generalize the gallery mock helper to `PuzzleSummary[]`**

Import the shared type and change the local helpers from the narrow
`{ id; name; pieceCount }[]` shape to `PuzzleSummary[]`. Existing tests continue using their
current data; the new test can supply `status` and `aspectRatio` explicitly.

- [ ] **Step 2: Write the red browser test using a production-validated seed**

Use fixture `e2e-square-4` so the summary and persisted session use current production geometry.
Import:

```ts
import { getFixture } from './gameplay-fixtures/catalog';
import {
	buildMinimalSeed,
	createPersistedStateController
} from './gameplay-fixtures/persisted-state';
```

Build the partial snapshot from the fixture rather than hand-writing the full schema:

```ts
const fixtureId = 'e2e-square-4';
const fixture = getFixture(fixtureId);
const firstPiece = fixture.pieces[0];
const seed = {
	...buildMinimalSeed(fixtureId),
	placedPieces: [
		{
			pieceId: firstPiece.id,
			x: firstPiece.correctX,
			y: firstPiece.correctY
		}
	],
	timerStarted: true,
	hasUserActivity: true,
	lastUpdated: 2_000
};
```

Mock the gallery with:

```ts
{
	id: fixtureId,
	name: 'Resume Fixture',
	pieceCount: fixture.pieceCount,
	aspectRatio: fixture.aspectRatio,
	status: 'ready'
}
```

Navigate to `/` once to establish the origin, call
`createPersistedStateController().seedValid(page, fixtureId, seed)`, then reload.

Assert:

- `continue-on-device` is visible;
- `1/4 PLACED` is visible;
- the matching gallery card presents `CONTINUE`;
- clicking the Continue link navigates to `/puzzle/e2e-square-4`.

Install the existing deterministic fixture route/detail mock before the click so the browser does
not hit a real backend. Do not create a new E2E persistence helper.

Run the new test by title first:

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop \
  --grep "shows current-device progress and continues the newest session"
```

Expected before implementation integration is complete: FAIL on missing Continue UI. After Tasks
1-3: PASS.

- [ ] **Step 3: Run the complete gallery E2E file**

Run:

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/gallery.spec.ts
git commit -m "test(web): cover gallery resume flow"
```

---

## Task 5: Final Verification and Scope Fence

- [ ] **Step 1: Run the complete web unit suite**

```bash
bun run test:unit --filter=@perseus/web
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run static checks**

```bash
bun run check --filter=@perseus/web
bun run lint
```

Expected: PASS, subject only to already-documented unchanged baseline warnings if any. Do not
silently classify a new warning as baseline.

- [ ] **Step 3: Run production web build**

```bash
bun run build --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 4: Run gallery smoke plus existing gameplay smoke**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
bun run test:e2e:smoke
```

Expected: PASS except repository-documented expected skips.

- [ ] **Step 5: Verify the scope fence**

Run:

```bash
git diff --name-only main...HEAD
git diff --check main...HEAD
```

Expected changed production/test files are limited to:

```text
apps/web/src/lib/services/gameplay/galleryProgress.ts
apps/web/src/lib/services/gameplay/galleryProgress.test.ts
apps/web/src/lib/components/PuzzleCard.svelte
apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts
apps/web/src/routes/+page.svelte
apps/web/src/routes/page.svelte.test.ts
apps/web/e2e/gallery.spec.ts
```

plus the approved design/plan documents. There must be no changes under:

```text
apps/api/
apps/workflows/
packages/shared/
packages/types/
apps/web/src/routes/puzzle/
```

- [ ] **Step 6: Verify acceptance criteria explicitly**

Check the implementation against HPA-218:

- newest valid unfinished available session is the single Continue entry;
- matching ready server cards show placed/total and Continue;
- completed sessions are ignored without deletion;
- invalid current-schema data is cleared by the existing adapter;
- server discovery uses current gallery summaries only;
- Quick Puzzle discovery uses `listQuick()` only;
- network traffic does not increase per card;
- Continue links use the existing puzzle route.

- [ ] **Step 7: Commit any verification-only test/doc correction if required**

Do not create a cleanup commit when no file changed. If verification exposes a real issue, fix it
with a focused regression test, rerun the affected fence, and commit only that correction.

## Implementation Notes

- HPA-557 can merge before or after this work. HPA-218 intentionally does not edit the puzzle
  route, so ordinary rebasing should be limited to gallery-adjacent conflicts if main changes.
- Do not convert the discovery result into a Svelte store. The gallery page is the only consumer
  in this scope.
- Do not scan all localStorage keys. Candidate-driven reads enforce the requirement that server
  progress appears only when the page already has matching puzzle metadata.
- Do not remove a completed snapshot simply because `isResumable` returns false; completion
  effect reconciliation belongs to the existing puzzle hydration path.
