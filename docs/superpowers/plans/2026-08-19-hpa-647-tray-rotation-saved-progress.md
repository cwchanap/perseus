# HPA-647 Tray Rotation and Saved Progress Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the tray-piece Rotate overlay, preserve rotation through the selected-piece inventory header and focused-piece `R` shortcut, and add a current-device saved-progress picker that can resume valid saves outside the currently loaded gallery results without showing false progress for completed-only keys.

**Architecture:** Keep `PuzzleSession` and `PersistedPuzzleSessionV1` unchanged. Persistence performs one cheap mount-time current-schema/resumability candidate scan over the existing `puzzle-progress-` namespace; `galleryProgress.ts` performs authoritative metadata/context validation only when the picker opens, using one shared explicit-geometry helper for Quick and fetched server puzzles. Rotation remains on existing session actions; only its pointer/touch presentation moves from each thumbnail to the selected-piece inventory header.

**Tech Stack:** Svelte 5 / SvelteKit, TypeScript, browser `localStorage`, Vitest Browser Mode, Playwright, existing `modalFocus`, existing Perseus gameplay persistence and E2E fixtures.

**Spec:** `docs/superpowers/specs/2026-08-19-hpa-647-tray-rotation-saved-progress-design.md`

## Global Constraints

- Deliver HPA-647 through this single draft PR and branch; implementation commits go onto the same PR. Do not open a second PR.
- Do not change `PuzzleSession`, result-class rules, API/database contracts, shared types, or `PersistedPuzzleSessionV1`.
- Do not add dependencies, a persisted save index, global progress store, batch endpoint, saved-progress route, or generic dialog/list framework.
- Keep the existing newest **Continue on this device** projection and newest-session Discard behavior.
- Run `listQuick()` and the local resumable-candidate scan once per gallery mount; search/filter/pagination must not rerun either.
- The mount probe may parse app-owned session JSON only to check current schema, key/puzzle ID match, and the same lifecycle/seal/activity state used by `isResumable()`; it must not validate geometry or fetch puzzle metadata.
- Do not fetch missing server puzzle detail until **VIEW SAVED PROGRESS** is opened.
- Full discovery is read-only: use `peekSession()` and never delete invalid, completed, missing-metadata, malformed-detail, or unresolved saves.
- Picker rows are selection-only: name, placed/total progress, Continue. No in-modal delete/rename/search/filter/pagination.
- Remove the tray-piece Rotate overlay completely; keep focused-piece `R` and orientation accessible naming.
- Pointer/touch rotation requires the existing selected piece and uses one inventory-header action.
- Migrate `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` in the same task as the rotation UI; do not defer its old `Rotate piece N` callers to CI/final cleanup.

## Risks to Control During Implementation

1. **Old Rotate-button integration callers:** the puzzle-route test file directly clicks `Rotate piece N` across rotation history, timer start, placement rejection, and announcer coverage. Overlay removal changes selection state as well as the locator. Task 3 migrates the route file and runs it immediately.
2. **Completed keys masquerading as saves:** completed sessions remain persisted, so raw key existence is not a valid product signal. Task 1 filters mount-time candidate IDs with a geometry-free current-schema resumability probe.
3. **Deleted/malformed off-page puzzle metadata:** `fetchPuzzle(id)` is a typed cast and can 404 or return malformed geometry. Task 2 uses one nullable explicit-geometry validator and skips only that candidate without deleting storage.

---

## File Structure

### Existing files to modify

- `apps/web/src/lib/services/gameplay/session/persistence.ts` — keep storage namespace ownership; add cheap resumable-candidate enumeration without widening `SessionStorageAdapter`.
- `apps/web/src/lib/services/gameplay/session/persistence.test.ts` — candidate-probe coverage, including completed-only keys.
- `apps/web/src/lib/services/gameplay/galleryProgress.ts` — shared explicit geometry validation plus lazy full-save discovery.
- `apps/web/src/lib/services/gameplay/galleryProgress.test.ts` — loaded/fetched/Quick discovery, malformed detail, non-destructive exclusion, ordering.
- `apps/web/src/lib/components/PuzzlePiece.svelte` — remove the visual Rotate child button only; retain root `R` rotation.
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — add selected-piece header `ROTATE`; remove child-Rotate roving exception.
- `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts` — overlay absence + keyboard/orientation contract.
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — header Rotate + simplified roving contract.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — migrate all old Rotate-button route callers and add focused `R` route coverage.
- `apps/web/src/routes/+page.svelte` — candidate IDs, picker orchestration, section gating, inert state, discard refresh.
- `apps/web/src/routes/page.svelte.test.ts` — one-time candidate scan, completed-only invisibility, lazy discovery, modal flow.
- `apps/web/e2e/gallery.spec.ts` — older off-page save resume flow.

### New files

- `apps/web/src/lib/components/SavedProgressDialog.svelte`
- `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts`

No API, database, package, session-engine, migration, or shared-type file is required.

---

