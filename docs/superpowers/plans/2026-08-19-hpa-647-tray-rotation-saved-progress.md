# HPA-647 Tray Rotation and Saved Progress Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the tray-piece rotate overlay, preserve rotation through the selected-piece inventory action and `R` shortcut, and add a current-device saved-progress picker that can resume valid saves outside the currently loaded gallery results.

**Architecture:** Keep `PuzzleSession` and the current persistence schema unchanged. Add one small persistence key-enumeration helper, extend `galleryProgress.ts` with lazy full-save discovery using existing Quick/gallery metadata plus `fetchPuzzle(id)` for missing server metadata, move the pointer/touch rotate action into `PuzzleInventoryPanel`, and compose one concrete modal from the gallery route.

**Tech Stack:** Svelte 5 / SvelteKit, TypeScript, browser `localStorage`, Vitest Browser Mode, Playwright, existing `modalFocus`, existing Perseus gameplay persistence and E2E fixtures.

**Spec:** `docs/superpowers/specs/2026-08-19-hpa-647-tray-rotation-saved-progress-design.md`

## Global Constraints

- Deliver HPA-647 through this single draft PR and branch; implementation commits go onto the same PR. Do not open a second PR for this ticket.
- Do not change `PuzzleSession`, result-class rules, shared API contracts, database code, or `PersistedPuzzleSessionV1`.
- Do not add dependencies, a save index/schema, global progress store, batch API endpoint, history route, or generic dialog/list framework.
- Keep the current **Continue on this device** newest-session projection and existing home Discard behavior.
- Run `listQuick()` and `listPersistedSessionPuzzleIds()` once per gallery mount; search/filter/pagination changes must not rerun them.
- The mount-time save scan may inspect only keys beginning with the exact `puzzle-progress-` namespace; it must not parse or validate session values.
- Do not request missing server puzzle detail until the player opens **VIEW SAVED PROGRESS**.
- Full saved-progress discovery is read-only: use `peekSession()` and never delete invalid, completed, missing-metadata, or unresolved records.
- Picker rows are selection-only: puzzle name, placed/total progress, and existing-route Continue navigation; no rename/delete/search/filter/pagination in the modal.
- Remove the tray-piece Rotate overlay completely; keep the focused-piece `R` shortcut and orientation accessible name.
- Pointer/touch per-piece rotation is exposed only for a currently selected unplaced piece while rotation mode is enabled, through `PuzzleInventoryPanel`'s header action.

---

## File Structure

### Existing files to modify

- `apps/web/src/lib/services/gameplay/session/persistence.ts` — owns the `puzzle-progress-` namespace; add read-only ID enumeration without widening `SessionStorageAdapter`.
- `apps/web/src/lib/services/gameplay/session/persistence.test.ts` — focused coverage for owned-key enumeration and unavailable storage.
- `apps/web/src/lib/services/gameplay/galleryProgress.ts` — keep the cheap synchronous gallery projection and add lazy full-save metadata resolution/validation.
- `apps/web/src/lib/services/gameplay/galleryProgress.test.ts` — prove fetched saves, loaded-summary reuse, Quick reuse, filtering, and newest-first ordering.
- `apps/web/src/lib/components/PuzzlePiece.svelte` — remove only the visual Rotate child control; retain root keyboard rotation and orientation presentation.
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — add selected-piece header Rotate and remove the obsolete child-Rotate keyboard-navigation exception.
- `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts` — migrate rotation tests from child-button behavior to overlay absence + `R` behavior.
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — cover selected header Rotate visibility/callback/collapsed state and simplify roving-focus assertions.
- `apps/web/src/routes/+page.svelte` — mount-time save IDs, picker open/load/close state, current-device section composition, inert handling, and discard refresh.
- `apps/web/src/routes/page.svelte.test.ts` — cover one-time key scan, picker reachability without `newest`, lazy full discovery, inert state, and discard refresh.
- `apps/web/e2e/gallery.spec.ts` — prove an older save omitted from loaded gallery summaries is still resumable through the modal.

### New files

- `apps/web/src/lib/components/SavedProgressDialog.svelte` — one concrete modal for loading/empty/list states and Continue links.
- `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts` — modal behavior and navigation markup.

No API, database, shared-type, session-engine, package, or migration file is required.

---

### Task 1: Enumerate Perseus-Owned Session IDs

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts` around `PROGRESS_KEY_PREFIX` and `createSessionStorageAdapter()`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts` in the current-schema persistence section

**Interfaces:**
- Consumes: private `PROGRESS_KEY_PREFIX = 'puzzle-progress-'` and DOM `Storage`.
- Produces: `listPersistedSessionPuzzleIds(storage?: Storage): string[]`.
- Does not change: `SessionStorageAdapter` in `session/types.ts`.

- [ ] **Step 1: Write failing key-enumeration tests**

Extend the second import block in `persistence.test.ts` to include the new function:

```ts
import {
	serializeSession,
	loadPersistedSession,
	isResumable,
	createSessionStorageAdapter,
	listPersistedSessionPuzzleIds,
	noopThrowingStorage
} from './persistence';
```

