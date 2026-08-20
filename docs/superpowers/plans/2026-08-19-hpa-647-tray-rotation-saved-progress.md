# HPA-647 Tray Rotation and Saved Progress Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the tray-piece Rotate overlay, keep pointer/touch and keyboard rotation usable, retain the latest Continue row across gallery filtering, and add a lazy picker for older valid current-device saves.

**Architecture:** Keep `PuzzleSession` and `PersistedPuzzleSessionV1` unchanged. Persistence owns a cheap geometry-free resumable-candidate probe; `galleryProgress.ts` owns lazy full validation/resolution; the inventory header owns the selected-piece Rotate action; the gallery owns only retained latest-row state plus one concrete saved-progress modal.

**Tech Stack:** Svelte 5 / SvelteKit, TypeScript, browser `localStorage`, Vitest Browser Mode, Playwright, existing `modalFocus`, existing Perseus gameplay persistence and deterministic E2E fixtures.

**Spec:** `docs/superpowers/specs/2026-08-19-hpa-647-tray-rotation-saved-progress-design.md`

## Global Constraints

- Deliver HPA-647 through this single draft PR and branch; do not open a second implementation PR.
- Do not change `PuzzleSession`, result-class rules, shared API contracts, database code, or `PersistedPuzzleSessionV1`.
- Do not add dependencies, a save index/schema, global progress store, batch API endpoint, saved-progress route, or generic modal/list framework.
- Keep the existing newest Continue and newest-session Discard product behavior.
- Keep visible-card progress query-coupled, but do not let search/category changes erase a retained latest Continue row.
- Run `listQuick()` and `listResumableSessionCandidateIds()` once per gallery mount; search/filter/pagination must not rerun them.
- The mount probe may parse only enough local JSON to check current schema, key/puzzle-ID match, lifecycle, seal, and activity; no geometry or network validation at mount.
- Do not request missing server puzzle detail until **VIEW SAVED PROGRESS** opens.
- Full discovery is read-only: use `peekSession()` and never `loadSession()`/`clearSession()`.
- If authoritative picker discovery publishes zero rows, clear the in-memory candidate IDs for the current page lifetime so the empty affordance does not persist.
- Remove the per-piece Rotate overlay completely; focused-piece `R` remains.
- Header ROTATE is visible whenever rotation mode is enabled and disabled until a piece is selected.
- Keep the current gallery newest-session E2E untouched; add a second picker E2E.

---

## File Structure

### Production files

- `apps/web/src/lib/services/gameplay/session/persistence.ts` — factor resumable-state predicate and add current-schema candidate ID probe.
- `apps/web/src/lib/services/gameplay/galleryProgress.ts` — extract shared explicit geometry validation and add lazy full-save discovery.
- `apps/web/src/lib/components/PuzzlePiece.svelte` — remove visual Rotate child control only.
- `apps/web/src/lib/components/PuzzleInventoryPanel.svelte` — visible/disabled selected-piece ROTATE action and simpler roving logic.
- `apps/web/src/lib/components/SavedProgressDialog.svelte` — one concrete accessible modal.
- `apps/web/src/routes/+page.svelte` — retained latest Continue, query-coupled card map, candidate visibility, picker request fencing.

### Test files

- `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts`
- `apps/web/src/routes/page.svelte.test.ts`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/e2e/gallery.spec.ts`

No API, database, shared-type, session-engine, package, or migration file should change.

---

### Task 1: Probe Only Plausibly Resumable Perseus Session Keys

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`

**Interfaces:**

```ts
export function listResumableSessionCandidateIds(storage?: Storage): string[];
```

`SessionStorageAdapter` remains unchanged.

- [ ] **Step 1: Write failing candidate-probe tests**