### Task 1: Add a Geometry-Free Resumable Save Candidate Probe

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`

**Interfaces:**
- Produces: `listResumableSessionCandidateIds(storage?: Storage): string[]`.
- Keeps private: raw `puzzle-progress-` key enumeration.
- Keeps unchanged: `SessionStorageAdapter` public shape.
- Shares one state predicate with existing `isResumable(snapshot)` so lifecycle/seal/activity rules cannot drift.

- [ ] **Step 1: Write failing candidate-probe tests**

Extend the persistence import block:

```ts
import {
	serializeSession,
	loadPersistedSession,
	isResumable,
	createSessionStorageAdapter,
	listResumableSessionCandidateIds,
	noopThrowingStorage
} from './persistence';
```

Add:

```ts
describe('listResumableSessionCandidateIds', () => {
	const raw = (puzzleId: string, overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			schemaVersion: 1,
			puzzleId,
			lifecycle: 'active',
			sealedCompletion: null,
			hasUserActivity: true,
			...overrides
		});

	it('returns only current-schema app-owned records with resumable state', () => {
		const storage = memoryStorage({
			'puzzle-progress-active': raw('active'),
			'puzzle-progress-paused': raw('paused', { lifecycle: 'paused' }),
			'puzzle-progress-complete': raw('complete', { lifecycle: 'completed' }),
			'puzzle-progress-unused': raw('unused', { hasUserActivity: false }),
			'puzzle-progress-sealed': raw('sealed', { sealedCompletion: { runId: 'x' } }),
			'puzzle-progress-old': raw('old', { schemaVersion: 999 }),
			'puzzle-progress-mismatch': raw('different-id'),
			'puzzle-progress-bad-json': '{',
			'puzzle-progress-': raw(''),
			'unrelated-setting': '1'
		});

		expect(listResumableSessionCandidateIds(storage)).toEqual(['active', 'paused']);
	});

	it('returns no candidate for a completed-only storage set without deleting it', () => {
		const value = raw('complete', { lifecycle: 'completed' });
		const storage = memoryStorage({ 'puzzle-progress-complete': value });

		expect(listResumableSessionCandidateIds(storage)).toEqual([]);
		expect(storage.getItem('puzzle-progress-complete')).toBe(value);
	});

	it('returns an empty list when storage enumeration or reads are unavailable', () => {
		const blockedStorage = {
			get length() {
				throw new Error('blocked');
			},
			key: () => null,
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {},
			removeItem: () => {},
			clear: () => {}
		} satisfies Storage;

		expect(listResumableSessionCandidateIds(blockedStorage)).toEqual([]);
	});
});
```

This deliberately uses minimal records. The mount probe is not a second full codec and must not require geometry.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts
```

Expected: FAIL because `listResumableSessionCandidateIds` does not exist.

- [ ] **Step 3: Factor the state-only resumability predicate**

Replace the body-only logic of `isResumable()` with one private predicate:

```ts
function hasResumableSessionState(record: {
	lifecycle: unknown;
	sealedCompletion: unknown;
	hasUserActivity: unknown;
}): boolean {
	if (record.lifecycle !== 'active' && record.lifecycle !== 'paused') return false;
	if (record.sealedCompletion !== null) return false;
	return record.hasUserActivity === true;
}

export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean {
	return hasResumableSessionState(snapshot);
}
```

Do not move any geometry or cross-field validation into this predicate.

- [ ] **Step 4: Implement the private owned-key scan and exported candidate list**

Keep `PROGRESS_KEY_PREFIX` private and add the shared storage resolver plus private raw enumeration:

```ts
function resolveSessionStorage(storage?: Storage): Storage {
	return (
		storage ??
		(typeof localStorage !== 'undefined' ? localStorage : undefined) ??
		noopThrowingStorage
	);
}

function listPersistedSessionPuzzleIds(storage: Storage): string[] {
	const ids = new Set<string>();
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (!key?.startsWith(PROGRESS_KEY_PREFIX)) continue;
		const puzzleId = key.slice(PROGRESS_KEY_PREFIX.length);
		if (puzzleId.length > 0) ids.add(puzzleId);
	}
	return [...ids];
}
```

Add the exported candidate probe:

```ts
export function listResumableSessionCandidateIds(storage?: Storage): string[] {
	const resolvedStorage = resolveSessionStorage(storage);

	try {
		return listPersistedSessionPuzzleIds(resolvedStorage).filter((puzzleId) => {
			const raw = resolvedStorage.getItem(progressKey(puzzleId));
			if (raw === null) return false;

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return false;
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

			const record = parsed as Record<string, unknown>;
			if (record.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) return false;
			if (record.puzzleId !== puzzleId) return false;

			return hasResumableSessionState({
				lifecycle: record.lifecycle,
				sealedCompletion: record.sealedCompletion,
				hasUserActivity: record.hasUserActivity
			});
		});
	} catch {
		return [];
	}
}
```

Update `createSessionStorageAdapter()` to use `resolveSessionStorage(options?.storage)` instead of duplicating the fallback expression. Do not add the candidate method to the adapter.

- [ ] **Step 5: Run persistence regression coverage**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/session/persistence.test.ts \
  src/lib/services/gameplay/session/persistence.validation-storage.test.ts \
  src/lib/services/gameplay/session/persistence.fallback-storage.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.test.ts
git commit -m "feat(web): find resumable local save candidates"
```

---

### Task 2: Add Shared Explicit Geometry Validation and Lazy Full Discovery

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`

**Interfaces:**
- Produces:

```ts
export async function discoverAllSavedProgress(options: {
	puzzleIds: readonly string[];
	serverPuzzles: readonly PuzzleSummary[];
	quickPuzzles: readonly StoredQuickPuzzle[];
	fetchPuzzleById: (puzzleId: string) => Promise<Puzzle>;
	sessionStorage?: SessionStorageAdapter;
}): Promise<GalleryProgress[]>;
```

- Internal shared validator:

```ts
function explicitValidationContext(input: {
	puzzleId: string;
	source: PuzzleSourceType;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	pieces: unknown;
}): SessionValidationContext | null;
```

- Keeps `discoverGalleryProgress()` public behavior unchanged.

- [ ] **Step 1: Write failing full-discovery tests**