Add this describe block after the existing storage-adapter tests:

```ts
describe('listPersistedSessionPuzzleIds', () => {
	it('returns only non-empty ids from the Perseus progress namespace', () => {
		const storage = memoryStorage({
			'puzzle-progress-pz-old': '{}',
			'puzzle-progress-q-local': '{}',
			'puzzle-progress-': '{}',
			'unrelated-setting': '1'
		});

		expect(listPersistedSessionPuzzleIds(storage)).toEqual(['pz-old', 'q-local']);
	});

	it('returns an empty list when storage enumeration is unavailable', () => {
		const blockedStorage = {
			get length() {
				throw new Error('blocked');
			},
			key: () => null,
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {}
		} satisfies Storage;

		expect(listPersistedSessionPuzzleIds(blockedStorage)).toEqual([]);
	});
});
```

The first assertion follows the deterministic insertion order of the existing `memoryStorage()` test helper. Final picker ordering comes from `lastUpdated`, not key order.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts
```

Expected: FAIL because `listPersistedSessionPuzzleIds` is not exported.

- [ ] **Step 3: Implement the shared storage resolver and owned-key scan**

Add this beside `PROGRESS_KEY_PREFIX` in `persistence.ts`:

```ts
function resolveSessionStorage(storage?: Storage): Storage {
	return (
		storage ??
		(typeof localStorage !== 'undefined' ? localStorage : undefined) ??
		noopThrowingStorage
	);
}

