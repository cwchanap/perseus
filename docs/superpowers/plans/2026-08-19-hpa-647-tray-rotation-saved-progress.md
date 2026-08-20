# HPA-647 Tray Rotation and Saved Progress Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the tray-piece rotate overlay, preserve rotation through the selected-piece inventory action and `R` shortcut, and add a current-device saved-progress picker that can resume valid saves outside the currently loaded gallery results.

**Architecture:** Keep `PuzzleSession` and the current persistence schema unchanged. Add one small persistence key-enumeration helper, extend `galleryProgress.ts` with lazy full-save discovery using existing Quick/gallery metadata plus `fetchPuzzle(id)` for missing server metadata, move the pointer/touch rotate action into `PuzzleInventoryPanel`, and compose one concrete modal from the gallery route.

**Tech Stack:** Svelte 5 / SvelteKit, TypeScript, browser `localStorage`, Vitest Browser Mode, Playwright, existing `modalFocus`, existing Perseus gameplay persistence and E2E fixtures.

**Spec:** `docs/superpowers/specs/2026-08-19-hpa-647-tray-rotation-saved-progress-design.md`

## Global Constraints

- Deliver HPA-647 as one implementation PR; task commits below are checkpoints inside that PR, not separate PRs.
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
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts` — cover selected header Rotate visibility/callback/collapsed state.
- `apps/web/src/routes/+page.svelte` — mount-time save IDs, picker open/load/close state, current-device section composition, inert handling, and discard refresh.
- `apps/web/src/routes/page.svelte.test.ts` — cover one-time key scan, picker reachability without `newest`, lazy full discovery, inert state, and discard refresh.
- `apps/web/e2e/gallery.spec.ts` — prove an older save omitted from loaded gallery summaries is still resumable through the modal.

### New files

- `apps/web/src/lib/components/SavedProgressDialog.svelte` — one concrete modal for loading/empty/list states and Continue links.
- `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts` — modal behavior and navigation markup.

No other production file should be needed.

---

### Task 1: Enumerate Perseus-Owned Session IDs

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts` — storage adapter section around `PROGRESS_KEY_PREFIX` and `createSessionStorageAdapter()`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts` — current-schema persistence tests

**Interfaces:**
- Consumes: the existing private `PROGRESS_KEY_PREFIX = 'puzzle-progress-'` and DOM `Storage` contract.
- Produces: `listPersistedSessionPuzzleIds(storage?: Storage): string[]`.
- Does **not** change: `SessionStorageAdapter` in `session/types.ts`.

- [ ] **Step 1: Write failing key-enumeration tests**

Add the new export to the existing persistence import list and add this focused describe block after the storage-adapter tests:

```ts
import {
	serializeSession,
	loadPersistedSession,
	isResumable,
	createSessionStorageAdapter,
	listPersistedSessionPuzzleIds,
	noopThrowingStorage
} from './persistence';

// ...existing tests...

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

The first assertion intentionally follows the deterministic insertion order provided by the existing `memoryStorage()` test helper. Production ordering does not carry UX meaning because Task 2 sorts validated rows by `lastUpdated`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts
```

Expected: FAIL because `listPersistedSessionPuzzleIds` is not exported.

- [ ] **Step 3: Implement the minimal storage resolver and key scan**

In `persistence.ts`, keep the prefix private and add one private resolver so the adapter and new helper use the same fallback:

```ts
const PROGRESS_KEY_PREFIX = 'puzzle-progress-';

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

Then replace the duplicated storage selection at the top of `createSessionStorageAdapter()`:

```ts
export function createSessionStorageAdapter(options?: {
	storage?: Storage;
	onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter {
	const storage = resolveSessionStorage(options?.storage);
	const onError = options?.onError;
	// existing adapter body unchanged
```

Do not export `PROGRESS_KEY_PREFIX`; callers need IDs, not key-format knowledge.