Change imports:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
import { discoverAllSavedProgress, discoverGalleryProgress } from './galleryProgress';
```

Add a full server fixture helper:

```ts
function fetchedServerPuzzle(id: string, name: string): Puzzle {
	return {
		id,
		name,
		pieceCount: 4,
		gridCols: 2,
		gridRows: 2,
		imageWidth: 200,
		imageHeight: 200,
		createdAt: 1_000,
		pieces: expectedSquare4.map((piece) => ({
			...piece,
			puzzleId: id,
			imagePath: `pieces/${piece.id}.png`,
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' }
		}))
	};
}
```

Add:

```ts
describe('discoverAllSavedProgress', () => {
	it('includes loaded, fetched, and Quick saves and sorts newest first', async () => {
		const base = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-pz-loaded': JSON.stringify({
				...base,
				puzzleId: 'pz-loaded',
				lastUpdated: 1_000
			}),
			'puzzle-progress-pz-old': JSON.stringify({
				...base,
				puzzleId: 'pz-old',
				lastUpdated: 3_000
			}),
			'puzzle-progress-q-test': JSON.stringify({
				...base,
				puzzleId: 'q-test',
				source: 'local',
				lastUpdated: 2_000
			})
		});
		const fetchPuzzleById = vi.fn(async (id: string) => fetchedServerPuzzle(id, 'Fetched Save'));

		const progress = await discoverAllSavedProgress({
			puzzleIds: ['pz-loaded', 'pz-old', 'q-test'],
			serverPuzzles: [serverPuzzle('pz-loaded', 4, '1:1', { name: 'Loaded Save' })],
			quickPuzzles: [quickPuzzle()],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(progress.map((item) => item.puzzleId)).toEqual(['pz-old', 'q-test', 'pz-loaded']);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(1);
		expect(fetchPuzzleById).toHaveBeenCalledWith('pz-old');
	});

	it('uses puzzle id as deterministic tie ordering without fetching loaded summaries', async () => {
		const base = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-b': JSON.stringify({ ...base, puzzleId: 'b', lastUpdated: 2_000 }),
			'puzzle-progress-a': JSON.stringify({ ...base, puzzleId: 'a', lastUpdated: 2_000 })
		});
		const fetchPuzzleById = vi.fn();

		const progress = await discoverAllSavedProgress({
			puzzleIds: ['b', 'a'],
			serverPuzzles: [serverPuzzle('a', 4, '1:1'), serverPuzzle('b', 4, '1:1')],
			quickPuzzles: [],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(progress.map((item) => item.puzzleId)).toEqual(['a', 'b']);
		expect(fetchPuzzleById).not.toHaveBeenCalled();
	});

	it('rejects malformed fetched piece geometry instead of building a weaker context', async () => {
		const base = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-pz-bad': JSON.stringify({ ...base, puzzleId: 'pz-bad' })
		});
		const malformed = fetchedServerPuzzle('pz-bad', 'Bad');
		malformed.pieces[1] = { ...malformed.pieces[0], puzzleId: 'pz-bad' };

		const progress = await discoverAllSavedProgress({
			puzzleIds: ['pz-bad'],
			serverPuzzles: [],
			quickPuzzles: [],
			fetchPuzzleById: vi.fn().mockResolvedValue(malformed),
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(progress).toEqual([]);
		expect(store.getItem('puzzle-progress-pz-bad')).not.toBeNull();
	});

	it('skips completed and unresolved candidates without deleting them', async () => {
		const completed: PersistedPuzzleSessionV1 = {
			...validSnapshot(),
			puzzleId: 'pz-complete',
			lifecycle: 'completed',
			placedPieces: fullBoardPlacements(),
			sealedCompletion: seal()
		};
		const raw = JSON.stringify(completed);
		const store = memoryStorage({ 'puzzle-progress-pz-complete': raw });

		const progress = await discoverAllSavedProgress({
			puzzleIds: ['pz-complete', 'pz-missing'],
			serverPuzzles: [serverPuzzle('pz-complete', 4, '1:1')],
			quickPuzzles: [],
			fetchPuzzleById: vi.fn().mockRejectedValue(new Error('not found')),
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(progress).toEqual([]);
		expect(store.getItem('puzzle-progress-pz-complete')).toBe(raw);
	});
});
```

Keep the existing malformed Quick tests; after implementation they also exercise the shared explicit validator through `quickValidationContext()`.

- [ ] **Step 2: Run the service test and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/galleryProgress.test.ts
```

Expected: FAIL because `discoverAllSavedProgress` is not exported.

- [ ] **Step 3: Extract the shared explicit-geometry validation helper**

Change the puzzle import:

```ts
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
```

Add:

```ts
function explicitValidationContext(input: {
	puzzleId: string;
	source: PuzzleSourceType;
	pieceCount: number;
	gridCols: number;
	gridRows: number;
	pieces: unknown;
}): SessionValidationContext | null {
	if (typeof input.puzzleId !== 'string' || input.puzzleId.length === 0) return null;
	if (input.source !== 'api' && input.source !== 'local') return null;
	if (!Number.isInteger(input.pieceCount) || input.pieceCount <= 0) return null;
	if (!Number.isInteger(input.gridCols) || input.gridCols <= 0) return null;
	if (!Number.isInteger(input.gridRows) || input.gridRows <= 0) return null;
	if (input.gridCols * input.gridRows !== input.pieceCount) return null;
	if (!Array.isArray(input.pieces) || input.pieces.length !== input.pieceCount) return null;

	const pieceIds = new Set<number>();
	const cells = new Set<string>();
	const pieces: Array<{ id: number; correctX: number; correctY: number }> = [];

	for (const rawPiece of input.pieces) {
		if (!rawPiece || typeof rawPiece !== 'object' || Array.isArray(rawPiece)) return null;
		const piece = rawPiece as Record<string, unknown>;
		const id = piece.id;
		const correctX = piece.correctX;
		const correctY = piece.correctY;

		if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= input.pieceCount) return null;
		if (pieceIds.has(id as number)) return null;
		if (!Number.isInteger(correctX) || (correctX as number) < 0 || (correctX as number) >= input.gridCols) return null;
		if (!Number.isInteger(correctY) || (correctY as number) < 0 || (correctY as number) >= input.gridRows) return null;

		const cell = `${correctX},${correctY}`;
		if (cells.has(cell)) return null;
		pieceIds.add(id as number);
		cells.add(cell);
		pieces.push({ id: id as number, correctX: correctX as number, correctY: correctY as number });
	}

	return {
		puzzleId: input.puzzleId,
		source: input.source,
		pieceIds: pieces.map((piece) => piece.id),
		gridCols: input.gridCols,
		gridRows: input.gridRows,
		pieceCount: input.pieceCount,
		pieces
	};
}
```

