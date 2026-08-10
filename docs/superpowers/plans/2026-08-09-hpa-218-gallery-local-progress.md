# HPA-218 Gallery Local Progress and Continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the newest resumable current-device session available from the gallery's current
server summaries plus persisted Quick Puzzle metadata, show always-visible Continue progress on
matching ready server cards, and keep authoritative hydration/cleanup in `/puzzle/[id]`.

**Architecture:** Add one non-destructive `peekSession` method to the existing session storage
adapter, then build one synchronous `galleryProgress` service over that seam. Read Quick Puzzle
metadata once per gallery mount and recompute discovery when the server `puzzles` array changes.
`PuzzleCard` remains a presentation component that receives only `placedCount`.

**Tech Stack:** TypeScript, Svelte 5, SvelteKit, Vitest browser mode, Playwright, Bun,
`@perseus/types` grid helpers, existing PuzzleSession persistence codec

## Global Constraints

- Design baseline:
  `docs/superpowers/specs/2026-08-09-hpa-218-gallery-local-progress-design.md`.
- Linear issue: HPA-218.
- Use only the current `PersistedPuzzleSessionV1` schema.
- Gallery discovery is read-only. It must never delete progress.
- Existing `/puzzle/[id]` hydration keeps ownership of invalid-session cleanup through
  `loadSession` with authoritative loaded puzzle pieces.
- Server candidates must be ready, have a runtime-valid `PuzzleAspectRatio`, and have a valid
  piece-count/aspect combination before any aspect-ratio grid helper is called.
- Server progress is visible only for summaries in the gallery's current `puzzles` array.
- Quick Puzzle candidates come only from one `listQuick()` call per gallery mount.
- Do not add a retained catalog, storage scan, global store, storage-event listener, API call,
  compatibility reader, migration, analytics, or cloud/account semantics.
- Keep the row-major context derivation private; use explicit parity tests rather than a new
  shared helper by default.
- The always-visible card metadata is the user-facing Continue signal. The existing hover/focus
  overlay remains decorative.
- If the newest candidate is a loaded server puzzle, render both the Continue panel and progress
  on that same card.
- Keep the existing `/puzzle/[id]` href and route behavior.
- Follow existing repository formatting and test conventions.
- Start each behavior change with a failing focused test and run the corresponding focused green
  test before committing.

---

## File Structure

### New files

| File | Responsibility |
| --- | --- |
| `apps/web/src/lib/services/gameplay/galleryProgress.ts` | Build derived/current validation contexts and return read-only resumable gallery progress |
| `apps/web/src/lib/services/gameplay/galleryProgress.test.ts` | Geometry parity, bounded newest selection, invalid-skip, completed exclusion, Quick Puzzle coverage |

### Modified files

| File | Change |
| --- | --- |
| `apps/web/src/lib/services/gameplay/session/types.ts` | Add `peekSession` to `SessionStorageAdapter` |
| `apps/web/src/lib/services/gameplay/session/persistence.ts` | Share one storage-read/parser path between non-destructive peek and destructive authoritative load |
| `apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts` | Prove peek preserves invalid data while load still clears it |
| `apps/web/src/lib/components/PuzzleCard.svelte` | Optional `placedCount`; always-visible Continue/progress metadata |
| `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts` | Touch-visible Continue/progress and non-ready coverage |
| `apps/web/src/routes/+page.svelte` | Read `listQuick()` once on mount, run discovery, render panel, pass card progress |
| `apps/web/src/routes/page.svelte.test.ts` | One-time Quick read, discovery wiring, replacement data, panel/card overlap |
| `apps/web/e2e/gallery.spec.ts` | One production-validated partial-session resume smoke case |

No API, database, workflow, shared-schema, or puzzle-route implementation file changes are needed.

---

## Task 1: Add Non-Destructive Session Peek and Gallery Discovery

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts`
- Create: `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- Create: `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`
- Reuse: `apps/web/src/lib/services/gameplay/session/persistence.test-fixtures.ts`