Extend the persistence import:

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
	it('returns only current-schema active/paused sessions with activity and no seal', () => {
		const active = validSnapshot();
		const paused = { ...validSnapshot(), puzzleId: 'paused', lifecycle: 'paused' as const };
		const completed = {
			...validSnapshot(),
			puzzleId: 'complete',
			lifecycle: 'completed' as const,
			placedPieces: fullBoardPlacements(),
			sealedCompletion: seal()
		};
		const noActivity = {
			...validSnapshot(),
			puzzleId: 'idle',
			placedPieces: [],
			timerStarted: false,
			hasUserActivity: false
		};
		const sealed = { ...validSnapshot(), puzzleId: 'sealed', sealedCompletion: seal() };
		const storage = memoryStorage({
			'puzzle-progress-pz1': JSON.stringify(active),
			'puzzle-progress-paused': JSON.stringify(paused),
			'puzzle-progress-complete': JSON.stringify(completed),
			'puzzle-progress-idle': JSON.stringify(noActivity),
			'puzzle-progress-sealed': JSON.stringify(sealed)
		});

		expect(listResumableSessionCandidateIds(storage)).toEqual(['pz1', 'paused']);
	});

	it('ignores malformed, old-schema, mismatched, empty, and unrelated keys', () => {
		const storage = memoryStorage({
			'puzzle-progress-bad-json': '{',
			'puzzle-progress-old': JSON.stringify({ ...validSnapshot(), puzzleId: 'old', schemaVersion: 999 }),
			'puzzle-progress-key-id': JSON.stringify({ ...validSnapshot(), puzzleId: 'other-id' }),
			'puzzle-progress-': JSON.stringify(validSnapshot()),
			'unrelated-setting': '1'
		});

		expect(listResumableSessionCandidateIds(storage)).toEqual([]);
	});

	it('returns an empty list when storage enumeration/read is unavailable', () => {
		const blocked = {
			get length() {
				throw new Error('blocked');
			},
			key: () => null,
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {}
		} satisfies Storage;

		expect(listResumableSessionCandidateIds(blocked)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the focused test and observe RED**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/session/persistence.test.ts
```

Expected: FAIL because `listResumableSessionCandidateIds` does not exist.

- [ ] **Step 3: Factor the geometry-free resumability predicate**

Keep the public typed `isResumable()` but factor its state test:

```ts
function hasResumableSessionState(record: Record<string, unknown>): boolean {
	return (
		(record.lifecycle === 'active' || record.lifecycle === 'paused') &&
		record.sealedCompletion === null &&
		record.hasUserActivity === true
	);
}

export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean {
	return hasResumableSessionState(snapshot as unknown as Record<string, unknown>);
}
```

Do not add geometry/schema validation to this helper.

- [ ] **Step 4: Implement namespace candidate enumeration beside `PROGRESS_KEY_PREFIX`**

Reuse one storage resolver for adapter + probe:

```ts
function resolveSessionStorage(storage?: Storage): Storage {
	return (
		storage ??
		(typeof localStorage !== 'undefined' ? localStorage : undefined) ??
		noopThrowingStorage
	);
}

export function listResumableSessionCandidateIds(storage?: Storage): string[] {
	const resolved = resolveSessionStorage(storage);
	const ids = new Set<string>();

	try {
		for (let index = 0; index < resolved.length; index += 1) {
			const key = resolved.key(index);
			if (!key?.startsWith(PROGRESS_KEY_PREFIX)) continue;
			const puzzleId = key.slice(PROGRESS_KEY_PREFIX.length);
			if (!puzzleId) continue;

			const raw = resolved.getItem(key);
			if (raw === null) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
			const record = parsed as Record<string, unknown>;
			if (record.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) continue;
			if (record.puzzleId !== puzzleId) continue;
			if (hasResumableSessionState(record)) ids.add(puzzleId);
		}
	} catch {
		return [];
	}

	return [...ids];
}
```

At the start of `createSessionStorageAdapter()`, replace the duplicated fallback expression with:

```ts
const storage = resolveSessionStorage(options?.storage);
```

- [ ] **Step 5: Run persistence coverage GREEN**

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

### Task 2: Add Lazy Authoritative Saved-Progress Discovery

**Files:**
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.ts`
- Modify: `apps/web/src/lib/services/gameplay/galleryProgress.test.ts`

**Interfaces:**

```ts
export async function discoverAllSavedProgress(options: {
	puzzleIds: readonly string[];
	serverPuzzles: readonly PuzzleSummary[];
	quickPuzzles: readonly StoredQuickPuzzle[];
	fetchPuzzleById: (puzzleId: string) => Promise<Puzzle>;
	sessionStorage?: SessionStorageAdapter;
}): Promise<GalleryProgress[]>;
```

Keep `discoverGalleryProgress()` unchanged externally.

- [ ] **Step 1: Write failing full-discovery tests**

Update imports:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Puzzle, PuzzleSummary } from '$lib/types/puzzle';
import { discoverAllSavedProgress, discoverGalleryProgress } from './galleryProgress';
```

Add a valid fetched detail helper:

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

Add tests covering loaded summary + fetched detail + Quick, fetch avoidance for loaded summaries, failed detail, missing Quick metadata, completed session preservation, malformed duplicate/out-of-bounds fetched pieces, and deterministic ordering. Core test:

```ts
it('includes loaded, fetched, and Quick saves newest first', async () => {
	const base = validSnapshot();
	const store = memoryStorage({
		'puzzle-progress-loaded': JSON.stringify({ ...base, puzzleId: 'loaded', lastUpdated: 1_000 }),
		'puzzle-progress-old': JSON.stringify({ ...base, puzzleId: 'old', lastUpdated: 3_000 }),
		'puzzle-progress-q-test': JSON.stringify({
			...base,
			puzzleId: 'q-test',
			source: 'local',
			lastUpdated: 2_000
		})
	});
	const fetchPuzzleById = vi.fn(async (id: string) => fetchedServerPuzzle(id, 'Fetched Save'));

	const rows = await discoverAllSavedProgress({
		puzzleIds: ['loaded', 'old', 'q-test'],
		serverPuzzles: [serverPuzzle('loaded', 4, '1:1', { name: 'Loaded Save' })],
		quickPuzzles: [quickPuzzle()],
		fetchPuzzleById,
		sessionStorage: createSessionStorageAdapter({ storage: store })
	});

	expect(rows.map((row) => row.puzzleId)).toEqual(['old', 'q-test', 'loaded']);
	expect(fetchPuzzleById).toHaveBeenCalledTimes(1);
	expect(fetchPuzzleById).toHaveBeenCalledWith('old');
});
```

- [ ] **Step 2: Run service test and observe RED**

```bash
cd apps/web
bunx vitest --run --browser src/lib/services/gameplay/galleryProgress.test.ts
```

Expected: FAIL because `discoverAllSavedProgress` does not exist.

- [ ] **Step 3: Extract one explicit piece-context validator**

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
	pieces: readonly unknown[];
}): SessionValidationContext | null {
	if (!input.puzzleId) return null;
	if (!Number.isInteger(input.pieceCount) || input.pieceCount <= 0) return null;
	if (!Number.isInteger(input.gridCols) || input.gridCols <= 0) return null;
	if (!Number.isInteger(input.gridRows) || input.gridRows <= 0) return null;
	if (input.gridCols * input.gridRows !== input.pieceCount) return null;
	if (!Array.isArray(input.pieces) || input.pieces.length !== input.pieceCount) return null;

	const pieces: Array<{ id: number; correctX: number; correctY: number }> = [];
	const ids = new Set<number>();
	const cells = new Set<string>();
	for (const rawPiece of input.pieces) {
		if (!rawPiece || typeof rawPiece !== 'object') return null;
		const { id, correctX, correctY } = rawPiece as Record<string, unknown>;
		if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= input.pieceCount) return null;
		if (ids.has(id)) return null;
		if (typeof correctX !== 'number' || !Number.isInteger(correctX) || correctX < 0 || correctX >= input.gridCols) return null;
		if (typeof correctY !== 'number' || !Number.isInteger(correctY) || correctY < 0 || correctY >= input.gridRows) return null;
		const cell = `${correctX},${correctY}`;
		if (cells.has(cell)) return null;
		ids.add(id);
		cells.add(cell);
		pieces.push({ id, correctX, correctY });
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

Do not add a runtime `source` check: both callers supply typed literals.

Refactor `quickValidationContext()` to keep its `q-` guard, then delegate to this helper with `source: 'local'`. Fetched `Puzzle` detail delegates with `source: 'api'`. Leave row-major `serverValidationContext()` unchanged.

- [ ] **Step 4: Extract candidate-to-progress projection**

```ts
function progressFromCandidate(
	candidate: GalleryCandidate,
	sessionStorage: SessionStorageAdapter
): GalleryProgress | null {
	const result = sessionStorage.peekSession(candidate.puzzleId, candidate.context);
	if (result.status !== 'loaded' || !sessionStorage.isResumable(result.snapshot)) return null;
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

Use it inside existing `discoverGalleryProgress()` without changing its `byPuzzleId`/`newest` contract.

- [ ] **Step 5: Implement `discoverAllSavedProgress()`**

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

	const candidates = await Promise.all(
		[...new Set(options.puzzleIds)].map(async (puzzleId): Promise<GalleryCandidate | null> => {
			if (puzzleId.startsWith(QUICK_PUZZLE_ID_PREFIX)) {
				const puzzle = quickById.get(puzzleId);
				if (!puzzle) return null;
				const context = quickValidationContext(puzzle);
				return context
					? { puzzleId, name: puzzle.name, source: 'local', pieceCount: puzzle.pieceCount, context }
					: null;
			}

			const summary = serverById.get(puzzleId);
			if (summary) {
				const context = serverValidationContext(summary);
				return context
					? { puzzleId, name: summary.name, source: 'api', pieceCount: summary.pieceCount, context }
					: null;
			}

			try {
				const puzzle = await options.fetchPuzzleById(puzzleId);
				if (puzzle.id !== puzzleId) return null;
				const context = explicitValidationContext({
					puzzleId: puzzle.id,
					source: 'api',
					pieceCount: puzzle.pieceCount,
					gridCols: puzzle.gridCols,
					gridRows: puzzle.gridRows,
					pieces: puzzle.pieces
				});
				return context
					? { puzzleId, name: puzzle.name, source: 'api', pieceCount: puzzle.pieceCount, context }
					: null;
			} catch {
				return null;
			}
		})
	);

	return candidates
		.flatMap((candidate) => {
			if (!candidate) return [];
			const row = progressFromCandidate(candidate, sessionStorage);
			return row ? [row] : [];
		})
		.sort((a, b) => b.lastUpdated - a.lastUpdated || a.puzzleId.localeCompare(b.puzzleId));
}
```

`fetchPuzzle()` already rejects non-ready/deleted server puzzles, so do not invent a `status` check for fetched `Puzzle`.

- [ ] **Step 6: Run service tests GREEN**

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

### Task 3: Move Pointer Rotation Into a Discoverable Inventory Header Action

**Files:**
- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleInventoryPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

- [ ] **Step 1: Rewrite component tests for the new contract**

In `PuzzlePiece.svelte.test.ts`, remove `userEvent` if no longer used and delete tests that require the old child Rotate button. Add:

```ts
it('never renders a rotate overlay when rotation is enabled', async () => {
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

Keep the existing `r`/`R` callback test and orientation-name test.

In `PuzzleInventoryPanel.svelte.test.ts`, replace child-Rotate assertions with:

```ts
it('shows disabled header Rotate while rotation mode is enabled without a selection', async () => {
	render(PuzzleInventoryPanel, baseProps());
	await expect
		.element(page.getByRole('button', { name: 'Rotate selected piece' }))
		.toBeDisabled();
});

it('rotates the selected piece from the header', async () => {
	const input = baseProps();
	render(PuzzleInventoryPanel, { ...input, selectedPieceId: 1 });
	await page.getByRole('button', { name: 'Rotate selected piece' }).click();
	expect(input.onRotate).toHaveBeenCalledWith(1);
});

it('does not show header Rotate when rotation mode is disabled', async () => {
	render(PuzzleInventoryPanel, { ...baseProps(), rotationEnabled: false });
	expect(page.getByRole('button', { name: 'Rotate selected piece' }).query()).toBeNull();
});
```

Update the collapsed-header test so both `CANCEL` and enabled `ROTATE` remain present for a selected piece.

Remove roving assertions specific to `[data-testid="rotate-piece-button"]`; assert only one piece root has `tabIndex === 0`.

- [ ] **Step 2: Run component tests and observe RED**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts
```

Expected: FAIL against old overlay/header behavior.

- [ ] **Step 3: Remove the visual Rotate control from `PuzzlePiece.svelte`**

Delete:

- `handleRotateClick()`;
- `stopRotateEventPropagation()`;
- the conditional Rotate `<button>` block.

Keep the root `R` branch in `handleKeyDown()`, `onRotate`, orientation naming, and `aria-keyshortcuts` unchanged.

- [ ] **Step 4: Add visible/disabled header Rotate in `PuzzleInventoryPanel.svelte`**

Add a stable handler:

```ts
function rotateSelectedPiece(): void {
	const pieceId = selectedPieceId;
	if (pieceId !== null) onRotate(pieceId);
}
```

Before `CANCEL` in `.panel-actions`:

```svelte
{#if rotationEnabled}
	<button
		type="button"
		class="panel-action"
		aria-label="Rotate selected piece"
		disabled={selectedPieceId === null}
		onclick={rotateSelectedPiece}
	>
		ROTATE
	</button>
{/if}
```

Remove the `handlePiecesKeyDown()` special case for `[data-testid="rotate-piece-button"]` and update comments to describe only piece roots.

- [ ] **Step 5: Migrate every route test that clicks `Rotate piece N`**

Find all callers:

```bash
cd apps/web
rg -n "Rotate piece [0-9]+" 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Add near existing selection helpers:

```ts
async function rotateSelectedPiece(): Promise<void> {
	await page.getByRole('button', { name: 'Rotate selected piece' }).click();
}
```

For each old pointer call:

- select the target if it is not already selected;
- rotate through `rotateSelectedPiece()`;
- remove a later `selectPiece(id)` if the new pointer path already left that piece selected and the old later selection would toggle it off;
- explicitly select a different target before rotating it.

Update the main route rotation test to prove discoverability:

```ts
await page.getByLabelText('More puzzle actions').click();
await page.getByLabelText('Rotation mode').click();
await expect
	.element(page.getByRole('button', { name: 'Rotate selected piece' }))
	.toBeDisabled();

await selectPiece(0);
await expect
	.element(page.getByRole('button', { name: 'Rotate selected piece' }))
	.toBeEnabled();
await rotateSelectedPiece();
```

Add one selection-independent keyboard test:

```ts
it('rotates a focused tray piece with R without selecting it', async () => {
	await renderPuzzlePage();
	await page.getByLabelText('More puzzle actions').click();
	await page.getByLabelText('Rotation mode').click();

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

Completion check:

```bash
rg -n "Rotate piece [0-9]+" 'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: no matches.

- [ ] **Step 6: Run component + puzzle-route tests immediately**

```bash
cd apps/web
bunx vitest --run --browser \
  src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'src/routes/puzzle/[id]/page.svelte.test.ts'
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/web/src/lib/components/PuzzlePiece.svelte \
  apps/web/src/lib/components/PuzzleInventoryPanel.svelte \
  apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts \
  apps/web/src/lib/components/__tests__/PuzzleInventoryPanel.svelte.test.ts \
  'apps/web/src/routes/puzzle/[id]/page.svelte.test.ts'
git commit -m "feat(web): move piece rotation out of tray thumbnails"
```

---

### Task 4: Add the Concrete Accessible Saved Progress Dialog

**Files:**
- Create: `apps/web/src/lib/components/SavedProgressDialog.svelte`
- Create: `apps/web/src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts`

- [ ] **Step 1: Write failing dialog tests**

Create `SavedProgressDialog.svelte.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SavedProgressDialog from '../SavedProgressDialog.svelte';
import type { GalleryProgress } from '$lib/services/gameplay/galleryProgress';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

const progress: GalleryProgress[] = [{
	puzzleId: 'old-save',
	name: 'Older Mission',
	source: 'api',
	placedCount: 3,
	pieceCount: 12,
	lastUpdated: 1_000
}];

describe('SavedProgressDialog', () => {
	it('renders loading and empty states', async () => {
		const view = render(SavedProgressDialog, { progress: [], loading: true, onClose: vi.fn() });
		await expect.element(page.getByText('LOADING SAVED PROGRESS...')).toBeVisible();
		await view.rerender({ progress: [], loading: false, onClose: vi.fn() });
		await expect.element(page.getByText('NO SAVED PROGRESS')).toBeVisible();
	});

	it('renders a semantic row with a distinguishable Continue link', async () => {
		render(SavedProgressDialog, { progress, loading: false, onClose: vi.fn() });
		const list = page.getByRole('list');
		await expect.element(list).toBeVisible();
		const row = page.getByTestId('saved-progress-row-old-save');
		await expect.element(row).toHaveTextContent('Older Mission');
		await expect.element(row).toHaveTextContent('3/12 PLACED');
		await expect
			.element(row.getByRole('link', { name: 'Continue Older Mission' }))
			.toHaveAttribute('href', '/puzzle/old-save');
	});

	it('closes from Close and Escape', async () => {
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

- [ ] **Step 2: Run and observe RED**

```bash
cd apps/web
bunx vitest --run --browser src/lib/components/__tests__/SavedProgressDialog.svelte.test.ts
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement one concrete modal using `modalFocus` + safe-area padding**

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
				<ul class="flex flex-col gap-3">
					{#each progress as item (item.puzzleId)}
						<li data-testid={`saved-progress-row-${item.puzzleId}`} class="flex items-center justify-between gap-4">
							<div class="min-w-0">
								<p>{item.name}</p>
								<p>{item.placedCount}/{item.pieceCount} PLACED</p>
							</div>
							<a
								href={resolve(`/puzzle/${item.puzzleId}`)}
								aria-label={`Continue ${item.name}`}
							>CONTINUE</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
```

Use existing Perseus visual tokens/classes while keeping the component concrete.

- [ ] **Step 4: Run dialog tests GREEN**

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

### Task 5: Retain Latest Continue and Wire Lazy Picker Loading

**Files:**
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/src/routes/page.svelte.test.ts`

**Interfaces:**
- Consumes: `listResumableSessionCandidateIds`, `discoverGalleryProgress`, `discoverAllSavedProgress`, `fetchPuzzle`, `SavedProgressDialog`.

- [ ] **Step 1: Extend gallery mocks and write failing behavior tests**

Persistence mock:

```ts
const sessionStorageSpies = vi.hoisted(() => ({
	clearSession: vi.fn(),
	listCandidates: vi.fn<() => string[]>()
}));

vi.mock('$lib/services/gameplay/session/persistence', () => ({
	createSessionStorageAdapter: () => ({ clearSession: sessionStorageSpies.clearSession }),
	listResumableSessionCandidateIds: sessionStorageSpies.listCandidates
}));
```

Add `fetchPuzzle: vi.fn()` to the API mock and `discoverAllSavedProgress: vi.fn().mockResolvedValue([])` to the gallery-progress mock.

Add focused tests:

```ts
it('scans Quick metadata and resumable candidates once per mount', async () => {
	sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
	render(GalleryPage);
	await vi.waitFor(() => expect(mockedListQuick).toHaveBeenCalledTimes(1));
	expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(1);

	await page.getByTestId('search-input').fill('filtered');
	await vi.waitFor(() => expect(mockedFetchPuzzles).toHaveBeenCalledTimes(2));
	expect(mockedListQuick).toHaveBeenCalledTimes(1);
	expect(sessionStorageSpies.listCandidates).toHaveBeenCalledTimes(1);
});

it('keeps the latest Continue row when search projection no longer contains it', async () => {
	const latest = {
		puzzleId: 'p1', name: 'Latest Save', source: 'api' as const,
		placedCount: 2, pieceCount: 4, lastUpdated: 2_000
	};
	mockedDiscoverGalleryProgress
		.mockReturnValueOnce({ byPuzzleId: new Map([['p1', latest]]), newest: latest })
		.mockReturnValue({ byPuzzleId: new Map(), newest: null });

	render(GalleryPage);
	await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('Latest Save');
	await page.getByTestId('search-input').fill('other');
	await vi.waitFor(() => expect(mockedFetchPuzzles).toHaveBeenCalledTimes(2));
	await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('Latest Save');
});

it('shows picker entry for an off-page candidate with no known latest row', async () => {
	sessionStorageSpies.listCandidates.mockReturnValue(['off-page']);
	mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
	render(GalleryPage);
	await expect.element(page.getByTestId('continue-on-device')).toHaveTextContent('SAVED PROGRESS AVAILABLE');
	await expect.element(page.getByRole('button', { name: 'View saved progress' })).toBeVisible();
	expect(mockedDiscoverAllSavedProgress).not.toHaveBeenCalled();
});

it('clears the saved-progress affordance when authoritative discovery is empty', async () => {
	sessionStorageSpies.listCandidates.mockReturnValue(['deleted-puzzle']);
	mockedDiscoverGalleryProgress.mockReturnValue({ byPuzzleId: new Map(), newest: null });
	mockedDiscoverAllSavedProgress.mockResolvedValue([]);
	render(GalleryPage);
	await page.getByRole('button', { name: 'View saved progress' }).click();
	await expect.element(page.getByText('NO SAVED PROGRESS')).toBeVisible();
	await page.getByRole('button', { name: 'Close saved progress' }).click();
	await expect.poll(() => page.getByTestId('continue-on-device').query()).toBeNull();
});
```

For inert restoration, use async polling rather than a synchronous Svelte DOM assertion:

```ts
await page.getByRole('button', { name: 'View saved progress' }).click();
await expect.poll(() => document.querySelector('main')?.hasAttribute('inert')).toBe(true);
await page.getByRole('button', { name: 'Close saved progress' }).click();
await expect.poll(() => document.querySelector('main')?.hasAttribute('inert')).toBe(false);
```

Also keep/adjust existing tests for newest Continue, Discard, and one-time Quick enumeration.

- [ ] **Step 2: Run gallery page test and observe RED**

```bash
cd apps/web
bunx vitest --run --browser src/routes/page.svelte.test.ts
```

Expected: FAIL until route state is split and picker is wired.

- [ ] **Step 3: Split query-coupled card progress from retained latest progress**

Update imports to include `fetchPuzzle`, `SavedProgressDialog`, candidate probe, and `discoverAllSavedProgress`.

Replace the single presentation object with:

```ts
let cardProgressByPuzzleId = $state<ReadonlyMap<string, GalleryProgress>>(new Map());
let latestProgress = $state<GalleryProgress | null>(null);
let savedProgressCandidateIds = $state<string[]>([]);
let savedProgressOpen = $state(false);
let savedProgressLoading = $state(false);
let savedProgressItems = $state<GalleryProgress[]>([]);
let savedProgressRequestId = 0;
```

Mount once:

```ts
onMount(() => {
	quickPuzzles = listQuick();
	savedProgressCandidateIds = listResumableSessionCandidateIds();
});
```

Projection effect:

```ts
$effect(() => {
	const discovery = discoverGalleryProgress({
		serverPuzzles: puzzles,
		quickPuzzles
	});
	cardProgressByPuzzleId = discovery.byPuzzleId;

	const candidate = discovery.newest;
	if (
		candidate &&
		(latestProgress === null || candidate.lastUpdated > latestProgress.lastUpdated)
	) {
		latestProgress = candidate;
	}
});
```

Use `cardProgressByPuzzleId.get(puzzle.id)?.placedCount` for cards. Search/filter returning `newest: null` must not clear `latestProgress`.

- [ ] **Step 4: Add picker open/close request fencing and empty-result cleanup**

```ts
async function openSavedProgress(): Promise<void> {
	savedProgressOpen = true;
	savedProgressLoading = true;
	savedProgressItems = [];
	const requestId = ++savedProgressRequestId;

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
	if (items.length === 0) savedProgressCandidateIds = [];
}

function closeSavedProgress(): void {
	savedProgressRequestId += 1;
	savedProgressOpen = false;
	savedProgressLoading = false;
}
```

No retry/cache/global store is added. Reload performs a fresh candidate probe.

- [ ] **Step 5: Keep latest row + Discard and add picker affordance**

Render the section when:

```svelte
{#if latestProgress || savedProgressCandidateIds.length > 0}
```

Inside it:

- when `latestProgress`, render the existing name/progress/CONTINUE/DISCARD using `latestProgress`;
- otherwise render `SAVED PROGRESS AVAILABLE`;
- when candidate IDs exist, render:

```svelte
<button type="button" aria-label="View saved progress" onclick={openSavedProgress}>
	VIEW SAVED PROGRESS
</button>
```

Do not add Discard to the picker.

- [ ] **Step 6: Refresh state after explicit newest-session Discard**

After `clearSession(target.puzzleId)`:

```ts
const discovery = discoverGalleryProgress({ serverPuzzles: puzzles, quickPuzzles });
cardProgressByPuzzleId = discovery.byPuzzleId;
latestProgress = discovery.newest;
savedProgressCandidateIds = listResumableSessionCandidateIds();
discardTarget = null;
```

This explicit user mutation is allowed to refresh the mount probe.

- [ ] **Step 7: Compose modal and inert state**

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

- [ ] **Step 8: Run gallery/supporting tests GREEN**

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
git add apps/web/src/routes/+page.svelte apps/web/src/routes/page.svelte.test.ts
git commit -m "feat(web): open all saved puzzle progress"
```

---

### Task 6: Add Off-Page Picker E2E Without Replacing Existing Continue Coverage

**Files:**
- Modify: `apps/web/e2e/gallery.spec.ts`

- [ ] **Step 1: Leave the existing newest-session E2E unchanged**

Do not replace `shows current-device progress and continues the newest session`; it remains the E2E owner of:

- latest Continue panel;
- `1/4 PLACED` panel text;
- card badge `CONTINUE · 1/4 PLACED`;
- newest Continue navigation.

- [ ] **Step 2: Add a separate off-page picker E2E**

```ts
test('opens saved progress and resumes an older off-page save', async ({ page }) => {
	const newestId = 'e2e-square-4';
	const olderId = 'e2e-landscape-12';
	const newest = getFixture(newestId);
	const older = getFixture(olderId);
	const newestPiece = newest.pieces[0]!;
	const olderPiece = older.pieces[0]!;
	const storage = createPersistedStateController();

	await mockPuzzleList(page, [{
		id: newestId,
		name: 'Newest Resume Fixture',
		pieceCount: newest.pieceCount,
		aspectRatio: newest.aspectRatio,
		status: 'ready'
	}]);
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
	await page.getByRole('button', { name: 'View saved progress' }).click();

	const dialog = page.getByRole('dialog', { name: 'Saved progress' });
	await expect(dialog.getByTestId(`saved-progress-row-${newestId}`)).toBeVisible();
	await expect(dialog.getByTestId(`saved-progress-row-${olderId}`)).toContainText(older.name);
	await dialog.getByRole('link', { name: `Continue ${older.name}` }).click();
	await expect(page).toHaveURL(new RegExp(`/puzzle/${olderId}$`));
});
```

The initial gallery response intentionally omits `olderId`; the existing fixture router supplies detail only after picker discovery requests it.

- [ ] **Step 3: Run gallery E2E**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS for both the pre-existing newest flow and the new picker flow.

- [ ] **Step 4: Commit Task 6**

```bash
git add apps/web/e2e/gallery.spec.ts
git commit -m "test(web): cover older saved puzzle resume"
```

---

### Task 7: Final Verification

**Files:**
- No production changes expected.
- Fix only HPA-647 regressions discovered by these commands.

- [ ] **Step 1: Run all directly changed Vitest surfaces**

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

- [ ] **Step 2: Run the full web unit suite**

From repository root:

```bash
bun run test:unit --filter=@perseus/web
```

Expected: PASS. This catches shared-component regressions outside the focused list.

- [ ] **Step 3: Confirm the obsolete per-piece Rotate locator is gone**

```bash
cd apps/web
rg -n "rotate-piece-button|Rotate piece [0-9]+" src/lib/components src/routes/puzzle
```

Expected: no references to the removed overlay; `aria-keyshortcuts="R"`, `onRotate`, and `Rotate selected piece` remain.

- [ ] **Step 4: Run Svelte/TypeScript check**

```bash
cd apps/web
bun run check
```

Expected: PASS.

- [ ] **Step 5: Run repository lint to match the Build & Lint gate**

From repository root:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 6: Run gallery E2E**

```bash
cd apps/web
bunx playwright test e2e/gallery.spec.ts --project=chromium-desktop
```

Expected: PASS.

- [ ] **Step 7: Inspect scope before marking the draft ready**

```bash
git status --short
git diff --stat origin/main...HEAD
```

Expected production scope:

```text
apps/web/src/lib/services/gameplay/session/persistence.ts
apps/web/src/lib/services/gameplay/galleryProgress.ts
apps/web/src/lib/components/PuzzlePiece.svelte
apps/web/src/lib/components/PuzzleInventoryPanel.svelte
apps/web/src/lib/components/SavedProgressDialog.svelte
apps/web/src/routes/+page.svelte
```

plus the focused test files and the two HPA-647 planning docs. No API/database/shared-type/session-engine changes.

- [ ] **Step 8: Commit verification-only fixes only if needed**

If verification finds an HPA-647 regression, stage only the affected HPA-647 paths and commit on this same PR branch. If all commands pass without changes, do not create an empty commit.