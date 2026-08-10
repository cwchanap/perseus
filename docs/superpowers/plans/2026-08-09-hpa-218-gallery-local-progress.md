# HPA-218 Gallery Local Progress and Continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the newest valid unfinished current-device puzzle session among the gallery's
currently discoverable server summaries plus surviving Quick Puzzle metadata, show placed/total
progress on matching server cards, and reuse the existing puzzle route for hydration without new
network requests or compatibility paths.

**Architecture:** Add one synchronous `galleryProgress` service that converts the server summaries
already held by the gallery plus `listQuick()` metadata into `SessionValidationContext`s, then
delegates loading, current-schema validation, invalid cleanup, and resumability to the existing
`SessionStorageAdapter`. The gallery owns discovery lifecycle and presentation; `PuzzleCard`
receives only an optional placed count. The puzzle route remains unchanged.

**Tech Stack:** TypeScript, Svelte 5, SvelteKit, Vitest browser mode, Playwright, Bun, existing
`@perseus/types` grid helpers, existing PuzzleSession persistence codec

## Global Constraints

- Design baseline:
  `docs/superpowers/specs/2026-08-09-hpa-218-gallery-local-progress-design.md`.
- Linear issue:
  `https://linear.app/cwchanap/issue/HPA-218/gameplay-ux-show-local-progress-and-continue-in-the-gallery`.
- HPA-556 is complete; read only `PersistedPuzzleSessionV1` / current schema.
- "Newest" means greatest `lastUpdated` among current ready server summaries plus surviving
  `listQuick()` metadata. Do not build a device-global recent-session catalog.
- Do not add migrations, legacy readers, recovery actions, or a retention policy.
- Reuse `createSessionStorageAdapter().loadSession()` for invalid-data cleanup. Do not fork its
  parser or validation rules.
- A valid non-resumable snapshot, especially `lifecycle === 'completed'`, must remain stored.
  Only the adapter's existing invalid path may remove progress.
- A server puzzle is eligible only when it is `ready` and present in the gallery's current
  `puzzles` array. Do not retain a separate catalog across search/filter changes.
- Before calling `isValidPieceCountForAspectRatio` or `getGridDimensionsForAspectRatio`, guard the
  runtime summary value with `isPuzzleAspectRatio`. Unexpected values are skipped and their
  progress records remain untouched.
- Build server validation geometry from the current summary's `pieceCount + aspectRatio` and the
  production row-major ID contract. Do not fetch puzzle details.
- Lock the row-major derivation with explicit parity tests for `1:1`/4 pieces, `4:3`/12 pieces,
  and `3:4`/12 pieces. Do not add a shared row-major helper in this ticket.
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
| `apps/web/src/lib/services/gameplay/galleryProgress.ts` | Build guarded gallery-visible validation contexts and discover valid resumable progress |
| `apps/web/src/lib/services/gameplay/galleryProgress.test.ts` | Geometry parity, runtime guards, discovery ordering, exclusion, and cleanup |

### Modified files

| File | Change |
| --- | --- |
| `apps/web/src/lib/components/PuzzleCard.svelte` | Optional placed-count presentation and Continue label |
| `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts` | Play/Continue/progress/non-ready coverage |
| `apps/web/src/routes/+page.svelte` | Run local discovery, render newest-current-candidate Continue area, pass card progress |
| `apps/web/src/routes/page.svelte.test.ts` | Continue presentation plus discovery-call wiring assertions |
| `apps/web/e2e/gallery.spec.ts` | One current-schema resume smoke case using HPA-226 persistence helpers |

No API, shared-schema, database, workflow, `packages/types`, or puzzle-route production file should
change.

---

## Task 1: Add Current-Schema Gallery Progress Discovery

**Files:**