Then reduce `quickValidationContext()` to Quick-specific identity plus delegation:

```ts
function quickValidationContext(puzzle: StoredQuickPuzzle): SessionValidationContext | null {
	if (!puzzle || typeof puzzle !== 'object') return null;
	if (typeof puzzle.id !== 'string' || !puzzle.id.startsWith(QUICK_PUZZLE_ID_PREFIX)) return null;

	return explicitValidationContext({
		puzzleId: puzzle.id,
		source: 'local',
		pieceCount: puzzle.pieceCount,
		gridCols: puzzle.gridCols,
		gridRows: puzzle.gridRows,
		pieces: puzzle.pieces
	});
}
```

Do not change summary-based `serverValidationContext()`; summaries still need the existing row-major derivation.

- [ ] **Step 4: Add shared candidate projection helpers**

Add:

```ts
function candidateFromFetchedPuzzle(puzzle: Puzzle): GalleryCandidate | null {
	const context = explicitValidationContext({
		puzzleId: puzzle.id,
		source: 'api',
		pieceCount: puzzle.pieceCount,
		gridCols: puzzle.gridCols,
		gridRows: puzzle.gridRows,
		pieces: puzzle.pieces
	});
	if (!context) return null;

	return {
		puzzleId: puzzle.id,
		name: puzzle.name,
		source: 'api',
		pieceCount: puzzle.pieceCount,
		context
	};
}

function progressFromCandidate(
	candidate: GalleryCandidate,
	sessionStorage: SessionStorageAdapter
): GalleryProgress | null {
	const result = sessionStorage.peekSession(candidate.puzzleId, candidate.context);
	if (result.status !== 'loaded') return null;
	if (!sessionStorage.isResumable(result.snapshot)) return null;

	return {
		puzzleId: candidate.puzzleId,
		name: candidate.name,
		source: candidate.source,
		placedCount: result.snapshot.placedPieces.length,
		pieceCount: candidate.pieceCount,
		lastUpdated: result.snapshot.lastUpdated
	};
}
```

Refactor `discoverGalleryProgress()` to use `progressFromCandidate()` without changing its existing `byPuzzleId`/`newest` contract.

- [ ] **Step 5: Implement lazy `discoverAllSavedProgress()`**

```ts
export async function discoverAllSavedProgress(options: {
	puzzleIds: readonly string[];
	serverPuzzles: readonly PuzzleSummary[];
	quickPuzzles: readonly StoredQuickPuzzle[];
	fetchPuzzleById: (puzzleId: string) => Promise<Puzzle>;
	sessionStorage?: SessionStorageAdapter;
}): Promise<GalleryProgress[]> {
	const sessionStorage = options.sessionStorage ?? createSessionStorageAdapter();
	const serverById = new Map(options.serverPuzzles.map((puzzle) => [puzzle.id, puzzle] as const));
	const quickById = new Map(options.quickPuzzles.map((puzzle) => [puzzle.id, puzzle] as const));
	const ids = [...new Set(options.puzzleIds)];

	const candidates = await Promise.all(
		ids.map(async (puzzleId): Promise<GalleryCandidate | null> => {
			if (puzzleId.startsWith(QUICK_PUZZLE_ID_PREFIX)) {
				const puzzle = quickById.get(puzzleId);
				if (!puzzle) return null;
				const context = quickValidationContext(puzzle);
				return context
					? {
							puzzleId: puzzle.id,
							name: puzzle.name,
							source: 'local',
							pieceCount: puzzle.pieceCount,
							context
						}
					: null;
			}

			const summary = serverById.get(puzzleId);
			if (summary) {
				const context = serverValidationContext(summary);
				return context
					? {
							puzzleId: summary.id,
							name: summary.name,
							source: 'api',
							pieceCount: summary.pieceCount,
							context
						}
					: null;
			}

			try {
				const puzzle = await options.fetchPuzzleById(puzzleId);
				if (puzzle.id !== puzzleId) return null;
				return candidateFromFetchedPuzzle(puzzle);
			} catch {
				return null;
			}
		})
	);

	return candidates
		.flatMap((candidate) => {
			if (!candidate) return [];
			const progress = progressFromCandidate(candidate, sessionStorage);
			return progress ? [progress] : [];
		})
		.sort((a, b) => b.lastUpdated - a.lastUpdated || a.puzzleId.localeCompare(b.puzzleId));
}
```

Never call `loadSession()` or `clearSession()` in this function.

- [ ] **Step 6: Run service regression coverage**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/galleryProgress.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/web/src/lib/services/gameplay/galleryProgress.ts \
  apps/web/src/lib/services/gameplay/galleryProgress.test.ts