- [ ] **Step 4: Run the persistence tests and verify pass**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts src/lib/services/gameplay/session/persistence.validation-storage.test.ts src/lib/services/gameplay/session/persistence.fallback-storage.test.ts
```

Expected: PASS. Existing adapter fallback/error behavior remains green.

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
- Consumes: `GalleryProgress`, `SessionStorageAdapter.peekSession()`, `SessionStorageAdapter.isResumable()`, `PuzzleSummary`, `StoredQuickPuzzle`, `Puzzle`, and injected `fetchPuzzleById`.
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

- Keeps `discoverGalleryProgress()` and `GalleryProgressDiscovery` unchanged for existing gallery callers.

- [ ] **Step 1: Add failing full-discovery tests**

Update the test imports:

```ts
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
import { discoverAllSavedProgress, discoverGalleryProgress } from './galleryProgress';
```

Add a helper that projects the existing canonical 2x2 coordinates into a full fetched puzzle:

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

Add the core behavior test:

```ts
describe('discoverAllSavedProgress', () => {
	it('includes loaded, fetched, and Quick saves and sorts newest first', async () => {
		const base = validSnapshot();
		const quickSnapshot: PersistedPuzzleSessionV1 = {
			...base,
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 2_000
		};
		const fetchedSnapshot: PersistedPuzzleSessionV1 = {
			...base,
			puzzleId: 'pz-old',
			lastUpdated: 3_000
		};
		const loadedSnapshot: PersistedPuzzleSessionV1 = {
			...base,
			puzzleId: 'pz-loaded',
			lastUpdated: 1_000
		};
		const store = memoryStorage({
			'puzzle-progress-pz-loaded': JSON.stringify(loadedSnapshot),
			'puzzle-progress-pz-old': JSON.stringify(fetchedSnapshot),
			'puzzle-progress-q-test': JSON.stringify(quickSnapshot)
		});
		const fetchPuzzleById = vi.fn(async (id: string) => fetchedServerPuzzle(id, 'Fetched Save'));

		const progress = await discoverAllSavedProgress({
			puzzleIds: ['pz-loaded', 'pz-old', 'q-test'],
			serverPuzzles: [
				serverPuzzle('pz-loaded', 4, '1:1', { name: 'Loaded Save' })
			],
			quickPuzzles: [quickPuzzle()],
			fetchPuzzleById,
			sessionStorage: createSessionStorageAdapter({ storage: store })
		});

		expect(progress.map((item) => item.puzzleId)).toEqual(['pz-old', 'q-test', 'pz-loaded']);
		expect(fetchPuzzleById).toHaveBeenCalledTimes(1);
		expect(fetchPuzzleById).toHaveBeenCalledWith('pz-old');
	});

	it('skips unresolved metadata and non-resumable saves without deleting them', async () => {
		const completed = {
			...validSnapshot(),
			puzzleId: 'pz-complete',
			lifecycle: 'completed' as const,
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

Also add a tie-order assertion in the first test or a separate small test: two valid snapshots with equal `lastUpdated` must sort by `puzzleId` ascending.

- [ ] **Step 2: Run the service test and verify failure**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/galleryProgress.test.ts
```

Expected: FAIL because `discoverAllSavedProgress` does not exist.

- [ ] **Step 3: Extract one candidate projection helper**

In `galleryProgress.ts`, import `Puzzle` in addition to `PuzzleSummary`:

```ts
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
```

Add a helper used by both discovery paths:

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

Replace the duplicated `peekSession()`/projection block inside `discoverGalleryProgress()` with this helper while preserving its existing rule that only API progress populates `byPuzzleId`.

- [ ] **Step 4: Add a candidate builder for fetched server detail**

Use the canonical grid and piece coordinates returned by `fetchPuzzle(id)`:

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

Do not add a second persisted-session validator here; `peekSession()` remains the codec gate.

- [ ] **Step 5: Implement `discoverAllSavedProgress()`**

Add the async function below `discoverGalleryProgress()`:

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

Do not call `loadSession()` or `clearSession()` anywhere in this path.

- [ ] **Step 6: Run service tests and verify pass**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/galleryProgress.test.ts src/lib/services/gameplay/session/persistence.test.ts
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
- Consumes: existing `PuzzlePiece` props `rotationEnabled`, `rotation`, `onRotate`, and existing inventory props `selectedPieceId`, `rotationEnabled`, `onRotate`.
- Produces: inventory header button with `aria-label="Rotate selected piece"` and visible text `ROTATE`.
- Keeps: `PuzzlePiece.onRotate?: (pieceId: number) => void` because the root `R` shortcut still uses it.

- [ ] **Step 1: Rewrite failing `PuzzlePiece` rotation-control tests around the new contract**

In `PuzzlePiece.svelte.test.ts`, delete tests whose required behavior is the old child Rotate button:

- `renders a rotate control when rotation is enabled for an unplaced piece`
- `calls onRotate when the rotate control is clicked`
- `keeps the rotate control outside the piece interactive element`
- `rotates without selecting the piece`
- the Rotate-button tabindex assertion inside the orientation test

Replace them with:

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

Keep the existing test that dispatches lowercase and uppercase `R` and expects `onRotate(7)` twice. Update the orientation test to assert only the root accessible name and `aria-keyshortcuts`:

```ts
await expect
	.element(page.getByTestId('puzzle-piece'))
	.toHaveAttribute('aria-label', 'Puzzle piece 7, rotated 90 degrees');
await expect
	.element(page.getByTestId('puzzle-piece'))
	.toHaveAttribute('aria-keyshortcuts', 'R');
```

- [ ] **Step 2: Add failing inventory header Rotate tests**

In `PuzzleInventoryPanel.svelte.test.ts`, replace the child-button click in `forwards select, rotate, and cancel selection` with selection/cancel coverage only, then add:

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

Also update any roving-focus assertion that counts the active piece's child Rotate button: after this task, the repeated inventory composite has one piece-root tab stop, not a piece root plus child Rotate control.

- [ ] **Step 3: Run component tests and verify failure**

Run:

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL because the old overlay still renders and the inventory header lacks the new action.

- [ ] **Step 4: Remove the `PuzzlePiece` child Rotate button without touching root `R` handling**

Delete these functions from `PuzzlePiece.svelte`:

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

Delete the entire child block:

```svelte
{#if rotationEnabled && !isPlaced}
	<button
		type="button"
		...
		data-testid="rotate-piece-button"
	>
		↻
	</button>
{/if}
```

Keep `handleKeyDown()` unchanged for:

```ts
if (rotationEnabled && (event.key === 'r' || event.key === 'R')) {
	event.preventDefault();
	onRotate?.(piece.id);
	return;
}
```

Update the `tabIndex` comment so it describes only the piece root; remove wording about the active piece's Rotate button sharing the roving index.

- [ ] **Step 5: Add the inventory header action and simplify tray keydown**

In `PuzzleInventoryPanel.svelte`, add this before the existing `CANCEL` button in `.panel-actions`:

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

In `handlePiecesKeyDown()`, delete the old child-control exception:

```ts
if (target.closest('[data-testid="rotate-piece-button"]')) return;
```

and delete its explanatory comments. Left/Right traversal now always resolves from the focused piece slot/root.

Update the HPA-223 roving comment near `activePieceId` from “active piece + Rotate button” to one active piece root.

- [ ] **Step 6: Run component tests and verify pass**

Run:

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: PASS. The piece image has no overlaid button; `R` remains functional; selected pointer/touch rotation is available in the header.

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
- Consumes: `GalleryProgress` from `$lib/services/gameplay/galleryProgress`, `$app/paths.resolve`, and `$lib/actions/modalFocus`.
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

- [ ] **Step 1: Write the failing dialog component tests**

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

	it('renders supplied rows and existing puzzle links in order', async () => {
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

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts
```

Expected: FAIL because `SavedProgressDialog.svelte` does not exist.

- [ ] **Step 3: Implement the dialog using the existing modal pattern**

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
	class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4"
>
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Saved progress"
		tabindex="-1"
		use:modalFocus
		onkeydown={(event) => event.key === 'Escape' && onClose()}
		class="flex max-h-[min(80dvh,40rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
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

Use the same safe-area padding style as `DiscardSessionDialog.svelte` if required by the repo formatter/current mobile dialog convention; do not extract shared dialog chrome in this ticket.

- [ ] **Step 4: Run the dialog test and verify pass**

Run:

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
- Produces: **VIEW SAVED PROGRESS** button and route-local modal state.

- [ ] **Step 1: Extend page mocks and add failing one-time mount tests**

In `page.svelte.test.ts`, expand the hoisted persistence spies:

```ts
const sessionStorageSpies = vi.hoisted(() => ({
	clearSession: vi.fn(),
	listPersistedSessionPuzzleIds: vi.fn((): string[] => [])
}));
```

Update the persistence mock:

```ts
vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({
		clearSession: sessionStorageSpies.clearSession
	}),
	listPersistedSessionPuzzleIds: sessionStorageSpies.listPersistedSessionPuzzleIds
}));
```

Extend API and progress mocks:

```ts
vi.mock('$lib/services/api', () => {
	// existing MockApiError
	return {
		fetchPuzzles: vi.fn().mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 }),
		fetchPuzzle: vi.fn(),
		getThumbnailUrl: vi.fn((id: string) => `/api/puzzles/${id}/thumbnail`),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/gameplay/galleryProgress', () => ({
	discoverGalleryProgress: vi.fn().mockReturnValue({
		byPuzzleId: new Map(),
		newest: null
	}),
	discoverAllSavedProgress: vi.fn().mockResolvedValue([])
}));
```

Import and alias the new mocks:

```ts
import { fetchPuzzle, fetchPuzzles, ApiError } from '$lib/services/api';
import {
	discoverAllSavedProgress,
	discoverGalleryProgress
} from '$lib/services/gameplay/galleryProgress';

const mockedFetchPuzzle = vi.mocked(fetchPuzzle);
const mockedDiscoverAllSavedProgress = vi.mocked(discoverAllSavedProgress);
```

In `beforeEach`, reset:

```ts
sessionStorageSpies.listPersistedSessionPuzzleIds.mockReturnValue([]);
mockedDiscoverAllSavedProgress.mockResolvedValue([]);
```

Extend the existing `reads Quick puzzles once...` test to assert:

```ts
expect(sessionStorageSpies.listPersistedSessionPuzzleIds).toHaveBeenCalledTimes(1);
```

both before and after the search result changes.

- [ ] **Step 2: Add failing picker reachability/lazy-load test**

Add:

```ts
it('opens saved progress from persisted ids even when newest progress is not currently projected', async () => {
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

The page test asserts no page-level eager full discovery. Task 2 separately proves the injected `fetchPuzzleById` is invoked only for missing server metadata once discovery runs.

- [ ] **Step 3: Add a failing discard refresh test**

Update the existing confirmed home-discard test so the mounted key list initially contains `p1`, then returns empty after clear:

```ts
sessionStorageSpies.listPersistedSessionPuzzleIds
	.mockReturnValueOnce(['p1'])
	.mockReturnValue([]);
```

After clicking Discard, assert:

```ts
expect(sessionStorageSpies.clearSession).toHaveBeenCalledWith('p1');
expect(sessionStorageSpies.listPersistedSessionPuzzleIds).toHaveBeenCalledTimes(2);
expect(page.getByRole('button', { name: 'View saved progress' }).query()).toBeNull();
```

- [ ] **Step 4: Run the page test and verify failure**

Run:

```bash
cd apps/web
bunx vitest --run --browser src/routes/page.svelte.test.ts
```

Expected: FAIL because the route does not yet enumerate IDs or render/open the picker.

- [ ] **Step 5: Add route imports and state**

In `+page.svelte`, extend imports:

```ts
import { fetchPuzzle, fetchPuzzles, getThumbnailUrl, ApiError } from '$lib/services/api';
import {
	discoverAllSavedProgress,
	discoverGalleryProgress,
	type GalleryProgress
} from '$lib/services/gameplay/galleryProgress';
import {
	createSessionStorageAdapter,
	listPersistedSessionPuzzleIds
} from '$lib/services/gameplay/session/persistence';
import SavedProgressDialog from '$lib/components/SavedProgressDialog.svelte';
```

Add route-local state beside `quickPuzzles` / `localProgress` / discard state:

```ts
let persistedSessionPuzzleIds = $state<string[]>([]);
let savedProgressOpen = $state(false);
let savedProgressLoading = $state(false);
let savedProgressItems = $state<GalleryProgress[]>([]);
let savedProgressRequestId = 0;
```

Keep `localProgress`'s existing `{ byPuzzleId: new Map(), newest: null }` shape unchanged.

- [ ] **Step 6: Enumerate IDs once on mount and refresh them only after explicit discard**

Extend the existing `onMount` body that calls `listQuick()`:

```ts
onMount(() => {
	quickPuzzles = listQuick();
	persistedSessionPuzzleIds = listPersistedSessionPuzzleIds();
	// existing mount work remains
});
```

Do not put `listPersistedSessionPuzzleIds()` in the reactive progress effect.

After `sessionStorageAdapter.clearSession(discardTarget.puzzleId)` succeeds in the existing home discard confirmation handler, add:

```ts
persistedSessionPuzzleIds = listPersistedSessionPuzzleIds();
```

then keep the existing `discoverGalleryProgress()` refresh logic.

- [ ] **Step 7: Add minimal picker open/close orchestration**

Add:

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

The local revision is presentation-only. It prevents a slow first open from overwriting a later open/close cycle; do not add cancellation infrastructure or a shared async controller.

- [ ] **Step 8: Compose the current-device section and modal**

Change the section condition from newest-only to either newest progress or any app-owned save key:

```svelte
{#if localProgress.newest || persistedSessionPuzzleIds.length > 0}
	<section data-testid="continue-on-device" class="...existing classes...">
		<div>
			<h2>CONTINUE ON THIS DEVICE</h2>
			{#if localProgress.newest}
				<!-- keep existing newest name + placed/total copy -->
			{:else}
				<p>SAVED PROGRESS AVAILABLE</p>
			{/if}
		</div>

		<div class="...existing action layout...">
			{#if localProgress.newest}
				<!-- keep existing CONTINUE and DISCARD controls unchanged -->
			{/if}
			{#if persistedSessionPuzzleIds.length > 0}
				<button
					type="button"
					aria-label="View saved progress"
					onclick={openSavedProgress}
					class="...reuse the existing small secondary action treatment..."
				>
					VIEW SAVED PROGRESS
				</button>
			{/if}
		</div>
	</section>
{/if}
```

Do not introduce new shared button CSS. Reuse the current Continue/Discard panel's local utility classes/tokens.

Expand the main inert predicate:

```svelte
<main
	inert={discardTarget !== null || savedProgressOpen}
	aria-hidden={discardTarget !== null || savedProgressOpen ? 'true' : undefined}
>
```

Render the new dialog as a sibling outside `<main>`, beside the existing discard dialog:

```svelte
{#if savedProgressOpen}
	<SavedProgressDialog
		progress={savedProgressItems}
		loading={savedProgressLoading}
		onClose={closeSavedProgress}
	/>
{/if}
```

- [ ] **Step 9: Run page + dialog + service tests and verify pass**

Run:

```bash
cd apps/web
bunx vitest --run --browser \
  src/routes/page.svelte.test.ts \
  src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts \
  src/lib/services/gameplay/galleryProgress.test.ts \
  src/lib/services/gameplay/session/persistence.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 5**

```bash
git add apps/web/src/routes/+page.svelte \
  apps/web/src/routes/page.svelte.test.ts
git commit -m "feat(web): open all saved puzzle progress from gallery"
```

---

### Task 6: Prove Older Off-Page Saves Resume End-to-End and Run Final Verification

**Files:**
- Modify: `apps/web/e2e/gallery.spec.ts`
- Verify all HPA-647 files from Tasks 1-5

**Interfaces:**
- Consumes: existing `getFixture()`, `createFixtureRouter()`, `buildMinimalSeed()`, `createPersistedStateController()`, gallery list interception, and new **VIEW SAVED PROGRESS** UI.
- Produces: one regression test proving the older save does not need to be in the current gallery summary list.

- [ ] **Step 1: Replace/extend the existing one-save Continue E2E with a two-save scenario**

Keep the current newest Continue assertions, but seed a second fixture that is deliberately omitted from the gallery list response:

```ts
test('continues the newest session and can resume an older off-page save', async ({ page }) => {
	const newestId = 'e2e-square-4';
	const olderId = 'e2e-landscape-12';
	const newest = getFixture(newestId);
	const older = getFixture(olderId);

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
				pieceId: newest.pieces[0].id,
				x: newest.pieces[0].correctX,
				y: newest.pieces[0].correctY
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
				pieceId: older.pieces[0].id,
				x: older.pieces[0].correctX,
				y: older.pieces[0].correctY
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

`createFixtureRouter()` already fulfills `GET /api/puzzles/e2e-landscape-12` with canonical metadata, so the older save proves Task 2's missing-summary `fetchPuzzle(id)` path without adding another mock endpoint.

If `createPersistedStateController()` is intended to be instantiated per seed rather than reused, create two controllers; do not modify the fixture harness for this ticket.

- [ ] **Step 2: Run the gallery E2E and verify pass**

Run:

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS. The older fixture is absent from the gallery list but appears after the picker resolves its detail endpoint.

- [ ] **Step 3: Run all focused HPA-647 tests together**

Run:

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

- [ ] **Step 4: Run type/Svelte checks**

Run:

```bash
cd apps/web
bun run check
```

Expected: zero Svelte/TypeScript errors.

- [ ] **Step 5: Run formatting and lint checks**

Run:

```bash
cd apps/web
bun run lint
```

Expected: PASS with no Prettier or ESLint errors.

- [ ] **Step 6: Review the final diff against the spec guardrails**

Run:

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

Confirm from the diff:

- there is no `PersistedPuzzleSessionV1`, `PuzzleSession`, API route, database, or shared-type contract change;
- `SessionStorageAdapter` was not widened;
- no package/dependency file changed;
- no per-piece Rotate overlay remains;
- the `R` shortcut remains in `PuzzlePiece`;
- missing server detail is requested only inside `discoverAllSavedProgress()`;
- passive discovery calls `peekSession()`, never `loadSession()`/`clearSession()`;
- `listQuick()` and `listPersistedSessionPuzzleIds()` live only in mount/discard refresh paths, not reactive search/pagination effects;
- the picker is reachable with persisted IDs even if `localProgress.newest` is null.

- [ ] **Step 7: Commit the E2E/verification slice**

```bash
git add apps/web/e2e/gallery.spec.ts
git commit -m "test(web): cover older saved progress resume"
```

The implementation branch is then ready for the single HPA-647 implementation PR.