- Create: `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- Create: `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`
- Reuse: `apps/web/src/lib/services/gameplay/session/persistence.test-fixtures.ts`

**Interfaces:**

- Consumes: `PuzzleSummary`, `StoredQuickPuzzle`, `SessionStorageAdapter`,
  `SessionValidationContext`, `getGridDimensionsForAspectRatio`, `isPuzzleAspectRatio`, and
  `isValidPieceCountForAspectRatio`.
- Produces: `discoverGalleryProgress(options): GalleryProgressDiscovery`, consumed only by the
  gallery page in Task 3.

### Public contract

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

### Private server-context helper

```ts
function serverValidationContext(puzzle: PuzzleSummary): SessionValidationContext | null {
	if (puzzle.status !== 'ready') return null;
	if (!isPuzzleAspectRatio(puzzle.aspectRatio)) return null;
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

The `isPuzzleAspectRatio` guard is required before either aspect-ratio helper. Do not rely on the
TypeScript annotation as runtime validation and do not wrap the grid helper in a broad catch.

### Private Quick Puzzle context helper

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

- [ ] **Step 1: Write the initial failing server-discovery test**

Use `validSnapshot()` and `memoryStorage()` from
`gameplay/session/persistence.test-fixtures.ts`:

```ts
const serverPuzzle: PuzzleSummary = {
	id: 'pz1',
	name: 'Resume Me',
	pieceCount: 4,
	aspectRatio: '1:1',
	status: 'ready'
};

const store: Record<string, string> = {
	'puzzle-progress-pz1': JSON.stringify(validSnapshot())
};
const sessionStorage = createSessionStorageAdapter({ storage: memoryStorage(store) });

const result = discoverGalleryProgress({
	serverPuzzles: [serverPuzzle],
	quickPuzzles: [],
	sessionStorage
});

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

- [ ] **Step 2: Add explicit row-major geometry parity tests**

Use a spy `SessionStorageAdapter` whose `loadSession` records the supplied
`SessionValidationContext` and returns `{ status: 'missing' }`. Feed three ready summaries and
assert the captured contexts contain these exact tuple arrays:

```ts
const expectedSquare4 = [
	{ id: 0, correctX: 0, correctY: 0 },
	{ id: 1, correctX: 1, correctY: 0 },
	{ id: 2, correctX: 0, correctY: 1 },
	{ id: 3, correctX: 1, correctY: 1 }
];

const expectedLandscape12 = [
	{ id: 0, correctX: 0, correctY: 0 },
	{ id: 1, correctX: 1, correctY: 0 },
	{ id: 2, correctX: 2, correctY: 0 },
	{ id: 3, correctX: 3, correctY: 0 },
	{ id: 4, correctX: 0, correctY: 1 },
	{ id: 5, correctX: 1, correctY: 1 },
	{ id: 6, correctX: 2, correctY: 1 },
	{ id: 7, correctX: 3, correctY: 1 },
	{ id: 8, correctX: 0, correctY: 2 },
	{ id: 9, correctX: 1, correctY: 2 },
	{ id: 10, correctX: 2, correctY: 2 },
	{ id: 11, correctX: 3, correctY: 2 }
];

const expectedPortrait12 = [
	{ id: 0, correctX: 0, correctY: 0 },
	{ id: 1, correctX: 1, correctY: 0 },
	{ id: 2, correctX: 2, correctY: 0 },
	{ id: 3, correctX: 0, correctY: 1 },
	{ id: 4, correctX: 1, correctY: 1 },
	{ id: 5, correctX: 2, correctY: 1 },
	{ id: 6, correctX: 0, correctY: 2 },
	{ id: 7, correctX: 1, correctY: 2 },
	{ id: 8, correctX: 2, correctY: 2 },
	{ id: 9, correctX: 0, correctY: 3 },
	{ id: 10, correctX: 1, correctY: 3 },
	{ id: 11, correctX: 2, correctY: 3 }
];
```

Test table:

```ts
[
	{ aspectRatio: '1:1', pieceCount: 4, rows: 2, cols: 2, pieces: expectedSquare4 },
	{ aspectRatio: '4:3', pieceCount: 12, rows: 3, cols: 4, pieces: expectedLandscape12 },
	{ aspectRatio: '3:4', pieceCount: 12, rows: 4, cols: 3, pieces: expectedPortrait12 }
]
```

For each row assert `gridRows`, `gridCols`, `pieceIds`, and `pieces`. This is the parity fence
against the workflow, Quick Puzzle generator, and E2E builder contracts; do not replace it with a
new shared helper.

- [ ] **Step 3: Add runtime-summary guard and invalid-cleanup tests**

Cover:

- a summary with no `aspectRatio` is skipped and its raw progress key remains untouched;
- a runtime summary with `aspectRatio: '16:9'` is skipped without throwing and without calling
  `loadSession`;
- the raw progress key for that invalid-aspect candidate remains untouched because no trustworthy
  context exists;
- `schemaVersion: 999` under a valid candidate key is removed through the existing adapter;
- a current-schema snapshot with a wrong canonical placement is removed through the adapter;
- processing/failed summaries never call `loadSession`.

Create the runtime-invalid summary without weakening production types:

```ts
const badAspect = {
	...serverPuzzle,
	aspectRatio: '16:9'
} as unknown as PuzzleSummary;
```

For geometry corruption, clone `validSnapshot()` and change one placement from
`{ pieceId: 0, x: 0, y: 0 }` to `{ pieceId: 0, x: 1, y: 0 }`.

- [ ] **Step 4: Add selection, completion-preservation, and Quick Puzzle tests**

Cover:

- two valid resumable current candidates choose the greatest `lastUpdated`;
- a fresh/no-activity snapshot is absent from `byPuzzleId`;
- a later valid completed snapshot is absent and does not displace an older resumable snapshot;
- the completed snapshot's storage key remains present after discovery;
- a `StoredQuickPuzzle` with canonical 2x2 metadata and a local-source session is discoverable
  without any server summary.

For a completed snapshot, start from `validSnapshot()` and set:

```ts
lifecycle: 'completed',
placedPieces: fullBoardPlacements(),
sealedCompletion: seal(),
lastUpdated: 2_000
```

For the Quick Puzzle snapshot set:

```ts
puzzleId: 'q-test',
source: 'local'
```

- [ ] **Step 5: Implement guarded candidate construction and discovery**

In `galleryProgress.ts`:

1. import `getGridDimensionsForAspectRatio`, `isPuzzleAspectRatio`, and
   `isValidPieceCountForAspectRatio` from `@perseus/types`;
2. create/use the injected `SessionStorageAdapter`;
3. turn eligible server summaries into contexts using the guarded helper above;
4. turn provided Quick Puzzle metadata into contexts using stored canonical coordinates;
5. for each candidate call `loadSession(candidate.id, context)`;
6. ignore `missing` results;
7. for `loaded`, call `isResumable(snapshot)` and ignore false without clearing;
8. map resumable snapshots to `GalleryProgress` using `snapshot.placedPieces.length` and
   `snapshot.lastUpdated`;
9. fill one `Map<string, GalleryProgress>`;
10. track the greatest `lastUpdated` in the same pass.

Do not enumerate arbitrary localStorage keys, add a second parser, or introduce a shared geometry
abstraction.

- [ ] **Step 6: Run the focused service tests and web type check**

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

**Interfaces:**

- Consumes: `PuzzleSummary` and optional `placedCount: number` supplied by the gallery.
- Produces: no new domain API; only rendering changes.

- [ ] **Step 1: Write failing component tests**

Add:

```ts
render(PuzzleCard, { puzzle: mockPuzzle, placedCount: 7 });
```

Assert:

- overlay contains `CONTINUE` instead of `PLAY`;
- metadata contains `7/25 PLACED`;
- card href remains `/puzzle/test-puzzle-123`.

Also retain/add assertions that:

- no `placedCount` keeps `PLAY` and `25 PCS`;
- a processing or failed card does not expose `CONTINUE` even if a caller supplies
  `placedCount`.

Run:

```bash
bun run test:unit --filter=@perseus/web -- PuzzleCard.svelte.test.ts
```

Expected: FAIL because `placedCount` is not yet a prop.

- [ ] **Step 2: Add the optional prop and derived presentation state**

```ts
interface Props {
	puzzle: PuzzleSummary;
	placedCount?: number;
}

let { puzzle, placedCount }: Props = $props();
const isReady = $derived(puzzle.status === 'ready');
const hasProgress = $derived(isReady && placedCount !== undefined);
```

Use:

```svelte
▶ {hasProgress ? 'CONTINUE' : 'PLAY'}
```

and:

```svelte
{#if hasProgress}
	{placedCount}/{puzzle.pieceCount} PLACED
{:else}
	{puzzle.pieceCount} PCS
{/if}
```

Do not change the link destination, thumbnail behavior, category badge, best-time read, or
processing/failed behavior. `PuzzleCard` must not read persistence itself.

- [ ] **Step 3: Run component tests and type check**

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

## Task 3: Wire Discovery into the Gallery Page and Verify the Wiring

**Files:**

- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`

**Interfaces:**

- Consumes: `listQuick(): StoredQuickPuzzle[]` and
  `discoverGalleryProgress({ serverPuzzles, quickPuzzles })`.
- Produces: `GalleryProgressDiscovery` page state used by the Continue section and `PuzzleCard`
  props.

### Page state

Add imports:

```ts
import { listQuick } from '$lib/services/quickPuzzle';
import {
	discoverGalleryProgress,
	type GalleryProgressDiscovery
} from '$lib/services/gameplay/galleryProgress';
```

Initialize:

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

- [ ] **Step 1: Add deterministic route-test mocks**

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

Import the mocked functions in the test and reset both in `beforeEach`:

```ts
const mockedListQuick = vi.mocked(listQuick);
const mockedDiscoverGalleryProgress = vi.mocked(discoverGalleryProgress);

mockedListQuick.mockReturnValue([]);
mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
```

- [ ] **Step 2: Write a failing test for the actual discovery call arguments**

Set explicit server and Quick Puzzle arrays:

```ts
const serverPuzzles = [
	makePuzzle('p1', { pieceCount: 4, aspectRatio: '1:1', status: 'ready' })
];
const quickPuzzles = [storedQuickPuzzleFixture];

mockedFetchPuzzles.mockResolvedValue({
	puzzles: serverPuzzles,
	total: 1,
	offset: 0,
	limit: 20
});
mockedListQuick.mockReturnValue(quickPuzzles);
```

Render the page, wait for the fetched card, then assert that **some** discovery call contains the
resolved current arrays. Do not assert exact call count because the effect may run once with the
initial empty `puzzles` value:

```ts
await vi.waitFor(() => {
	expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
		serverPuzzles,
		quickPuzzles
	});
});
```

This test must fail before the page wiring exists even though the discovery service itself is
mocked.

- [ ] **Step 3: Write a failing replacement-data wiring test**

Reuse the existing search/refetch pattern. Return `initialPuzzles` for the first request and
`filteredPuzzles` for `q=forest`. After the filtered result is visible, assert:

```ts
await vi.waitFor(() => {
	expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
		serverPuzzles: filteredPuzzles,
		quickPuzzles
	});
});
```

Also assert no later matching call reintroduces `initialPuzzles`. This proves the effect follows
the current replacement array instead of retaining a stale catalog.

- [ ] **Step 4: Write failing presentation tests**

For the standalone Quick Puzzle Continue section, return:

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

Assert:

- `continue-on-device` region is visible;
- `Local Sunset` is visible;
- `3/16 PLACED` is visible;
- link href is `/puzzle/q-local`.

For matching server-card progress, mock two ready summaries and return discovery with only `p1`
in `byPuzzleId`. Assert `p1` shows `CONTINUE` + progress while `p2` retains `PLAY` + normal count.

- [ ] **Step 5: Render the standalone Continue section**

Place it after the gallery header/search controls and before the main loading/error/grid branch so
a valid persisted Quick Puzzle continuation remains visible even if the server list is loading or
unavailable:

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

Keep it compact: no carousel, history expansion, delete/recovery action, or image fetch.

- [ ] **Step 6: Pass progress into matching server cards**

```svelte
{#each puzzles as puzzle (puzzle.id)}
	<PuzzleCard
		{puzzle}
		placedCount={localProgress.byPuzzleId.get(puzzle.id)?.placedCount}
	/>
{/each}
```

Do not modify search, pagination, total counts, or fetch parameters.

- [ ] **Step 7: Run the focused page/service/component fence**

```bash
bun run test:unit --filter=@perseus/web -- \
  gameplay/galleryProgress.test.ts \
  PuzzleCard.svelte.test.ts \
  routes/page.svelte.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 8: Commit**

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
- Reuse: `apps/web/e2e/gameplay-fixtures/fixture-router.ts`

**Interfaces:**

- Consumes: production-validated persisted-state seeds and deterministic fixture metadata.
- Produces: one browser smoke test proving service → page → existing puzzle-route navigation.

- [ ] **Step 1: Generalize the gallery mock helper to `PuzzleSummary[]`**

Import `PuzzleSummary` and change the local helpers from the narrow
`{ id; name; pieceCount }[]` shape to `PuzzleSummary[]`. Existing tests can keep their current
fixtures; the new test supplies `status` and `aspectRatio` explicitly.

- [ ] **Step 2: Write the failing browser test using a production-validated seed**

Use fixture `e2e-square-4`:

```ts
import { getFixture } from './gameplay-fixtures/catalog';
import {
	buildMinimalSeed,
	createPersistedStateController
} from './gameplay-fixtures/persisted-state';
import { createFixtureRouter } from './gameplay-fixtures/fixture-router';
```

Build the partial snapshot from the fixture:

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

Install the deterministic fixture router before the click so the puzzle detail request never hits
a real backend. Do not create a second E2E persistence helper.

Run the new test by title first:

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop \
  --grep "shows current-device progress and continues the newest available session"
```

Expected before Tasks 1-3 are implemented: FAIL on missing Continue UI. After Tasks 1-3: PASS.

- [ ] **Step 3: Run the complete gallery E2E file**

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

- [ ] **Step 3: Run the production web build**

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

```bash
git diff --name-only main...HEAD
git diff --check main...HEAD
```

Expected production/test files are limited to:

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

- the single Continue entry is the greatest-`lastUpdated` resumable session among current ready
  gallery summaries plus surviving `listQuick()` metadata;
- matching ready server cards show placed/total and Continue;
- completed sessions are ignored without deletion;
- invalid current-schema data is cleared by the existing adapter only when a trustworthy
  validation context exists;
- missing or runtime-invalid server aspect ratios are skipped without throwing or deleting their
  unvalidated progress;
- server geometry parity tests cover supported 2x2, 3x4, and 4x3 row-major layouts;
- page tests prove discovery receives current fetched summaries and exact `listQuick()` data,
  including after a replacement fetch;
- server discovery uses current gallery summaries only;
- Quick Puzzle discovery uses `listQuick()` only;
- network traffic does not increase per card;
- Continue links use the existing puzzle route.

- [ ] **Step 7: Scan for scope-expanding residue**

```bash
git diff main...HEAD -- \
  apps/web/src/lib/services/gameplay/galleryProgress.ts \
  apps/web/src/routes/+page.svelte \
  apps/web/src/lib/components/PuzzleCard.svelte
```

Reject the implementation if it introduces any of these concepts:

```text
history route
recent-session catalog
storage event listener
server validation endpoint
puzzle detail fetch for progress
legacy session migration
analytics
cloud progress
account progress
row-major shared helper
```

- [ ] **Step 8: Commit any verification-only correction if required**

Do not create a cleanup commit when no file changed. If verification exposes a real issue, add a
focused regression test, rerun the affected fence, and commit only that correction.

## Implementation Notes

- HPA-557 can merge before or after this work. HPA-218 intentionally does not edit the puzzle
  route, so ordinary rebasing should be limited to gallery-adjacent conflicts if main changes.
- Do not convert the discovery result into a Svelte store. The gallery page is the only consumer
  in this scope.
- Do not scan all localStorage keys. Candidate-driven reads enforce the requirement that server
  progress appears only when the page already has matching puzzle metadata.
- Do not remove a completed snapshot simply because `isResumable` returns false; completion
  effect reconciliation belongs to the existing puzzle hydration path.
- Treat malformed summary metadata differently from invalid session data: without a trustworthy
  `SessionValidationContext`, skip the summary and leave its progress record untouched.
- The row-major contract remains private to `galleryProgress.ts` in this ticket. Explicit parity
  tests are the maintenance boundary; extracting a shared helper is deferred until a real change
  requires one.