git commit -m "feat(web): discover all resumable puzzle saves"
```

---

### Task 3: Move Pointer Rotation to the Inventory Header and Migrate Route Tests

**Files:**
- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Interfaces:**
- Keeps `PuzzlePiece.onRotate?: (pieceId: number) => void` for keyboard `R`.
- Produces inventory header `aria-label="Rotate selected piece"` with visible text `ROTATE`.
- No route/session production change is required.

- [ ] **Step 1: Rewrite `PuzzlePiece` tests for overlay absence**

Delete child-button tests that require `Rotate piece 7` and remove the unused `userEvent` import if no remaining test uses it.

Keep the existing `r`/`R`, visual transform, and accessible orientation tests. Add:

```ts
it('never overlays a rotate button when rotation is enabled', async () => {
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: false,
		resolveImage,
		rotationEnabled: true,
		onRotate: vi.fn()
	});

	expect(document.querySelector('[data-testid="rotate-piece-button"]')).toBeNull();
	await expect
		.element(page.getByTestId('puzzle-piece'))
		.toHaveAttribute('aria-keyshortcuts', 'R');
});
```

- [ ] **Step 2: Add failing inventory-header Rotate tests**

Add to `PuzzleInventoryPanel.svelte.test.ts`:

```ts
it('shows Rotate only for a selected piece while rotation is enabled', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, input);

	expect(page.getByRole('button', { name: 'Rotate selected piece' }).query()).toBeNull();

	await view.rerender({ ...input, selectedPieceId: 1 });
	await expect
		.element(page.getByRole('button', { name: 'Rotate selected piece' }))
		.toBeVisible();

	await view.rerender({ ...input, selectedPieceId: 1, rotationEnabled: false });
	expect(page.getByRole('button', { name: 'Rotate selected piece' }).query()).toBeNull();
});

it('rotates the selected piece from the header and keeps the action while collapsed', async () => {
	const input = baseProps();
	render(PuzzleInventoryPanel, { ...input, selectedPieceId: 1 });

	await page.getByRole('button', { name: 'Rotate selected piece' }).click();
	expect(input.onRotate).toHaveBeenCalledWith(1);

	await page.getByRole('button', { name: 'Collapse inventory' }).click();
	await expect
		.element(page.getByRole('button', { name: 'Rotate selected piece' }))
		.toBeVisible();
});
```

Update the roving-focus tests that currently query `[data-testid="rotate-piece-button"]`: after the change, assert exactly one visible piece root has `tabIndex === 0`; remove the child-button arrow special-case test because the child no longer exists.

- [ ] **Step 3: Run component tests and verify failure**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL until the overlay is removed and header action is added.

- [ ] **Step 4: Remove the child Rotate control from `PuzzlePiece.svelte`**

Delete:

```ts
function handleRotateClick(event: MouseEvent) {
	event.preventDefault();
	event.stopPropagation();
	onRotate?.(piece.id);
}

function stopRotateEventPropagation(event: Event) {
	event.stopPropagation();
}
```

Delete the entire conditional Rotate `<button>` block above the piece root. Keep `handleKeyDown()`'s `r`/`R` branch and `aria-keyshortcuts` unchanged.

- [ ] **Step 5: Add header Rotate and simplify inventory key handling**

In `.panel-actions`, before `CANCEL`, render:

```svelte
{#if rotationEnabled && selectedPieceId !== null}
	<button
		type="button"
		class="panel-action"
		aria-label="Rotate selected piece"
		onclick={() => onRotate(selectedPieceId)}
	>
		ROTATE
	</button>
{/if}
```

In `handlePiecesKeyDown()`, remove the branch that checks:

```ts
target.closest('[data-testid="rotate-piece-button"]')
```

and update its comments so Left/Right traversal is described only for piece roots.

- [ ] **Step 6: Migrate every puzzle-route test that clicks `Rotate piece N`**

First locate all old callers:

```bash
rg -n "Rotate piece [0-9]+" 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Add a small helper near the existing `selectPiece()` helpers:

```ts
async function rotateSelectedPiece(): Promise<void> {
	await page.getByRole('button', { name: 'Rotate selected piece' }).click();
}
```

Retarget each old pointer-rotation call using these state rules:

- if the target piece is not selected, call `await selectPiece(id);` before `await rotateSelectedPiece();`;
- if it is already selected, call only `await rotateSelectedPiece();`;
- if the old test rotated first and later called `selectPiece(id)`, remove that later selection when the new pointer path already left the piece selected, otherwise Enter would toggle it off;
- when a test changes the target piece, explicitly select the new target before rotating it.

The currently verified old callers include the rotation/history block around lines 1296–1425, timer-start rotation around 1742–1749, and rejection/announcer rotation around 3107–3152. The `rg` command is the completion check: it must return no `Rotate piece N` test caller after migration.

Update the main rotation route test to prove the new pointer contract:

```ts
await page.getByLabelText('More puzzle actions').click();
await page.getByLabelText('Rotation mode').click();
expect(page.getByRole('button', { name: 'Rotate selected piece' }).query()).toBeNull();

await selectPiece(0);
await expect
	.element(page.getByRole('button', { name: 'Rotate selected piece' }))
	.toBeVisible();
await rotateSelectedPiece();
await expect
	.element(page.getByTestId('puzzle-piece-visual').first())
	.toHaveAttribute('style', 'transform: rotate(90deg);');
```

- [ ] **Step 7: Add one route-level focused-piece `R` test**

Add beside the pointer rotation route test:

```ts
it('rotates a focused tray piece with R without a thumbnail rotate button', async () => {
	await renderPuzzlePage();
	await page.getByLabelText('More puzzle actions').click();
	await page.getByLabelText('Rotation mode').click();

	expect(document.querySelector('[data-testid="rotate-piece-button"]')).toBeNull();
	const piece = await page.getByTestId('piece-slot-0').getByTestId('puzzle-piece').element();
	piece.focus();
	piece.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', bubbles: true }));

	await expect
		.element(page.getByTestId('puzzle-piece-visual').first())
		.toHaveAttribute('style', 'transform: rotate(90deg);');
	await expect
		.element(page.getByTestId('gameplay-announcer'))
		.toHaveTextContent('Puzzle piece 0 rotated.');
});
```

This route test intentionally does not select the piece first; it proves keyboard rotation remains independent from the new pointer/touch selection requirement.

- [ ] **Step 8: Run component and route rotation coverage immediately**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS, and:

```bash
rg -n "Rotate piece [0-9]+" 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: no matches.

- [ ] **Step 9: Commit Task 3**

```bash
git add apps/web/src/lib/components/PuzzlePiece.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): move piece rotation out of tray thumbnails"
```

---

### Task 4: Add the Concrete Saved Progress Dialog

**Files:**
- Create: `apps/web/src/lib/components/SavedProgressDialog.svelte`
- Create: `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts`

**Interfaces:**

```ts
interface Props {
	progress: readonly GalleryProgress[];
	loading: boolean;
	onClose: () => void;
}
```

- [ ] **Step 1: Write failing dialog tests**

Create `SavedProgressDialog.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SavedProgressDialog from '../SavedProgressDialog.svelte';
import type { GalleryProgress } from '$lib/services/gameplay/galleryProgress';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