export function listPersistedSessionPuzzleIds(storage?: Storage): string[] {
	const resolvedStorage = resolveSessionStorage(storage);
	const ids = new Set<string>();

	try {
		for (let index = 0; index < resolvedStorage.length; index += 1) {
			const key = resolvedStorage.key(index);
			if (!key?.startsWith(PROGRESS_KEY_PREFIX)) continue;

			const puzzleId = key.slice(PROGRESS_KEY_PREFIX.length);
			if (puzzleId.length > 0) ids.add(puzzleId);
		}
	} catch {
		return [];
	}

	return [...ids];
}
```

Replace only the storage initialization at the start of `createSessionStorageAdapter()`:

```ts
export function createSessionStorageAdapter(options?: {
	storage?: Storage;
	onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter {
	const storage = resolveSessionStorage(options?.storage);
	const onError = options?.onError;
```

Leave `readSession`, `peekSession`, `loadSession`, `saveSession`, `clearSession`, and the returned adapter shape unchanged.

- [ ] **Step 4: Run persistence coverage and verify pass**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/session/persistence.test.ts \
  src/lib/services/gameplay/session/persistence.validation-storage.test.ts \
  src/lib/services/gameplay/session/persistence.fallback-storage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/session/persistence.test.ts
git commit -m "feat(web): enumerate local puzzle save ids"
```

---

### Task 2: Discover and Validate the Full Saved-Progress List Lazily

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`

**Interfaces:**
- Consumes: `SessionStorageAdapter.peekSession()`, `SessionStorageAdapter.isResumable()`, `PuzzleSummary`, `StoredQuickPuzzle`, `Puzzle`, and injected `fetchPuzzleById`.
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

- Keeps: `discoverGalleryProgress()` and `GalleryProgressDiscovery` public behavior unchanged.

- [ ] **Step 1: Write failing full-discovery tests**

Change the first Vitest import in `galleryProgress.test.ts` to:

```ts
import { describe, expect, it, vi } from 'vitest';
```

Change the puzzle and service imports to:

```ts
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
import { discoverAllSavedProgress, discoverGalleryProgress } from './galleryProgress';
```

Add this helper after `quickPuzzle()`:

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

Add this describe block after the existing `discoverGalleryProgress` tests:

```ts
describe('discoverAllSavedProgress', () => {
	it('includes loaded, fetched, and Quick saves and sorts newest first', async () => {
		const base = validSnapshot();
		const loadedSnapshot: PersistedPuzzleSessionV1 = {
			...base,
			puzzleId: 'pz-loaded',
			lastUpdated: 1_000
		};
		const fetchedSnapshot: PersistedPuzzleSessionV1 = {
			...base,
			puzzleId: 'pz-old',
			lastUpdated: 3_000
		};
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...base,
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 2_000
		};
		const store = memoryStorage({
			'puzzle-progress-pz-loaded': JSON.stringify(loadedSnapshot),
			'puzzle-progress-pz-old': JSON.stringify(fetchedSnapshot),
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
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

	it('uses puzzle id as a deterministic tie breaker', async () => {
		const base = validSnapshot();
		const store = memoryStorage({
			'puzzle-progress-b': JSON.stringify({ ...base, puzzleId: 'b', lastUpdated: 2_000 }),
			'puzzle-progress-a': JSON.stringify({ ...base, puzzleId: 'a', lastUpdated: 2_000 })
		});

		const progress = await discoverAllSavedProgress({
			puzzleIds: ['b', 'a'],
			serverPuzzles: [serverPuzzle('a', 4, '1:1'), serverPuzzle('b', 4, '1:1')],
			quickPuzzles: [],
			fetchPuzzleById: vi.fn(),
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(progress.map((item) => item.puzzleId)).toEqual(['a', 'b']);
	});

	it('skips unresolved metadata and completed saves without deleting them', async () => {
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

- [ ] **Step 2: Run the service test and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/galleryProgress.test.ts
```

Expected: FAIL because `discoverAllSavedProgress` does not exist.

- [ ] **Step 3: Extract one reusable candidate-to-progress projection**

In `galleryProgress.ts`, change the puzzle import to:

```ts
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
```

Add:

```ts
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

In the existing `discoverGalleryProgress()` candidate loop, replace the inline load/projection block with:

```ts
for (const candidate of candidates) {
	const progress = progressFromCandidate(candidate, sessionStorage);
	if (!progress) continue;

	if (candidate.source === 'api') byPuzzleId.set(candidate.puzzleId, progress);
	if (newest === null || progress.lastUpdated > newest.lastUpdated) newest = progress;
}
```

- [ ] **Step 4: Add the fetched-server candidate builder**

Add:

```ts
function fetchedServerCandidate(puzzle: Puzzle): GalleryCandidate | null {
	if (
		!Number.isInteger(puzzle.pieceCount) ||
		puzzle.pieceCount <= 0 ||
		!Number.isInteger(puzzle.gridCols) ||
		puzzle.gridCols <= 0 ||
		!Number.isInteger(puzzle.gridRows) ||
		puzzle.gridRows <= 0 ||
		puzzle.gridCols * puzzle.gridRows !== puzzle.pieceCount ||
		!Array.isArray(puzzle.pieces) ||
		puzzle.pieces.length !== puzzle.pieceCount
	) {
		return null;
	}

	const pieces = puzzle.pieces.map((piece) => ({
		id: piece.id,
		correctX: piece.correctX,
		correctY: piece.correctY
	}));

	return {
		puzzleId: puzzle.id,
		name: puzzle.name,
		source: 'api',
		pieceCount: puzzle.pieceCount,
		context: {
			puzzleId: puzzle.id,
			source: 'api',
			pieceIds: pieces.map((piece) => piece.id),
			gridCols: puzzle.gridCols,
			gridRows: puzzle.gridRows,
			pieceCount: puzzle.pieceCount,
			pieces
		}
	};
}
```

This only builds canonical validation context from the typed puzzle detail. Persisted-session validity still comes exclusively from `peekSession()`.

- [ ] **Step 5: Implement `discoverAllSavedProgress()`**

Add below `discoverGalleryProgress()`:

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
	const puzzleIds = [...new Set(options.puzzleIds)];

	const candidates = await Promise.all(
		puzzleIds.map(async (puzzleId): Promise<GalleryCandidate | null> => {
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
				return fetchedServerCandidate(puzzle);
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

Do not call `loadSession()` or `clearSession()` anywhere in this function.

- [ ] **Step 6: Run service tests and verify pass**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/services/gameplay/galleryProgress.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts
```

Expected: PASS, including the pre-existing HPA-218 projection tests.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/web/src/lib/services/gameplay/galleryProgress.ts \
  apps/web/src/lib/services/gameplay/galleryProgress.test.ts
git commit -m "feat(web): discover all resumable puzzle saves"
```

---

### Task 3: Move Per-Piece Rotation Out of Tray Thumbnails

**Files:**
- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`

**Interfaces:**
- Consumes: existing `PuzzlePiece` props `rotationEnabled`, `rotation`, `onRotate`, and inventory props `selectedPieceId`, `rotationEnabled`, `onRotate`.
- Produces: inventory header button with `aria-label="Rotate selected piece"` and visible text `ROTATE`.
- Keeps: `PuzzlePiece.onRotate?: (pieceId: number) => void` because root `R` handling still uses it.

- [ ] **Step 1: Replace old child-Rotate tests with the new `PuzzlePiece` contract**

Inside the existing `describe('rotation support')`, delete these tests:

- `renders a rotate control when rotation is enabled for an unplaced piece`
- `calls onRotate when the rotate control is clicked`
- `keeps the rotate control outside the piece interactive element`
- `rotates without selecting the piece`

Replace the first enabled-rotation test with:

```ts
it('does not overlay a rotate control when rotation is enabled', async () => {
	render(PuzzlePiece, {
		piece: mockPiece,
		isPlaced: false,
		resolveImage,
		rotationEnabled: true,
		onRotate: vi.fn()
	});

	expect(page.getByRole('button', { name: 'Rotate piece 7' }).query()).toBeNull();
	await expect.element(page.getByTestId('puzzle-piece')).toHaveAttribute('aria-keyshortcuts', 'R');
});
```

Rename `exposes the rotation angle in the piece name and keeps the active rotate button tabbable` to `exposes the rotation angle in the piece name and keyboard shortcut`, and leave only these assertions:

```ts
await expect
	.element(page.getByTestId('puzzle-piece'))
	.toHaveAttribute('aria-label', 'Puzzle piece 7, rotated 90 degrees');
await expect
	.element(page.getByTestId('puzzle-piece'))
	.toHaveAttribute('aria-keyshortcuts', 'R');
```

Keep `calls onRotate when r and R are pressed while the piece is focused` unchanged. After deleting the child-button click tests, remove `userEvent` from the `vitest/browser` import if it has no remaining callers.

- [ ] **Step 2: Add failing selected-piece header Rotate tests**

In `PuzzleInventoryPanel.svelte.test.ts`, remove the old line from `forwards select, rotate, and cancel selection` that clicks `Rotate piece 1`; keep the existing Enter select/cancel assertions.

Add:

```ts
it('rotates the selected piece from the header only while rotation is enabled', async () => {
	const input = baseProps();
	const view = render(PuzzleInventoryPanel, { ...input, selectedPieceId: 1 });

	await page.getByRole('button', { name: 'Rotate selected piece' }).click();
	expect(input.onRotate).toHaveBeenCalledOnce();
	expect(input.onRotate).toHaveBeenCalledWith(1);

	await view.rerender({ ...input, selectedPieceId: null });
	expect(page.getByRole('button', { name: 'Rotate selected piece' }).query()).toBeNull();

	await view.rerender({ ...input, selectedPieceId: 1, rotationEnabled: false });
	expect(page.getByRole('button', { name: 'Rotate selected piece' }).query()).toBeNull();
});

it('keeps selected-piece Rotate in the header while the drawer is collapsed', async () => {
	render(PuzzleInventoryPanel, { ...baseProps(), selectedPieceId: 1 });

	await page.getByRole('button', { name: 'Collapse inventory' }).click();

	await expect
		.element(page.getByRole('button', { name: 'Rotate selected piece' }))
		.toBeInTheDocument();
});
```

In the roving-focus test that currently collects `[data-testid="rotate-piece-button"]`, delete `rotateButtons` and assert only one piece root has `tabIndex === 0`. Delete the separate block that focuses a Rotate child and dispatches `ArrowRight`; that focusable child no longer exists by design.

- [ ] **Step 3: Run both component tests and verify failure**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because the old overlay still renders and the panel header lacks `Rotate selected piece`.

- [ ] **Step 4: Remove only the child Rotate control from `PuzzlePiece.svelte`**

Delete `handleRotateClick()` and `stopRotateEventPropagation()` and delete the complete `{#if rotationEnabled && !isPlaced}` Rotate `<button>` block carrying `data-testid="rotate-piece-button"`.

Keep this root keyboard branch unchanged:

```ts
if (rotationEnabled && (event.key === 'r' || event.key === 'R')) {
	event.preventDefault();
	onRotate?.(piece.id);
	return;
}
```

Update the `tabIndex` comment to state that the supplied value controls the unplaced piece root. Do not remove `onRotate` from props.

- [ ] **Step 5: Add the inventory header action and remove the obsolete child-control keyboard exception**

Insert this in `.panel-actions` immediately before the existing `CANCEL` button:

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

Delete this branch from `handlePiecesKeyDown()`:

```ts
if (target.closest('[data-testid="rotate-piece-button"]')) return;
```

Delete comments describing the child Rotate button as an independent focus leaf. Keep the existing Left/Right, Home/End, focusin, selection, filtering, and drawer behavior unchanged.

- [ ] **Step 6: Run component tests and verify pass**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/web/src/lib/components/PuzzlePiece.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
git commit -m "feat(web): move tray rotation to selected piece action"
```

---

### Task 4: Add the Concrete Saved Progress Dialog

**Files:**
- Create: `apps/web/src/lib/components/SavedProgressDialog.svelte`
- Create: `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts`

**Interfaces:**
- Consumes: `GalleryProgress`, `$app/paths.resolve`, and `$lib/actions/modalFocus`.
- Produces:

```ts
interface Props {
	progress: readonly GalleryProgress[];
	loading: boolean;
	onClose: () => void;
}
```

- Stable dialog name: `Saved progress`.
- Stable row test ID: `saved-progress-${puzzleId}`.

- [ ] **Step 1: Write failing dialog component tests**

Create `SavedProgressDialog.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SavedProgressDialog from '../SavedProgressDialog.svelte';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

const progress = [
	{
		puzzleId: 'pz-new',
		name: 'New Save',
		source: 'api' as const,
		placedCount: 3,
		pieceCount: 4,
		lastUpdated: 3_000
	},
	{
		puzzleId: 'q-old',
		name: 'Old Quick Save',
		source: 'local' as const,
		placedCount: 1,
		pieceCount: 4,
		lastUpdated: 1_000
	}
];

describe('SavedProgressDialog', () => {
	it('shows loading without save rows', async () => {
		render(SavedProgressDialog, { progress, loading: true, onClose: vi.fn() });

		await expect.element(page.getByRole('dialog', { name: 'Saved progress' })).toBeVisible();
		await expect.element(page.getByText('LOADING SAVES...')).toBeVisible();
		expect(page.getByTestId('saved-progress-pz-new').query()).toBeNull();
	});

	it('renders supplied rows and puzzle links in order', async () => {
		render(SavedProgressDialog, { progress, loading: false, onClose: vi.fn() });

		const rows = document.querySelectorAll('[data-testid^="saved-progress-"]');
		expect(Array.from(rows, (row) => row.getAttribute('data-testid'))).toEqual([
			'saved-progress-pz-new',
			'saved-progress-q-old'
		]);
		await expect.element(page.getByText('3/4 PLACED')).toBeVisible();
		await expect
			.element(page.getByTestId('saved-progress-q-old').getByRole('link', { name: 'CONTINUE' }))
			.toHaveAttribute('href', '/puzzle/q-old');
	});

	it('shows the empty state after loading', async () => {
		render(SavedProgressDialog, { progress: [], loading: false, onClose: vi.fn() });
		await expect.element(page.getByText('NO SAVED PROGRESS')).toBeVisible();
	});

	it('closes from the visible button and Escape', async () => {
		const onClose = vi.fn();
		render(SavedProgressDialog, { progress: [], loading: false, onClose });

		await page.getByRole('button', { name: 'Close saved progress' }).click();
		expect(onClose).toHaveBeenCalledTimes(1);

		const dialog = await page.getByRole('dialog', { name: 'Saved progress' }).element();
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run the dialog test and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the dialog using the existing modal focus pattern**

Create `SavedProgressDialog.svelte`:

```svelte
<script lang="ts">
	import { resolve } from '$app/paths';
	import { modalFocus } from '$lib/actions/modalFocus';
	import type { GalleryProgress } from '$lib/services/gameplay/galleryProgress';

	interface Props {
		progress: readonly GalleryProgress[];
		loading: boolean;
		onClose: () => void;
	}

	let { progress, loading, onClose }: Props = $props();
</script>

<div
	class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
	style="padding-top: max(1rem, env(safe-area-inset-top)); padding-right: max(1rem, env(safe-area-inset-right)); padding-bottom: max(1rem, env(safe-area-inset-bottom)); padding-left: max(1rem, env(safe-area-inset-left));"
>
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Saved progress"
		tabindex="-1"
		use:modalFocus
		onkeydown={(event) => event.key === 'Escape' && onClose()}
		class="flex max-h-[80dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
	>
		<div class="flex items-center justify-between gap-4 border-b border-gray-200 px-6 py-4">
			<h2 class="text-lg font-semibold text-gray-900">SAVED PROGRESS</h2>
			<button
				type="button"
				aria-label="Close saved progress"
				onclick={onClose}
				class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-900"
			>
				CLOSE
			</button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto p-6">
			{#if loading}
				<p role="status" class="text-sm text-gray-600">LOADING SAVES...</p>
			{:else if progress.length === 0}
				<p class="text-sm text-gray-600">NO SAVED PROGRESS</p>
			{:else}
				<ul class="space-y-3">
					{#each progress as item (item.puzzleId)}
						<li
							data-testid={`saved-progress-${item.puzzleId}`}
							class="flex items-center justify-between gap-4 rounded-lg border border-gray-200 p-4"
						>
							<div class="min-w-0">
								<div class="truncate font-medium text-gray-900">{item.name}</div>
								<div class="mt-1 text-sm text-gray-600">
									{item.placedCount}/{item.pieceCount} PLACED
								</div>
							</div>
							<a
								href={resolve(`/puzzle/${item.puzzleId}`)}
								class="shrink-0 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
							>
								CONTINUE
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
```

Do not extract shared dialog chrome in this ticket.

- [ ] **Step 4: Run the dialog test and verify pass**

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

### Task 5: Wire Saved Progress Discovery Into the Gallery

**Files:**
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`

**Interfaces:**
- Consumes from Task 1: `listPersistedSessionPuzzleIds(): string[]`.
- Consumes from Task 2: `discoverAllSavedProgress(options): Promise<GalleryProgress[]>`.
- Consumes from Task 4: `SavedProgressDialog` props `progress`, `loading`, `onClose`.
- Consumes existing API: `fetchPuzzle(id): Promise<Puzzle>`.
- Produces: **VIEW SAVED PROGRESS** and route-local picker state.

- [ ] **Step 1: Extend page mocks and write the one-time mount assertion**

Change the hoisted persistence spies in `page.svelte.test.ts` to:

```ts
const sessionStorageSpies = vi.hoisted(() => ({
	clearSession: vi.fn(),
	listPersistedSessionPuzzleIds: vi.fn((): string[] => [])
}));
```

Change the persistence mock to:

```ts
vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({
		clearSession: sessionStorageSpies.clearSession
	}),
	listPersistedSessionPuzzleIds: sessionStorageSpies.listPersistedSessionPuzzleIds
}));
```

Add `fetchPuzzle: vi.fn()` to the existing `$lib/services/api` mock return object. Change imports and aliases to:

```ts
import { fetchPuzzle, fetchPuzzles, ApiError } from '$lib/services/api';
import {
	discoverAllSavedProgress,
	discoverGalleryProgress
} from '$lib/services/gameplay/galleryProgress';

const mockedFetchPuzzle = vi.mocked(fetchPuzzle);
const mockedDiscoverAllSavedProgress = vi.mocked(discoverAllSavedProgress);
```

Change the gallery-progress module mock to:

```ts
vi.mock('$lib/services/gameplay/galleryProgress', () => ({
	discoverGalleryProgress: vi.fn().mockReturnValue({
		byPuzzleId: new Map(),
		newest: null
	}),
	discoverAllSavedProgress: vi.fn().mockResolvedValue([])
}));
```

Add to `beforeEach()`:

```ts
sessionStorageSpies.listPersistedSessionPuzzleIds.mockReturnValue([]);
mockedDiscoverAllSavedProgress.mockResolvedValue([]);
```

In `reads Quick puzzles once and reuses them when server results change`, assert after initial discovery and again after the search result change:

```ts
expect(sessionStorageSpies.listPersistedSessionPuzzleIds).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Add the failing picker reachability/lazy-load test**

Add:

```ts
it('opens saved progress from persisted ids even when newest progress is not projected', async () => {
	const saved = {
		puzzleId: 'pz-old',
		name: 'Older Save',
		source: 'api' as const,
		placedCount: 1,
		pieceCount: 4,
		lastUpdated: 1_000
	};
	const serverPuzzles = [
		makePuzzle('p-current', { pieceCount: 4, aspectRatio: '1:1', status: 'ready' })
	];

	sessionStorageSpies.listPersistedSessionPuzzleIds.mockReturnValue(['pz-old']);
	mockedFetchPuzzles.mockResolvedValue({
		puzzles: serverPuzzles,
		total: 1,
		offset: 0,
		limit: 20
	});
	mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
	mockedDiscoverAllSavedProgress.mockResolvedValue([saved]);

	render(GalleryPage);

	expect(mockedDiscoverAllSavedProgress).not.toHaveBeenCalled();
	expect(mockedFetchPuzzle).not.toHaveBeenCalled();

	await page.getByRole('button', { name: 'View saved progress' }).click();

	await expect.element(page.getByRole('dialog', { name: 'Saved progress' })).toBeVisible();
	await expect.element(page.getByText('Older Save')).toBeVisible();
	expect(mockedDiscoverAllSavedProgress).toHaveBeenCalledWith({
		puzzleIds: ['pz-old'],
		serverPuzzles,
		quickPuzzles: [],
		fetchPuzzleById: fetchPuzzle,
		sessionStorage: expect.any(Object)
	});

	const main = document.querySelector('main')!;
	expect(main.hasAttribute('inert')).toBe(true);

	await page.getByRole('button', { name: 'Close saved progress' }).click();
	expect(main.hasAttribute('inert')).toBe(false);
});
```

- [ ] **Step 3: Extend the existing confirmed-discard test to refresh mounted save IDs**

Before rendering in `clears and rediscovers progress after confirmed home discard`, add:

```ts
sessionStorageSpies.listPersistedSessionPuzzleIds
	.mockReturnValueOnce(['p1'])
	.mockReturnValue([]);
```

After clicking the dialog's `Discard` button, add:

```ts
expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('p1');
expect(sessionStorageSpies.listPersistedSessionPuzzleIds).toHaveBeenCalledTimes(2);
expect(page.getByRole('button', { name: 'View saved progress' }).query()).toBeNull();
```

- [ ] **Step 4: Run the page test and verify failure**

```bash
cd apps/web
bunx vitest --run --browser src/routes/page.svelte.test.ts
```

Expected: FAIL because the route does not enumerate IDs or render/open the picker.

- [ ] **Step 5: Add imports and route-local state in `+page.svelte`**

Change API, progress, persistence, and component imports to include:

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
	listPersistedSessionPuzzleIds
} from '$lib/services/gameplay/session/persistence';
```

Keep the existing `getThumbnailUrl` import absent because `PuzzleCard` owns thumbnails; do not add it here.

Add beside `quickPuzzles`, `discardTarget`, and `localProgress`:

```ts
let persistedSessionPuzzleIds = $state<string[]>([]);
let savedProgressOpen = $state(false);
let savedProgressLoading = $state(false);
let savedProgressItems = $state<GalleryProgress[]>([]);
let savedProgressRequestId = 0;
```

- [ ] **Step 6: Enumerate IDs once on mount and refresh them after explicit discard**

Replace the existing mount body with:

```ts
onMount(() => {
	quickPuzzles = listQuick();
	persistedSessionPuzzleIds = listPersistedSessionPuzzleIds();
});
```

In `confirmDiscardProgress()`, immediately after `sessionStorageAdapter.clearSession(target.puzzleId);`, add:

```ts
persistedSessionPuzzleIds = listPersistedSessionPuzzleIds();
```

Keep `discardTarget = null` and the existing `discoverGalleryProgress({ serverPuzzles: puzzles, quickPuzzles })` refresh after those lines.

- [ ] **Step 7: Add picker open/close orchestration**

Add below `confirmDiscardProgress()`:

```ts
async function openSavedProgress(): Promise<void> {
	const requestId = ++savedProgressRequestId;
	savedProgressOpen = true;
	savedProgressLoading = true;
	savedProgressItems = [];

	try {
		const progress = await discoverAllSavedProgress({
			puzzleIds: persistedSessionPuzzleIds,
			serverPuzzles: puzzles,
			quickPuzzles,
			fetchPuzzleById: fetchPuzzle,
			sessionStorage: sessionStorageAdapter
		});
		if (requestId !== savedProgressRequestId) return;
		savedProgressItems = progress;
	} finally {
		if (requestId === savedProgressRequestId) savedProgressLoading = false;
	}
}

function closeSavedProgress(): void {
	savedProgressRequestId += 1;
	savedProgressOpen = false;
	savedProgressLoading = false;
}
```

Do not add AbortController or shared async state for this modal.

- [ ] **Step 8: Replace the current-device section with the exact combined markup**

Replace the current `{#if localProgress.newest}` section with:

```svelte
{#if localProgress.newest || persistedSessionPuzzleIds.length > 0}
	<section
		data-testid="continue-on-device"
		aria-labelledby="continue-on-device-title"
		class="mb-8 flex flex-wrap items-center gap-x-6 gap-y-3 border border-(--accent) bg-(--bg-1)
		px-6 py-4 [box-shadow:0_0_25px_var(--accent-glow)]"
	>
		<div class="min-w-40">
			<h2
				id="continue-on-device-title"
				class="text-[0.65rem] font-(--font-mono) tracking-[0.18em] text-(--accent) uppercase"
			>
				Continue on this device
			</h2>
			{#if localProgress.newest}
				<p class="mt-1 truncate text-[0.9rem] font-(--font-display) font-bold text-(--text-0)">
					{localProgress.newest.name}
				</p>
			{:else}
				<p class="mt-1 text-[0.75rem] font-(--font-mono) tracking-[0.08em] text-(--text-1)">
					SAVED PROGRESS AVAILABLE
				</p>
			{/if}
		</div>

		{#if localProgress.newest}
			<span class="text-[0.7rem] font-(--font-mono) tracking-[0.12em] text-(--text-1)">
				{localProgress.newest.placedCount}/{localProgress.newest.pieceCount} PLACED
			</span>
			<a
				href={resolve(`/puzzle/${localProgress.newest.puzzleId}`)}
				class="border border-(--accent) px-5 py-2 text-[0.65rem] font-(--font-display) font-bold
				tracking-[0.2em] text-(--accent) uppercase transition-colors hover:bg-(--accent-glow)"
			>
				CONTINUE
			</a>
			<button
				type="button"
				aria-label="Discard saved progress"
				class="border border-(--border) px-5 py-2 text-[0.65rem] font-(--font-display) font-bold
				tracking-[0.2em] text-(--text-1) uppercase transition-colors hover:bg-(--border)"
				onclick={() => (discardTarget = localProgress.newest)}
			>
				DISCARD
			</button>
		{/if}

		{#if persistedSessionPuzzleIds.length > 0}
			<button
				type="button"
				aria-label="View saved progress"
				class="border border-(--border) px-5 py-2 text-[0.65rem] font-(--font-display) font-bold
				tracking-[0.2em] text-(--text-1) uppercase transition-colors hover:bg-(--border)"
				onclick={openSavedProgress}
			>
				VIEW SAVED PROGRESS
			</button>
		{/if}
	</section>
{/if}
```

- [ ] **Step 9: Make the main page inert for either modal and render the picker outside it**

Change `<main>` to:

```svelte
<main
	inert={discardTarget !== null || savedProgressOpen}
	aria-hidden={discardTarget !== null || savedProgressOpen}
	class="min-h-screen bg-(--bg-0)
[background-image:linear-gradient(rgba(0,240,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.025)_1px,transparent_1px)]
[background-size:48px_48px]"
>
```

After `</main>` and before the existing discard-dialog block, add:

```svelte
{#if savedProgressOpen}
	<SavedProgressDialog
		progress={savedProgressItems}
		loading={savedProgressLoading}
		onClose={closeSavedProgress}
	/>
{/if}
```

Keep `DiscardSessionDialog` as its existing sibling outside `<main>`.

- [ ] **Step 10: Run page, dialog, persistence, and discovery tests**

```bash
cd apps/web
bunx vitest --run --browser \
  src/routes/page.svelte.test.ts \
  src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts \
  src/lib/services/gameplay/galleryProgress.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 5**

```bash
git add apps/web/src/routes/+page.svelte \
  apps/web/src/routes/page.svelte.test.ts
git commit -m "feat(web): open all saved puzzle progress from gallery"
```

---

### Task 6: Prove an Older Off-Page Save Resumes End-to-End

**Files:**
- Modify: `apps/web/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: `mockPuzzleList()`, `getFixture()`, `createFixtureRouter()`, `buildMinimalSeed()`, `createPersistedStateController()`, and the new saved-progress modal.
- Produces: one browser regression proving saved-progress history is independent of the gallery list response.

- [ ] **Step 1: Replace the existing one-save Continue E2E with a two-save scenario**

Replace `shows current-device progress and continues the newest session` with:

```ts
test('continues the newest session and can resume an older off-page save', async ({ page }) => {
	const newestId = 'e2e-square-4';
	const olderId = 'e2e-landscape-12';
	const newest = getFixture(newestId);
	const older = getFixture(olderId);
	const newestPiece = newest.pieces[0];
	const olderPiece = older.pieces[0];

	await mockPuzzleList(page, [
		{
			id: newestId,
			name: 'Newest Save',
			pieceCount: newest.pieceCount,
			aspectRatio: newest.aspectRatio,
			status: 'ready'
		}
	]);
	await createFixtureRouter().install(page);
	await page.goto('/');

	const persisted = createPersistedStateController();
	await persisted.seedValid(page, newestId, {
		...buildMinimalSeed(newestId),
		placedPieces: [
			{
				pieceId: newestPiece.id,
				x: newestPiece.correctX,
				y: newestPiece.correctY
			}
		],
		timerStarted: true,
		hasUserActivity: true,
		lastUpdated: 3_000
	});
	await persisted.seedValid(page, olderId, {
		...buildMinimalSeed(olderId),
		placedPieces: [
			{
				pieceId: olderPiece.id,
				x: olderPiece.correctX,
				y: olderPiece.correctY
			}
		],
		timerStarted: true,
		hasUserActivity: true,
		lastUpdated: 1_000
	});
	await page.reload();

	const current = page.getByTestId('continue-on-device');
	await expect(current).toContainText('Newest Save');
	await expect(current).toContainText('1/4 PLACED');
	await expect(page.getByTestId('puzzle-card')).toContainText('CONTINUE · 1/4 PLACED');

	await current.getByRole('button', { name: 'View saved progress' }).click();
	const dialog = page.getByRole('dialog', { name: 'Saved progress' });
	await expect(dialog.getByText('Newest Save')).toBeVisible();
	await expect(dialog.getByText(older.name)).toBeVisible();
	await expect(dialog.getByTestId(`saved-progress-${olderId}`)).toContainText('1/12 PLACED');

	await dialog
		.getByTestId(`saved-progress-${olderId}`)
		.getByRole('link', { name: 'CONTINUE' })
		.click();
	await expect(page).toHaveURL(new RegExp(`/puzzle/${olderId}$`));
});
```

`createFixtureRouter()` already owns `GET /api/puzzles/e2e-landscape-12`, so no new test endpoint or fixture-harness code is required.

- [ ] **Step 2: Run the gallery E2E and verify pass**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 3: Commit Task 6**

```bash
git add apps/web/e2e/gallery.spec.ts
git commit -m "test(web): cover older saved progress resume"
```

---

### Task 7: Final Verification and PR Readiness

**Files:**
- Verify all HPA-647 production/test files changed in Tasks 1-6.
- Do not create another PR.

**Interfaces:**
- Consumes: completed implementation from Tasks 1-6.
- Produces: evidence that the existing HPA-647 draft PR is ready for review.

- [ ] **Step 1: Run all focused HPA-647 tests together**

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
  src/routes/page.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Svelte/TypeScript checks**

```bash
cd apps/web
bun run check
```

Expected: zero errors.

- [ ] **Step 3: Run formatting and lint checks**

```bash
cd apps/web
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Re-run the focused gallery browser flow after static checks**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 5: Inspect the final diff against the guardrails**

From repository root:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git diff main...HEAD -- \
  apps/web/src/lib/services/gameplay/session/persistence.ts \
  apps/web/src/lib/services/gameplay/galleryProgress.ts \
  apps/web/src/lib/components/PuzzlePiece.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/SavedProgressDialog.svelte \
  apps/web/src/routes/+page.svelte
```

Verify directly from that diff:

- no `PersistedPuzzleSessionV1`, `PuzzleSession`, API-route, database, shared-type, or package contract changed;
- `SessionStorageAdapter` was not widened;
- no per-piece Rotate overlay or `rotate-piece-button` remains;
- the `R` branch remains in `PuzzlePiece`;
- missing server detail is requested only from `discoverAllSavedProgress()`;
- full discovery calls `peekSession()`, never `loadSession()` or `clearSession()`;
- `listQuick()` and `listPersistedSessionPuzzleIds()` are mount/discard-refresh work, not search/pagination reactive work;
- **VIEW SAVED PROGRESS** can render when persisted IDs exist even if `localProgress.newest` is null.

- [ ] **Step 6: Update the existing draft PR for implementation review**

Keep the same HPA-647 branch and PR. Update its body from plan-only status to summarize the shipped behavior and the verification commands above; do not open a replacement or follow-up PR.