**Interfaces:**

- Consumes: `PuzzleSummary`, `StoredQuickPuzzle`, `SessionValidationContext`,
  `SessionStorageAdapter`, `isPuzzleAspectRatio`, `isValidPieceCountForAspectRatio`,
  `getGridDimensionsForAspectRatio`.
- Produces:

```ts
SessionStorageAdapter.peekSession(
	puzzleId: string,
	context: SessionValidationContext
): SessionLoadResult;

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

- [ ] **Step 1: Write the failing non-destructive peek regression**

In `persistence.validation-storage.test.ts`, use `memoryStorage()` and a deliberately invalid
current-schema record:

```ts
it('peekSession reports invalid data without removing it', () => {
	const snapshot = validSnapshot();
	const raw = JSON.stringify({ ...snapshot, schemaVersion: 999 });
	const store = { 'puzzle-progress-pz1': raw };
	const adapter = createSessionStorageAdapter({ storage: memoryStorage(store) });

	expect(adapter.peekSession('pz1', context)).toEqual({
		status: 'invalid',
		reason: 'unsupported_schema_version'
	});
	expect(store['puzzle-progress-pz1']).toBe(raw);
});
```

Keep/add the paired authoritative behavior in the same test file:

```ts
it('loadSession still removes invalid data', () => {
	const snapshot = validSnapshot();
	const store = {
		'puzzle-progress-pz1': JSON.stringify({ ...snapshot, schemaVersion: 999 })
	};
	const adapter = createSessionStorageAdapter({ storage: memoryStorage(store) });

	expect(adapter.loadSession('pz1', context)).toEqual({ status: 'missing' });
	expect(store['puzzle-progress-pz1']).toBeUndefined();
});
```

Run:

```bash
bun run test:unit --filter=@perseus/web -- persistence.validation-storage.test.ts
```

Expected: FAIL because `peekSession` does not exist.

- [ ] **Step 2: Implement one shared read path plus `peekSession`**

In `types.ts`:

```ts
export interface SessionStorageAdapter {
	peekSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult;
	loadSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult;
	saveSession(puzzleId: string, snapshot: PersistedPuzzleSessionV1): void;
	clearSession(puzzleId: string): void;
	isResumable(snapshot: PersistedPuzzleSessionV1): boolean;
}
```

In `createSessionStorageAdapter`, share the read/parser logic:

```ts
function readSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
	let raw: string | null;
	try {
		raw = storage.getItem(progressKey(puzzleId));
	} catch (cause) {
		onError?.({ kind: 'read_error', puzzleId, cause });
		return { status: 'missing' };
	}
	return loadPersistedSession(raw, context);
}

function peekSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
	return readSession(puzzleId, context);
}

function loadSession(puzzleId: string, context: SessionValidationContext): SessionLoadResult {
	const result = readSession(puzzleId, context);
	if (result.status !== 'invalid') return result;

	try {
		storage.removeItem(progressKey(puzzleId));
	} catch (cause) {
		onError?.({ kind: 'remove_error', puzzleId, cause });
	}
	return { status: 'missing' };
}
```

Return `peekSession` alongside the existing methods. Do not change route callers of `loadSession`.

Run:

```bash
bun run test:unit --filter=@perseus/web -- persistence.validation-storage.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 3: Write failing server geometry parity tests**

In `galleryProgress.test.ts`, inject a spy adapter whose `peekSession` captures the context and
returns missing. Use explicit expected tuples; do not compute expected tuples through the same
production formula.

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

Feed summaries for `1:1`/4, `4:3`/12, and `3:4`/12 and assert the captured context `pieces`
exactly equal these arrays.

Also pass a runtime-corrupt value through a cast:

```ts
const corrupt = {
	id: 'bad',
	name: 'Bad',
	pieceCount: 4,
	status: 'ready',
	aspectRatio: '16:9'
} as unknown as PuzzleSummary;
```

Assert discovery does not throw and never calls `peekSession` for that candidate.

Run:

```bash
bun run test:unit --filter=@perseus/web -- gameplay/galleryProgress.test.ts
```

Expected: FAIL because `discoverGalleryProgress` does not exist.

- [ ] **Step 4: Add failing discovery behavior tests**

Use `validSnapshot()`, `fullBoardPlacements()`, `seal()`, and `memoryStorage()` to cover:

```ts
it('selects the greatest lastUpdated resumable current candidate', () => {
	// API pz1 lastUpdated 1_000, Quick q-test lastUpdated 2_000.
	// Expect newest.puzzleId === 'q-test'.
});

it('returns placed counts for matching ready server cards', () => {
	// validSnapshot() has two placements.
	// Expect byPuzzleId.get('pz1')?.placedCount === 2.
});

it('ignores completed snapshots without deleting them', () => {
	// lifecycle completed + fullBoardPlacements() + seal().
	// Expect no progress result and the raw storage key remains.
});

it('ignores invalid snapshots without deleting them', () => {
	// schemaVersion 999 or canonical-placement mismatch.
	// Expect no progress result and the raw storage key remains.
});
```

For Quick Puzzle coverage, construct a `StoredQuickPuzzle` with a 2x2 `pieces` array and a local
snapshot cloned from `validSnapshot()` with `puzzleId: 'q-test'` and `source: 'local'`.

- [ ] **Step 5: Implement `discoverGalleryProgress`**

Private server helper:

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

Private Quick helper:

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

Discovery loop behavior for every candidate:

```ts
const result = sessionStorage.peekSession(candidate.puzzleId, candidate.context);
if (result.status !== 'loaded') continue;
if (!sessionStorage.isResumable(result.snapshot)) continue;

const progress: GalleryProgress = {
	puzzleId: candidate.puzzleId,
	name: candidate.name,
	source: candidate.source,
	placedCount: result.snapshot.placedPieces.length,
	pieceCount: candidate.pieceCount,
	lastUpdated: result.snapshot.lastUpdated
};
```

Add API progress to `byPuzzleId`; Quick progress participates in `newest` but does not need a
server-card map entry. Track the greatest `lastUpdated` while processing candidates.

Run:

```bash
bun run test:unit --filter=@perseus/web -- \
  persistence.validation-storage.test.ts \
  gameplay/galleryProgress.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  apps/web/src/lib/services/gameplay/session/types.ts \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts \
  apps/web/src/lib/services/gameplay/galleryProgress.ts \
  apps/web/src/lib/services/gameplay/galleryProgress.test.ts
git commit -m "feat(web): discover resumable gallery progress safely"
```

---

## Task 2: Show Touch-Visible Continue Progress on Puzzle Cards

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleCard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts`

**Interfaces:**

- Consumes: `puzzle: PuzzleSummary`, optional `placedCount?: number`.
- Produces: presentation only.

- [ ] **Step 1: Write failing component tests for the always-visible signal**

Add:

```ts
it('shows always-visible Continue progress for a resumable card', async () => {
	render(PuzzleCard, { puzzle: mockPuzzle, placedCount: 7 });

	await expect.element(page.getByText('CONTINUE · 7/25 PLACED')).toBeVisible();
	await expect.element(page.getByTestId('puzzle-card')).toHaveAttribute(
		'href',
		'/puzzle/test-puzzle-123'
	);
});
```

Retain/add:

```ts
it('keeps the normal piece count without progress', async () => {
	render(PuzzleCard, { puzzle: mockPuzzle });
	await expect.element(page.getByText('25 PCS')).toBeVisible();
});