const progress: GalleryProgress[] = [
	{
		puzzleId: 'old-save',
		name: 'Older Mission',
		source: 'api',
		placedCount: 3,
		pieceCount: 12,
		lastUpdated: 1_000
	}
];

describe('SavedProgressDialog', () => {
	it('renders loading state without rows', async () => {
		render(SavedProgressDialog, { progress: [], loading: true, onClose: vi.fn() });
		await expect.element(page.getByRole('dialog', { name: 'Saved progress' })).toBeVisible();
		await expect.element(page.getByText('LOADING SAVED PROGRESS...')).toBeVisible();
	});

	it('renders empty state after loading', async () => {
		render(SavedProgressDialog, { progress: [], loading: false, onClose: vi.fn() });
		await expect.element(page.getByText('NO SAVED PROGRESS')).toBeVisible();
	});

	it('renders progress rows and existing-route Continue links', async () => {
		render(SavedProgressDialog, { progress, loading: false, onClose: vi.fn() });
		const row = page.getByTestId('saved-progress-row-old-save');
		await expect.element(row).toHaveTextContent('Older Mission');
		await expect.element(row).toHaveTextContent('3/12 PLACED');
		await expect
			.element(row.getByRole('link', { name: 'CONTINUE' }))
			.toHaveAttribute('href', '/puzzle/old-save');
	});

	it('closes from the Close button and Escape', async () => {
		const onClose = vi.fn();
		render(SavedProgressDialog, { progress, loading: false, onClose });
		await page.getByRole('button', { name: 'Close saved progress' }).click();
		expect(onClose).toHaveBeenCalledTimes(1);

		const dialog = await page.getByRole('dialog', { name: 'Saved progress' }).element();
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the concrete dialog using existing modal focus**

Create `SavedProgressDialog.svelte` with this structure:

```svelte
<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import { resolve } from '$app/paths';
	import type { GalleryProgress } from '$lib/services/gameplay/galleryProgress';

	interface Props {
		progress: readonly GalleryProgress[];
		loading: boolean;
		onClose: () => void;
	}

	let { progress, loading, onClose }: Props = $props();
</script>

<div class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4">
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Saved progress"
		tabindex="-1"
		use:modalFocus
		onkeydown={(event) => event.key === 'Escape' && onClose()}
		class="flex max-h-[min(80dvh,42rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
	>
		<header class="flex items-center justify-between gap-4 border-b border-gray-200 p-5">
			<h2 class="text-lg font-semibold text-gray-900">Saved progress</h2>
			<button type="button" aria-label="Close saved progress" onclick={onClose}>CLOSE</button>
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto p-5">
			{#if loading}
				<p>LOADING SAVED PROGRESS...</p>
			{:else if progress.length === 0}
				<p>NO SAVED PROGRESS</p>
			{:else}
				<div class="flex flex-col gap-3">
					{#each progress as item (item.puzzleId)}
						<div data-testid={`saved-progress-row-${item.puzzleId}`} class="flex items-center justify-between gap-4">
							<div class="min-w-0">
								<p>{item.name}</p>
								<p>{item.placedCount}/{item.pieceCount} PLACED</p>
							</div>
							<a href={resolve(`/puzzle/${item.puzzleId}`)}>CONTINUE</a>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
```

Use existing Perseus tokens/classes when implementing the final styling, but keep the component concrete; do not extract shared modal chrome.

- [ ] **Step 4: Run dialog tests**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/web/src/lib/components/SavedProgressDialog.svelte \
  apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts
git commit -m "feat(web): add saved progress picker dialog"
```

---

### Task 5: Wire Candidate Visibility and Lazy Picker Loading Into the Gallery

**Files:**
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`

**Interfaces:**
- Consumes: `listResumableSessionCandidateIds`, `discoverAllSavedProgress`, `fetchPuzzle`, `SavedProgressDialog`.
- Keeps: synchronous `discoverGalleryProgress()` for newest/card progress.

- [ ] **Step 1: Extend gallery-page mocks and add failing tests**

Update the persistence hoisted spies:

```ts
const sessionStorageSpies = vi.hoisted(() => ({
	clearSession: vi.fn(),
	listCandidates: vi.fn<() => string[]>()
}));

vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({
		clearSession: sessionStorageSpies.clearSession
	}),
	listResumableSessionCandidateIds: sessionStorageSpies.listCandidates
}));
```

Add `fetchPuzzle` to the API mock and `discoverAllSavedProgress` to the gallery-progress mock:

```ts
fetchPuzzle: vi.fn(),
```

```ts
discoverAllSavedProgress: vi.fn().mockResolvedValue([])
```

Import the mocked functions and initialize before each test:

```ts
const mockedDiscoverAllSavedProgress = vi.mocked(discoverAllSavedProgress);
const mockedFetchPuzzle = vi.mocked(fetchPuzzle);

beforeEach(() => {
	// existing resets
	sessionStorageSpies.listCandidates.mockReturnValue([]);
	mockedDiscoverAllSavedProgress.mockResolvedValue([]);
});
```

Add these focused tests:

```ts
it('scans Quick metadata and resumable save candidates once per gallery mount', async () => {
	sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
	render(GalleryPage);

	await vi.waitFor(() => expect(mockedListQuick).toHaveBeenCalledTimes(1));
	expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(1);

	await page.getByTestId('search-input').fill('filtered');
	await vi.waitFor(() => expect(mockedFetchPuzzles).toHaveBeenCalledTimes(2));
	expect(mockedListQuick).toHaveBeenCalledTimes(1);
	expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(1);
});

it('does not show current-device progress for completed-only/no candidate storage', async () => {
	sessionStorageSpies.listCandidates.mockReturnValue([]);
	mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
	render(GalleryPage);

	await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();
});

it('shows View Saved Progress for an off-page candidate even when newest is null', async () => {
	sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
	mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
	render(GalleryPage);

	await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('SAVED PROGRESS AVAILABLE');
	await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
	expect(mockedDiscoverAllSavedProgress).not.toHaveBeenCalled();
	expect(mockedFetchPuzzle).not.toHaveBeenCalled();
});

it('loads the full picker only when requested and makes main inert', async () => {
	const item = {
		puzzleId: 'off-page',
		name: 'Older Save',
		source: 'api' as const,
		placedCount: 2,
		pieceCount: 4,
		lastUpdated: 1_000
	};
	sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
	mockedDiscoverAllSavedProgress.mockResolvedValue([item]);
	render(GalleryPage);

	await page.getByRole('button', { name: 'View saved progress' }).click();
	await vi.waitFor(() => {
		expect(mockedDiscoverAllSavedProgress).toHaveBeenCalledWith({
			puzzleIds: ['off-page'],
			serverPuzzles: [],
			quickPuzzles: [],
			fetchPuzzleById: mockedFetchPuzzle,
			sessionStorage: expect.any(Object)
		});
	});
	await expect.element(page.getByRole('dialog', { name: 'Saved progress' })).toBeVisible();
	await expect.element(page.getByText('Older Save')).toBeVisible();
	expect(document.querySelector('main')?.hasAttribute('inert')).toBe(true);

	await page.getByRole('button', { name: 'Close saved progress' }).click();
	expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false);
});
```

Update the existing discard test so `listCandidates` returns the pre-discard ID first and `[]` after `clearSession`, then assert the current-device section disappears when no newest/candidate remains.

- [ ] **Step 2: Run page tests and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/routes/page.svelte.test.ts
```

Expected: FAIL because candidate and dialog orchestration do not exist.

- [ ] **Step 3: Add gallery imports and route-local state**

Update imports:

```ts
import { fetchPuzzle, fetchPuzzles, ApiError } from '$lib/services/api';
import SavedProgressDialog from '$lib/components/SavedProgressDialog.svelte';
import {
	discoverAllSavedProgress,
	discoverGalleryProgress,
	type GalleryProgress,
	type GalleryProgressDiscovery
} from '$lib/services/gameplay/galleryProgress';
import {
	createSessionStorageAdapter,
	listResumableSessionCandidateIds
} from '$lib/services/gameplay/session/persistence';
```

Add state:

```ts
let savedProgressCandidateIds = $state<string[]>([]);
let savedProgressOpen = $state(false);
let savedProgressLoading = $state(false);
let savedProgressItems = $state<GalleryProgress[]>([]);
let savedProgressRequestId = 0;
```

Extend mount-only enumeration:

```ts
onMount(() => {
	quickPuzzles = listQuick();
	savedProgressCandidateIds = listResumableSessionCandidateIds();
});
```

Do not put candidate scanning in an effect.

- [ ] **Step 4: Add picker open/close functions with stale-result fencing**

```ts
async function openSavedProgress(): Promise<void> {
	const requestId = ++savedProgressRequestId;
	savedProgressOpen = true;
	savedProgressLoading = true;
	savedProgressItems = [];

	const items = await discoverAllSavedProgress({
		puzzleIds: savedProgressCandidateIds,
		serverPuzzles: puzzles,
		quickPuzzles,
		fetchPuzzleById: fetchPuzzle,
		sessionStorage: sessionStorageAdapter
	});
	if (requestId !== savedProgressRequestId) return;

	savedProgressItems = items;
	savedProgressLoading = false;
}

function closeSavedProgress(): void {
	savedProgressRequestId += 1;
	savedProgressOpen = false;
	savedProgressLoading = false;
	savedProgressItems = [];
}
```

`discoverAllSavedProgress()` already converts individual metadata failures into skipped rows, so the route does not need a second per-row error model.

- [ ] **Step 5: Update current-device section gating and actions**

Change the section condition to:

```svelte
{#if localProgress.newest || savedProgressCandidateIds.length > 0}
```

Inside the existing section:

```svelte
{#if localProgress.newest}
	<!-- keep existing name, placed/total, CONTINUE and DISCARD markup -->
{:else}
	<p class="...">SAVED PROGRESS AVAILABLE</p>
{/if}

{#if savedProgressCandidateIds.length > 0}
	<button
		type="button"
		aria-label="View saved progress"
		class="..."
		onclick={() => void openSavedProgress()}
	>
		VIEW SAVED PROGRESS
	</button>
{/if}
```

Do not show Discard when `localProgress.newest` is null.

- [ ] **Step 6: Refresh candidate visibility after newest-session discard**

At the end of `confirmDiscardProgress()` after `clearSession()` and `discoverGalleryProgress()`:

```ts
savedProgressCandidateIds = listResumableSessionCandidateIds();
```

This is an explicit user mutation, not search/filter/pagination; refreshing here is required so a removed key does not leave a stale picker affordance.

- [ ] **Step 7: Compose modal and inert state**

Change main inert/hidden conditions to:

```svelte
<main
	inert={discardTarget !== null || savedProgressOpen}
	aria-hidden={discardTarget !== null || savedProgressOpen}
	...
>
```

Render beside `DiscardSessionDialog`:

```svelte
{#if savedProgressOpen}
	<SavedProgressDialog
		progress={savedProgressItems}
		loading={savedProgressLoading}
		onClose={closeSavedProgress}
	/>
{/if}
```

- [ ] **Step 8: Run gallery page and supporting tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/routes/page.svelte.test.ts \
  src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts \
  src/lib/services/gameplay/galleryProgress.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add apps/web/src/routes/+page.svelte \
  apps/web/src/routes/page.svelte.test.ts
git commit -m "feat(web): open all saved puzzle progress"
```

---

### Task 6: Prove an Older Off-Page Save Can Be Resumed End-to-End

**Files:**
- Modify: `apps/web/e2e/gallery.spec.ts`

**Interfaces:**
- Reuses: `getFixture`, `createFixtureRouter`, `buildMinimalSeed`, `createPersistedStateController`.
- No new fixture family or page object.

- [ ] **Step 1: Replace/extend the current newest-session E2E with two valid saves**

Use `e2e-square-4` as the loaded newest save and `e2e-landscape-12` as the older save omitted from the gallery list:

```ts
test('continues the newest save and can choose an older off-page save', async ({ page }) => {
	const newestId = 'e2e-square-4';
	const olderId = 'e2e-landscape-12';
	const newest = getFixture(newestId);
	const older = getFixture(olderId);
	const newestPiece = newest.pieces[0]!;
	const olderPiece = older.pieces[0]!;
	const storage = createPersistedStateController();

	await mockPuzzleList(page, [
		{
			id: newestId,
			name: 'Newest Resume Fixture',
			pieceCount: newest.pieceCount,
			aspectRatio: newest.aspectRatio,
			status: 'ready'
		}
	]);
	await createFixtureRouter().install(page);
	await page.goto('/');

	await storage.seedValid(page, newestId, {
		...buildMinimalSeed(newestId),
		placedPieces: [{
			pieceId: newestPiece.id,
			x: newestPiece.correctX,
			y: newestPiece.correctY
		}],
		timerStarted: true,
		hasUserActivity: true,
		lastUpdated: 3_000
	});
	await storage.seedValid(page, olderId, {
		...buildMinimalSeed(olderId),
		placedPieces: [{
			pieceId: olderPiece.id,
			x: olderPiece.correctX,
			y: olderPiece.correctY
		}],
		timerStarted: true,
		hasUserActivity: true,
		lastUpdated: 2_000
	});
	await page.reload();

	await expect(page.getByTestId('continue-on-device')).toContainText('Newest Resume Fixture');
	await expect(page.getByTestId('continue-on-device')).toContainText('1/4 PLACED');

	await page.getByRole('button', { name: 'View saved progress' }).click();
	const dialog = page.getByRole('dialog', { name: 'Saved progress' });
	await expect(dialog.getByTestId(`saved-progress-row-${newestId}`)).toBeVisible();
	await expect(dialog.getByTestId(`saved-progress-row-${olderId}`)).toContainText(older.name);

	await dialog
		.getByTestId(`saved-progress-row-${olderId}`)
		.getByRole('link', { name: 'CONTINUE' })
		.click();
	await expect(page).toHaveURL(new RegExp(`/puzzle/${olderId}$`));
});
```

The initial gallery response intentionally omits `olderId`; its full metadata must come from the existing fixture-router detail path only after the picker opens.

- [ ] **Step 2: Run the focused E2E**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 3: Commit Task 6**

```bash
git add apps/web/e2e/gallery.spec.ts
git commit -m "test(web): cover older saved puzzle resume"
```

---

### Task 7: Final Focused Verification

**Files:**
- No production changes expected.
- Fix only regressions caused by HPA-647 if a command below fails.

- [ ] **Step 1: Run all changed Vitest surfaces, including the puzzle route**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/session/persistence.test.ts \
  src/lib/services/gameplay/session/persistence.validation-storage.test.ts \
  src/lib/services/gameplay/session/persistence.fallback-storage.test.ts \
  src/lib/services/gameplay/galleryProgress.test.ts \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts \
  src/routes/page.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 2: Confirm the obsolete per-piece Rotate locator is gone from current tests/production**

```bash
cd apps/web
rg -n "rotate-piece-button|Rotate piece [0-9]+" \
  src/lib/components \
  src/routes/puzzle
```

Expected: no production/test references to the removed overlay. `aria-keyshortcuts="R"`, `onRotate`, and the new `Rotate selected piece` remain.

- [ ] **Step 3: Run Svelte/TypeScript checks**

```bash
cd apps/web
bun run check
```

Expected: PASS.

- [ ] **Step 4: Run gallery E2E**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 5: Inspect scope before marking the draft ready**

```bash
git status --short
git diff --stat origin/main...HEAD
```

Expected production scope is limited to:

```text
apps/web/src/lib/services/gameplay/session/persistence.ts
apps/web/src/lib/services/gameplay/galleryProgress.ts
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/lib/components/SavedProgressDialog.svelte
apps/web/src/routes/+page.svelte
```

plus the focused tests listed in this plan and the two HPA-647 planning docs. No API/database/shared-type/session-engine changes should appear.

- [ ] **Step 6: Commit verification-only fixes if needed**

If verification required a scoped HPA-647 correction, stage only those paths and commit them on the same PR branch. If all commands pass without changes, do not create an empty commit.