it('does not expose Continue progress for non-ready cards', async () => {
	render(PuzzleCard, {
		puzzle: { ...mockPuzzle, status: 'processing' },
		placedCount: 7
	});
	await expect.element(page.getByText(/CONTINUE/)).not.toBeInTheDocument();
});
```

Keep the existing assertion that `card-overlay` has `aria-hidden="true"`. Do not assert overlay
visibility as the user-facing Continue behavior.

Run:

```bash
bun run test:unit --filter=@perseus/web -- PuzzleCard.svelte.test.ts
```

Expected: FAIL because `placedCount` and the Continue metadata do not exist.

- [ ] **Step 2: Add the optional prop and user-facing metadata**

```ts
interface Props {
	puzzle: PuzzleSummary;
	placedCount?: number;
}

let { puzzle, placedCount }: Props = $props();
const isReady = $derived(puzzle.status === 'ready');
const hasProgress = $derived(isReady && placedCount !== undefined);
```

Replace the always-visible piece-count text with:

```svelte
{#if hasProgress}
	CONTINUE · {placedCount}/{puzzle.pieceCount} PLACED
{:else}
	{puzzle.pieceCount} PCS
{/if}
```

For desktop consistency, the existing `aria-hidden` hover/focus overlay may render:

```svelte
▶ {hasProgress ? 'CONTINUE' : 'PLAY'}
```

Do not change its opacity/hover mechanics and do not make it the only Continue signal.

Run:

```bash
bun run test:unit --filter=@perseus/web -- PuzzleCard.svelte.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add \
  apps/web/src/lib/components/PuzzleCard.svelte \
  apps/web/src/lib/components/__tests__/PuzzleCard.svelte.test.ts
git commit -m "feat(web): show touch-visible gallery progress"
```

---

## Task 3: Wire One-Time Quick Discovery into the Gallery

**Files:**

- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`

**Interfaces:**

- Consumes: `listQuick(): StoredQuickPuzzle[]`,
  `discoverGalleryProgress({ serverPuzzles, quickPuzzles })`.
- Produces: page-local `GalleryProgressDiscovery` used by the Continue panel and card props.

- [ ] **Step 1: Add deterministic route-test mocks**

Mock both boundaries:

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

Import the mocked functions and reset them in `beforeEach`:

```ts
const mockedListQuick = vi.mocked(listQuick);
const mockedDiscoverGalleryProgress = vi.mocked(discoverGalleryProgress);

mockedListQuick.mockReturnValue([]);
mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
```

- [ ] **Step 2: Write the failing one-time Quick read + wiring test**

Use explicit arrays:

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

After render and initial server load:

```ts
await vi.waitFor(() => {
	expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
		serverPuzzles,
		quickPuzzles
	});
});
expect(mockedListQuick).toHaveBeenCalledTimes(1);
```

Then trigger a search replacement using the route test's existing debounce/refetch pattern.
After the replacement result is visible:

```ts
await vi.waitFor(() => {
	expect(mockedDiscoverGalleryProgress).toHaveBeenCalledWith({
		serverPuzzles: filteredPuzzles,
		quickPuzzles
	});
});
expect(mockedListQuick).toHaveBeenCalledTimes(1);
```

This proves server mutations recompute progress without rerunning the Quick Puzzle reaper/parser.

Run:

```bash
bun run test:unit --filter=@perseus/web -- routes/page.svelte.test.ts
```

Expected: FAIL because the page does not call these boundaries yet.

- [ ] **Step 3: Write failing panel/card-overlap and Quick-panel tests**

For a server overlap, mock discovery with the same `p1` as both `newest` and a map entry:

```ts
const progress = {
	puzzleId: 'p1',
	name: 'Resume Me',
	source: 'api' as const,
	placedCount: 2,
	pieceCount: 4,
	lastUpdated: 2_000
};

mockedDiscoverGalleryProgress.mockReturnValue({
	byPuzzleId: new Map([['p1', progress]]),
	newest: progress
});
```

Assert both are visible:

```ts
await expect.element(page.getByTestId('continue-on-device')).toBeVisible();
await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('Resume Me');
await expect.element(page.getByText('CONTINUE · 2/4 PLACED')).toBeVisible();
```

For Quick-only newest, return `newest` with `puzzleId: 'q-local'`, `source: 'local'`, and an empty
`byPuzzleId`. Assert the Continue panel links to `/puzzle/q-local` without adding a Quick card.

- [ ] **Step 4: Implement mount-time Quick read and reactive discovery**

Add:

```ts
import { onMount } from 'svelte';
import { listQuick } from '$lib/services/quickPuzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';
import {
	discoverGalleryProgress,
	type GalleryProgressDiscovery
} from '$lib/services/gameplay/galleryProgress';
```

State:

```ts
let quickPuzzles: StoredQuickPuzzle[] = $state([]);
let localProgress: GalleryProgressDiscovery = $state({
	byPuzzleId: new Map(),
	newest: null
});
```

Read Quick metadata once:

```ts
onMount(() => {
	quickPuzzles = listQuick();
});
```

Recompute from current arrays without calling `listQuick()` inside the effect:

```ts
$effect(() => {
	const serverPuzzles = puzzles;
	const localPuzzles = quickPuzzles;
	localProgress = discoverGalleryProgress({
		serverPuzzles,
		quickPuzzles: localPuzzles
	});
});
```

Render the compact panel before the main loading/error/grid branch:

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

Pass server-card progress:

```svelte
{#each puzzles as puzzle (puzzle.id)}
	<PuzzleCard
		{puzzle}
		placedCount={localProgress.byPuzzleId.get(puzzle.id)?.placedCount}
	/>
{/each}
```

Do not change search, pagination, totals, or fetch parameters.

Run:

```bash
bun run test:unit --filter=@perseus/web -- \
  gameplay/galleryProgress.test.ts \
  PuzzleCard.svelte.test.ts \
  routes/page.svelte.test.ts
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 5: Commit**

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

- Consumes: production-validated persisted seed + deterministic fixture metadata/detail routes.
- Produces: one browser-level proof of panel/card overlap and navigation.

- [ ] **Step 1: Generalize the gallery mock helper to `PuzzleSummary[]`**

Import `PuzzleSummary` and change the local list helper to accept that shared type so the new test
can provide `status` and `aspectRatio`.

- [ ] **Step 2: Write the browser test with a production-validated partial seed**

Use fixture `e2e-square-4`:

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

Mock the gallery list with:

```ts
{
	id: fixtureId,
	name: 'Resume Fixture',
	pieceCount: fixture.pieceCount,
	aspectRatio: fixture.aspectRatio,
	status: 'ready'
}
```

Navigate to `/` once to establish origin, seed with
`createPersistedStateController().seedValid(page, fixtureId, seed)`, install the existing fixture
router for detail/asset requests, and reload.

Assert both overlapping surfaces explicitly:

```ts
await expect(page.getByTestId('continue-on-device')).toContainText('Resume Fixture');
await expect(page.getByTestId('continue-on-device')).toContainText('1/4 PLACED');
await expect(page.getByTestId('puzzle-card')).toContainText('CONTINUE · 1/4 PLACED');
```

Click the panel's Continue link and assert the existing route opens:

```ts
await page.getByTestId('continue-on-device').getByRole('link', { name: 'CONTINUE' }).click();
await expect(page).toHaveURL(/\/puzzle\/e2e-square-4/);
```

Run:

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop \
  --grep "shows current-device progress and continues the newest session"
```

Expected: PASS after Tasks 1-3.

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

## Task 5: Final Verification

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

Expected: PASS; do not classify a new warning as baseline.

- [ ] **Step 3: Run the production web build**

```bash
bun run build --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 4: Run gallery and gameplay browser gates**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
bun run test:e2e:smoke
```

Expected: PASS except repository-documented expected skips.
