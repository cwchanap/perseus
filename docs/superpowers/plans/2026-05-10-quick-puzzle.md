# Quick Puzzle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/quick` page that lets a visitor upload an image and play it as a jigsaw puzzle entirely in the browser. Quick puzzles persist in `localStorage` for 7 days or 5 puzzles, then play on the existing `/puzzle/[id]` route via a local-first puzzle source.

**Architecture:** Move shared jigsaw geometry (mask SVG + edge helpers + grid math) from `apps/workflows` into `packages/types` so the web app can reuse it. Add a `lib/services/quickPuzzle/` module (storage, generator, public facade) and a `lib/services/puzzleSource.ts` that the play page consults local-first then API. Refactor `PuzzlePiece`, `PuzzleBoard`, `ReferenceOverlay` to receive image-URL resolvers as props instead of calling the API client directly.

**Tech Stack:** SvelteKit 2 (static adapter, Svelte 5 runes), TypeScript 5.9, Vitest 4 (browser mode via Playwright Chromium), Playwright 1.57 e2e, `@perseus/types` workspace package, `OffscreenCanvas` + Canvas 2D for piece rendering. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-09-quick-puzzle-design.md`

**Conventions:**

- Tabs for indentation, single quotes, 100-char width (Prettier auto-formats on commit via Husky+lint-staged).
- Run `bun run check` and `bun run lint` from the monorepo root before each commit; the precommit hook will run Prettier itself.
- Run unit tests with `bun run test:unit`, e2e with `bun run test:e2e`. Filter to a workspace with `--filter=@perseus/<name>`.
- Commit messages use conventional prefixes (`feat:`, `refactor:`, `test:`, `chore:`).

---

## Task 1: Move `generateJigsawSvgMask` into `@perseus/types`

The mask path generator is pure, has no Cloudflare-specific deps, and is needed by both the workflow (existing) and the web app's quick-puzzle generator (new).

**Files:**

- Create: `packages/types/src/jigsaw-path.ts`
- Create: `packages/types/src/jigsaw-path.test.ts`
- Modify: `packages/types/src/index.ts` (add re-exports at bottom)
- Modify: `apps/workflows/src/index.ts:21` (change import path)
- Delete: `apps/workflows/src/utils/jigsaw-path.ts`
- Delete: `apps/workflows/src/utils/jigsaw-path.test.ts`
- Delete: `apps/workflows/src/utils/jigsaw-path-extra.test.ts` (will recreate under packages/types)
- Create: `packages/types/src/jigsaw-path-extra.test.ts`

- [ ] **Step 1: Copy `generateJigsawPath` and `generateJigsawSvgMask` to packages/types**

Read `apps/workflows/src/utils/jigsaw-path.ts` and write the same content to `packages/types/src/jigsaw-path.ts`, but change the import lines (1-5) so types come from `./index` instead of `../types`:

```ts
// Jigsaw Path Generator for Worker-based Masking
// Generates SVG mask for puzzle pieces

import type { EdgeConfig, EdgeType } from './index';
import { TAB_RATIO } from './index';
```

Everything else (constants `BEZIER_POINTS`, helpers, `generateJigsawPath`, `generateJigsawSvgMask`) is verbatim.

- [ ] **Step 2: Move test files to packages/types**

Read `apps/workflows/src/utils/jigsaw-path.test.ts` and write to `packages/types/src/jigsaw-path.test.ts` with the imports updated:

```ts
import { describe, it, expect } from 'vitest';
import { generateJigsawPath, generateJigsawSvgMask } from './jigsaw-path';
import type { EdgeConfig } from './index';
```

The body of every test stays verbatim. Do the same for `jigsaw-path-extra.test.ts` → `packages/types/src/jigsaw-path-extra.test.ts` (only the imports change).

- [ ] **Step 3: Run new tests to confirm they pass against the moved file**

Run:

```bash
cd packages/types && bun run test:unit
```

Expected: all existing tests pass plus the moved jigsaw-path tests pass.

- [ ] **Step 4: Re-export the new module from `packages/types/src/index.ts`**

Append at the end of `packages/types/src/index.ts`:

```ts
// Jigsaw mask path geometry (used by workflow generation and browser-side quick-puzzle generation)
export { generateJigsawPath, generateJigsawSvgMask } from './jigsaw-path';
```

- [ ] **Step 5: Update workflow to import from `@perseus/types`**

In `apps/workflows/src/index.ts`, replace the line:

```ts
import { generateJigsawSvgMask } from './utils/jigsaw-path';
```

with:

```ts
import { generateJigsawSvgMask } from '@perseus/types';
```

- [ ] **Step 6: Delete the old workflow files**

Run:

```bash
rm apps/workflows/src/utils/jigsaw-path.ts \
   apps/workflows/src/utils/jigsaw-path.test.ts \
   apps/workflows/src/utils/jigsaw-path-extra.test.ts
```

- [ ] **Step 7: Run workflow + types tests, plus type checks**

Run from monorepo root:

```bash
bun run check && bun run test:unit
```

Expected: all tests pass; `tsc --noEmit` produces no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/jigsaw-path.ts \
        packages/types/src/jigsaw-path.test.ts \
        packages/types/src/jigsaw-path-extra.test.ts \
        packages/types/src/index.ts \
        apps/workflows/src/index.ts \
        apps/workflows/src/utils/jigsaw-path.ts \
        apps/workflows/src/utils/jigsaw-path.test.ts \
        apps/workflows/src/utils/jigsaw-path-extra.test.ts
git commit -m "refactor: move jigsaw-path generator into @perseus/types"
```

(`git add` of deleted files records the deletions; alternatively `git add -u` for the workflow paths.)

---

## Task 2: Move grid + edge helpers into `@perseus/types`

`getGridDimensions` and the four edge helpers (`getTopEdge`, `getRightEdge`, `getBottomEdge`, `getLeftEdge`) are pure, deterministic, and currently inlined into `apps/workflows/src/index.ts`. They move to a new `grid.ts` so the web app can call them.

**Files:**

- Create: `packages/types/src/grid.ts`
- Create: `packages/types/src/grid.test.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `apps/workflows/src/index.ts:179-244` (delete inlined helpers, import from `@perseus/types`)

- [ ] **Step 1: Write the failing tests for the grid helpers**

Create `packages/types/src/grid.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getGridDimensions, getTopEdge, getRightEdge, getBottomEdge, getLeftEdge } from './grid';

describe('getGridDimensions', () => {
	it('returns balanced grid for square piece counts', () => {
		expect(getGridDimensions(225)).toEqual({ rows: 15, cols: 15 });
		expect(getGridDimensions(100)).toEqual({ rows: 10, cols: 10 });
		expect(getGridDimensions(4)).toEqual({ rows: 2, cols: 2 });
	});

	it('returns largest factor <= sqrt for non-square counts', () => {
		expect(getGridDimensions(24)).toEqual({ rows: 4, cols: 6 });
		expect(getGridDimensions(48)).toEqual({ rows: 6, cols: 8 });
		expect(getGridDimensions(96)).toEqual({ rows: 8, cols: 12 });
	});

	it('returns {1, n} for primes', () => {
		expect(getGridDimensions(7)).toEqual({ rows: 1, cols: 7 });
		expect(getGridDimensions(13)).toEqual({ rows: 1, cols: 13 });
	});

	it('returns {0, 0} for zero or negative counts', () => {
		expect(getGridDimensions(0)).toEqual({ rows: 0, cols: 0 });
		expect(getGridDimensions(-5)).toEqual({ rows: 0, cols: 0 });
	});
});

describe('edge helpers', () => {
	it('outermost edges are flat', () => {
		const rows = 3;
		const cols = 3;
		expect(getTopEdge(0, 0, rows)).toBe('flat');
		expect(getTopEdge(0, 2, rows)).toBe('flat');
		expect(getRightEdge(0, cols - 1, cols)).toBe('flat');
		expect(getRightEdge(2, cols - 1, cols)).toBe('flat');
		expect(getBottomEdge(rows - 1, 0, rows)).toBe('flat');
		expect(getBottomEdge(rows - 1, 2, rows)).toBe('flat');
		expect(getLeftEdge(0, 0, cols)).toBe('flat');
		expect(getLeftEdge(2, 0, cols)).toBe('flat');
	});

	it('adjacent pieces have matching opposite edges (horizontal)', () => {
		// Right edge of (row, col) opposes left edge of (row, col+1)
		const rows = 4;
		const cols = 4;
		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols - 1; col++) {
				const right = getRightEdge(row, col, cols);
				const leftOfNext = getLeftEdge(row, col + 1, cols);
				if (right === 'tab') expect(leftOfNext).toBe('blank');
				else if (right === 'blank') expect(leftOfNext).toBe('tab');
				else expect(leftOfNext).toBe('flat');
			}
		}
	});

	it('adjacent pieces have matching opposite edges (vertical)', () => {
		const rows = 4;
		const cols = 4;
		for (let row = 0; row < rows - 1; row++) {
			for (let col = 0; col < cols; col++) {
				const bottom = getBottomEdge(row, col, rows);
				const topOfNext = getTopEdge(row + 1, col, rows);
				if (bottom === 'tab') expect(topOfNext).toBe('blank');
				else if (bottom === 'blank') expect(topOfNext).toBe('tab');
				else expect(topOfNext).toBe('flat');
			}
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/types && bun run test:unit
```

Expected: FAIL with "Cannot find module './grid'".

- [ ] **Step 3: Implement the helpers**

Create `packages/types/src/grid.ts`:

```ts
// Pure grid + edge geometry helpers shared by the workflow and the web's quick-puzzle generator.
// Edge calculation is deterministic by position so that adjacent pieces always have
// matching/opposite edges without coordination.

import type { EdgeType } from './index';

/**
 * Find the most square-like grid for a given piece count.
 * Picks the largest factor of `pieceCount` that is <= sqrt(pieceCount) as the row count,
 * giving rows <= cols (e.g., 225 → 15x15, 24 → 4x6).
 */
export function getGridDimensions(pieceCount: number): { rows: number; cols: number } {
	if (pieceCount <= 0) {
		return { rows: 0, cols: 0 };
	}

	const sqrt = Math.floor(Math.sqrt(pieceCount));
	for (let i = sqrt; i >= 1; i -= 1) {
		if (pieceCount % i === 0) {
			return { rows: i, cols: pieceCount / i };
		}
	}

	// Unreachable: the loop always returns at i===1 since pieceCount % 1 === 0.
	return { rows: 1, cols: pieceCount };
}

function opposite(edge: EdgeType): EdgeType {
	return edge === 'tab' ? 'blank' : edge === 'blank' ? 'tab' : 'flat';
}

export function getBottomEdge(row: number, col: number, rows: number): EdgeType {
	if (row === rows - 1) return 'flat';
	return (row + col) % 2 === 0 ? 'blank' : 'tab';
}

export function getRightEdge(row: number, col: number, cols: number): EdgeType {
	if (col === cols - 1) return 'flat';
	return (row + col) % 2 === 0 ? 'tab' : 'blank';
}

export function getTopEdge(row: number, col: number, rows: number): EdgeType {
	if (row === 0) return 'flat';
	return opposite(getBottomEdge(row - 1, col, rows));
}

export function getLeftEdge(row: number, col: number, cols: number): EdgeType {
	if (col === 0) return 'flat';
	return opposite(getRightEdge(row, col - 1, cols));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd packages/types && bun run test:unit
```

Expected: PASS for all `grid.test.ts` cases.

- [ ] **Step 5: Re-export from `packages/types/src/index.ts`**

Append after the jigsaw-path export added in Task 1:

```ts
export { getGridDimensions, getTopEdge, getRightEdge, getBottomEdge, getLeftEdge } from './grid';
```

- [ ] **Step 6: Update the workflow to import these helpers and delete its inlined copies**

In `apps/workflows/src/index.ts`:

- Add to the imports near the top (the `@perseus/types`-related block already includes `generateJigsawSvgMask`):

```ts
import {
	generateJigsawSvgMask,
	getGridDimensions,
	getTopEdge,
	getRightEdge,
	getBottomEdge,
	getLeftEdge
} from '@perseus/types';
```

- Remove the now-redundant inlined `function getGridDimensions(...)` and the four `function getXEdge(...)` definitions and their `function opposite(...)` helper (currently lines 183-244 in the original file). Leave the rest of the file untouched.

- [ ] **Step 7: Run all tests + check + lint**

Run from monorepo root:

```bash
bun run check && bun run test:unit && bun run lint
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/grid.ts \
        packages/types/src/grid.test.ts \
        packages/types/src/index.ts \
        apps/workflows/src/index.ts
git commit -m "refactor: move grid + edge helpers into @perseus/types"
```

---

## Task 3: Add quick-puzzle types and validation error

Foundation for the next tasks: data shapes and an error class for upload validation. No runtime behaviour yet.

**Files:**

- Create: `apps/web/src/lib/services/quickPuzzle/types.ts`

- [ ] **Step 1: Create the types file**

Create `apps/web/src/lib/services/quickPuzzle/types.ts`:

```ts
import type { EdgeConfig } from '@perseus/types';

export interface QuickPieceMeta {
	id: number; // row * cols + col
	correctX: number; // col
	correctY: number; // row
	edges: EdgeConfig;
}

export interface StoredQuickPuzzle {
	id: string; // 'q-' + crypto.randomUUID()
	name: string; // derived from filename, max 80 chars
	pieceCount: number;
	gridRows: number;
	gridCols: number;
	imageWidth: number; // post-downscale
	imageHeight: number;
	imageDataUrl: string; // JPEG, base64
	pieces: QuickPieceMeta[];
	createdAt: number; // epoch ms
	schemaVersion: 1;
}

export interface QuickPuzzleIndex {
	ids: string[]; // newest first; max length 5
	schemaVersion: 1;
}

export type QuickPuzzleValidationCode =
	| 'invalid-mime'
	| 'file-too-large'
	| 'piece-count-out-of-range'
	| 'decode-failed'
	| 'unsupported-browser';

export class QuickPuzzleValidationError extends Error {
	constructor(
		public code: QuickPuzzleValidationCode,
		message: string
	) {
		super(message);
		this.name = 'QuickPuzzleValidationError';
	}
}

// Constants
export const QUICK_PUZZLE_INDEX_KEY = 'quickPuzzle:index';
export const QUICK_PUZZLE_KEY_PREFIX = 'quickPuzzle:';
export const QUICK_PUZZLE_MAX_COUNT = 5;
export const QUICK_PUZZLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const QUICK_PUZZLE_SCHEMA_VERSION = 1 as const;
export const QUICK_PUZZLE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
export const QUICK_PUZZLE_MAX_DIMENSION = 1200; // longest side in px after downscale
export const QUICK_PUZZLE_JPEG_QUALITY = 0.8;
export const QUICK_PUZZLE_MIN_PIECES = 4;
export const QUICK_PUZZLE_MAX_PIECES = 100;
export const QUICK_PUZZLE_DEFAULT_PIECES = 24;
export const QUICK_PUZZLE_ID_PREFIX = 'q-';
export const QUICK_PUZZLE_ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
```

- [ ] **Step 2: Run typecheck to confirm the file is well-formed**

Run from monorepo root:

```bash
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/services/quickPuzzle/types.ts
git commit -m "feat(web): add quick-puzzle types module"
```

---

## Task 4: Implement `quickPuzzle/storage.ts` with TDD

Pure-ish localStorage I/O: `saveQuick`, `getQuick`, `listQuick`, `deleteQuick`. Eviction (5-puzzle cap) and 7-day expiry live here. Tests mock `localStorage` quota and use `vi.setSystemTime` for expiry.

**Files:**

- Create: `apps/web/src/lib/services/quickPuzzle/storage.ts`
- Create: `apps/web/src/lib/services/quickPuzzle/storage.test.ts`

Note: web tests run in browser mode (Playwright Chromium), so a real `localStorage` and `Storage` prototype is available.

- [ ] **Step 1: Write the test file**

Create `apps/web/src/lib/services/quickPuzzle/storage.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveQuick, getQuick, listQuick, deleteQuick } from './storage';
import {
	QUICK_PUZZLE_INDEX_KEY,
	QUICK_PUZZLE_KEY_PREFIX,
	QUICK_PUZZLE_SCHEMA_VERSION,
	QUICK_PUZZLE_TTL_MS,
	type StoredQuickPuzzle
} from './types';

function makePuzzle(overrides: Partial<StoredQuickPuzzle> = {}): StoredQuickPuzzle {
	return {
		id: 'q-test-id',
		name: 'Test',
		pieceCount: 4,
		gridRows: 2,
		gridCols: 2,
		imageWidth: 100,
		imageHeight: 100,
		imageDataUrl: 'data:image/jpeg;base64,/9j/AAAA',
		pieces: [],
		createdAt: Date.now(),
		schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION,
		...overrides
	};
}

describe('saveQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('persists a new puzzle and adds it to the index', () => {
		const puzzle = makePuzzle({ id: 'q-a' });
		const result = saveQuick(puzzle);
		expect(result).toEqual({ persisted: true });
		expect(JSON.parse(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-a`)!)).toEqual(puzzle);
		expect(JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!)).toEqual({
			ids: ['q-a'],
			schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION
		});
	});

	it('prepends new puzzle so list is newest-first', () => {
		saveQuick(makePuzzle({ id: 'q-1', createdAt: 1000 }));
		saveQuick(makePuzzle({ id: 'q-2', createdAt: 2000 }));
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-2', 'q-1']);
	});

	it('evicts oldest when index already has 5 entries', () => {
		for (let i = 1; i <= 5; i++) {
			saveQuick(makePuzzle({ id: `q-${i}`, createdAt: i * 1000 }));
		}
		saveQuick(makePuzzle({ id: 'q-6', createdAt: 6000 }));

		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-6', 'q-5', 'q-4', 'q-3', 'q-2']);
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-1`)).toBeNull();
	});

	it('returns { persisted: false } and does not mutate index on QuotaExceededError', () => {
		saveQuick(makePuzzle({ id: 'q-existing' }));
		const indexBefore = localStorage.getItem(QUICK_PUZZLE_INDEX_KEY);

		const original = Storage.prototype.setItem;
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
			this: Storage,
			key: string,
			value: string
		) {
			if (key.startsWith(QUICK_PUZZLE_KEY_PREFIX) && key !== QUICK_PUZZLE_INDEX_KEY) {
				const err = new DOMException('Quota exceeded', 'QuotaExceededError');
				throw err;
			}
			original.call(this, key, value);
		});

		try {
			const result = saveQuick(makePuzzle({ id: 'q-new' }));
			expect(result).toEqual({ persisted: false });
			expect(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)).toBe(indexBefore);
			expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-new`)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('getQuick', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns null when no entry exists', () => {
		expect(getQuick('q-missing')).toBeNull();
	});

	it('returns the stored puzzle', () => {
		const puzzle = makePuzzle({ id: 'q-foo' });
		saveQuick(puzzle);
		expect(getQuick('q-foo')).toEqual(puzzle);
	});

	it('returns null and removes per-puzzle key when entry is older than 7 days', () => {
		const start = new Date('2026-05-01T00:00:00Z').getTime();
		vi.useFakeTimers();
		vi.setSystemTime(start);
		saveQuick(makePuzzle({ id: 'q-old', createdAt: start }));

		// Advance just past 7 days
		vi.setSystemTime(start + QUICK_PUZZLE_TTL_MS + 1);
		expect(getQuick('q-old')).toBeNull();
		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-old`)).toBeNull();
	});

	it('returns null when stored entry has mismatched schemaVersion', () => {
		const puzzle = makePuzzle({ id: 'q-bad' });
		localStorage.setItem(
			`${QUICK_PUZZLE_KEY_PREFIX}q-bad`,
			JSON.stringify({ ...puzzle, schemaVersion: 99 })
		);
		expect(getQuick('q-bad')).toBeNull();
	});

	it('returns null when stored JSON is malformed', () => {
		localStorage.setItem(`${QUICK_PUZZLE_KEY_PREFIX}q-bad`, '{not json');
		expect(getQuick('q-bad')).toBeNull();
	});
});

describe('listQuick', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns empty array when no index exists', () => {
		expect(listQuick()).toEqual([]);
	});

	it('returns puzzles in newest-first order', () => {
		saveQuick(makePuzzle({ id: 'q-a', createdAt: 1000 }));
		saveQuick(makePuzzle({ id: 'q-b', createdAt: 2000 }));
		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-b', 'q-a']);
	});

	it('drops entries with mismatched schemaVersion and persists cleaned index', () => {
		saveQuick(makePuzzle({ id: 'q-good' }));
		localStorage.setItem(
			`${QUICK_PUZZLE_KEY_PREFIX}q-bad`,
			JSON.stringify({ ...makePuzzle({ id: 'q-bad' }), schemaVersion: 99 })
		);
		// Manually inject q-bad into the index
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		index.ids = ['q-bad', ...index.ids];
		localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));

		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-good']);
		const indexAfter = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(indexAfter.ids).toEqual(['q-good']);
	});

	it('drops orphaned index entries (per-puzzle key missing)', () => {
		saveQuick(makePuzzle({ id: 'q-keep' }));
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		index.ids = ['q-orphan', ...index.ids];
		localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));

		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-keep']);
	});

	it('drops entries past 7-day TTL', () => {
		const start = new Date('2026-05-01T00:00:00Z').getTime();
		vi.useFakeTimers();
		vi.setSystemTime(start);
		saveQuick(makePuzzle({ id: 'q-old', createdAt: start }));
		saveQuick(makePuzzle({ id: 'q-new', createdAt: start + 1000 }));

		vi.setSystemTime(start + QUICK_PUZZLE_TTL_MS + 1);
		const list = listQuick();
		expect(list.map((p) => p.id)).toEqual(['q-new']);
	});
});

describe('deleteQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('removes per-puzzle key and index entry', () => {
		saveQuick(makePuzzle({ id: 'q-a' }));
		saveQuick(makePuzzle({ id: 'q-b' }));
		deleteQuick('q-a');

		expect(localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}q-a`)).toBeNull();
		const index = JSON.parse(localStorage.getItem(QUICK_PUZZLE_INDEX_KEY)!);
		expect(index.ids).toEqual(['q-b']);
	});

	it('is a no-op for unknown ids', () => {
		expect(() => deleteQuick('q-missing')).not.toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from monorepo root:

```bash
cd apps/web && bun run test:unit -- src/lib/services/quickPuzzle/storage.test.ts
```

Expected: FAIL with "Cannot find module './storage'".

- [ ] **Step 3: Implement `storage.ts`**

Create `apps/web/src/lib/services/quickPuzzle/storage.ts`:

```ts
import {
	QUICK_PUZZLE_INDEX_KEY,
	QUICK_PUZZLE_KEY_PREFIX,
	QUICK_PUZZLE_MAX_COUNT,
	QUICK_PUZZLE_SCHEMA_VERSION,
	QUICK_PUZZLE_TTL_MS,
	type QuickPuzzleIndex,
	type StoredQuickPuzzle
} from './types';

function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readIndexRaw(): QuickPuzzleIndex {
	if (!isBrowser()) return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
	const raw = localStorage.getItem(QUICK_PUZZLE_INDEX_KEY);
	if (!raw) return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };

	try {
		const parsed = JSON.parse(raw) as Partial<QuickPuzzleIndex>;
		if (parsed.schemaVersion !== QUICK_PUZZLE_SCHEMA_VERSION) {
			return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
		}
		if (!Array.isArray(parsed.ids)) {
			return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
		}
		return {
			ids: parsed.ids.filter((id): id is string => typeof id === 'string'),
			schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION
		};
	} catch {
		return { ids: [], schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION };
	}
}

function writeIndex(index: QuickPuzzleIndex): void {
	if (!isBrowser()) return;
	localStorage.setItem(QUICK_PUZZLE_INDEX_KEY, JSON.stringify(index));
}

function readEntryRaw(id: string): StoredQuickPuzzle | null {
	if (!isBrowser()) return null;
	const raw = localStorage.getItem(`${QUICK_PUZZLE_KEY_PREFIX}${id}`);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as StoredQuickPuzzle;
		if (parsed.schemaVersion !== QUICK_PUZZLE_SCHEMA_VERSION) return null;
		if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'number') return null;
		return parsed;
	} catch {
		return null;
	}
}

function removeEntry(id: string): void {
	if (!isBrowser()) return;
	localStorage.removeItem(`${QUICK_PUZZLE_KEY_PREFIX}${id}`);
}

function isExpired(entry: StoredQuickPuzzle, now: number): boolean {
	return entry.createdAt + QUICK_PUZZLE_TTL_MS <= now;
}

/**
 * Read all surviving puzzles, newest-first.
 * Side effects: drops orphaned, expired, and schema-mismatched entries from the index
 * and removes their per-puzzle keys.
 */
export function listQuick(): StoredQuickPuzzle[] {
	if (!isBrowser()) return [];

	const index = readIndexRaw();
	const now = Date.now();
	const survivors: StoredQuickPuzzle[] = [];
	const survivingIds: string[] = [];

	for (const id of index.ids) {
		const entry = readEntryRaw(id);
		if (!entry) continue; // orphan or schema mismatch

		if (isExpired(entry, now)) {
			removeEntry(id);
			continue;
		}

		survivors.push(entry);
		survivingIds.push(id);
	}

	if (survivingIds.length !== index.ids.length) {
		writeIndex({ ids: survivingIds, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
	}

	return survivors;
}

/**
 * Read a single puzzle. Drops it (and its per-puzzle key) if expired or schema-mismatched.
 * Does not modify the index for orphan/expiry of a single id — leave that to listQuick.
 */
export function getQuick(id: string): StoredQuickPuzzle | null {
	if (!isBrowser()) return null;

	const entry = readEntryRaw(id);
	if (!entry) return null;

	if (isExpired(entry, Date.now())) {
		removeEntry(id);
		return null;
	}

	return entry;
}

/**
 * Persist a new puzzle. Evicts oldest entries until index has < QUICK_PUZZLE_MAX_COUNT.
 * Returns { persisted: false } if the per-puzzle write throws QuotaExceededError;
 * the index is left unchanged in that case.
 */
export function saveQuick(stored: StoredQuickPuzzle): { persisted: boolean } {
	if (!isBrowser()) return { persisted: false };

	// listQuick prunes expired/orphaned entries first, freeing space.
	const survivors = listQuick();
	let ids = survivors.map((p) => p.id);

	// Evict oldest while at or above cap (we're about to add one).
	while (ids.length >= QUICK_PUZZLE_MAX_COUNT) {
		const evictId = ids[ids.length - 1];
		removeEntry(evictId);
		ids = ids.slice(0, -1);
	}

	try {
		localStorage.setItem(`${QUICK_PUZZLE_KEY_PREFIX}${stored.id}`, JSON.stringify(stored));
	} catch (err) {
		// Reflect any mid-flight eviction back to the index, but do NOT add the failed id.
		writeIndex({ ids, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
		// QuotaExceededError or other write failure: do not mutate index further.
		return { persisted: false };
	}

	const dedupedIds = [stored.id, ...ids.filter((id) => id !== stored.id)].slice(
		0,
		QUICK_PUZZLE_MAX_COUNT
	);
	writeIndex({ ids: dedupedIds, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
	return { persisted: true };
}

/**
 * Delete a puzzle and remove it from the index. No-op for unknown ids.
 */
export function deleteQuick(id: string): void {
	if (!isBrowser()) return;

	removeEntry(id);
	const index = readIndexRaw();
	const filtered = index.ids.filter((existing) => existing !== id);
	if (filtered.length !== index.ids.length) {
		writeIndex({ ids: filtered, schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION });
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/services/quickPuzzle/storage.test.ts
```

Expected: PASS for all storage cases.

- [ ] **Step 5: Run typecheck**

Run from monorepo root:

```bash
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/services/quickPuzzle/storage.ts \
        apps/web/src/lib/services/quickPuzzle/storage.test.ts
git commit -m "feat(web): add quick-puzzle localStorage layer"
```

---

## Task 5: Implement `quickPuzzle/generator.ts`

Browser-side Canvas pipeline that decodes → downscales → builds piece metadata → renders piece bitmaps as object URLs. Pure rendering — no localStorage I/O.

**Files:**

- Create: `apps/web/src/lib/services/quickPuzzle/generator.ts`
- Create: `apps/web/src/lib/services/quickPuzzle/generator.test.ts`

- [ ] **Step 1: Write the test file (smoke + validation)**

Create `apps/web/src/lib/services/quickPuzzle/generator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateQuickPuzzle, validateUploadFile } from './generator';
import { QuickPuzzleValidationError } from './types';

async function makeTestImageFile(width = 200, height = 200): Promise<File> {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ff8800';
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = '#0088ff';
	ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
	return new File([blob], 'test.jpg', { type: 'image/jpeg' });
}

describe('validateUploadFile', () => {
	it('accepts JPEG/PNG/WebP under the size cap', () => {
		const file = new File([new Uint8Array(100)], 'a.jpg', { type: 'image/jpeg' });
		expect(() => validateUploadFile(file)).not.toThrow();
	});

	it('rejects unsupported MIME with code invalid-mime', () => {
		const file = new File([new Uint8Array(100)], 'a.gif', { type: 'image/gif' });
		expect(() => validateUploadFile(file)).toThrow(QuickPuzzleValidationError);
		try {
			validateUploadFile(file);
		} catch (err) {
			expect((err as QuickPuzzleValidationError).code).toBe('invalid-mime');
		}
	});

	it('rejects oversized file with code file-too-large', () => {
		const big = new File([new Uint8Array(21 * 1024 * 1024)], 'a.jpg', { type: 'image/jpeg' });
		try {
			validateUploadFile(big);
		} catch (err) {
			expect((err as QuickPuzzleValidationError).code).toBe('file-too-large');
		}
	});
});

describe('generateQuickPuzzle', () => {
	it('produces stored metadata + a piece-blob URL per piece', async () => {
		const file = await makeTestImageFile(400, 400);
		const result = await generateQuickPuzzle(file, 4, 'My Puzzle');

		expect(result.stored.id).toMatch(/^q-/);
		expect(result.stored.name).toBe('My Puzzle');
		expect(result.stored.pieceCount).toBe(4);
		expect(result.stored.gridRows * result.stored.gridCols).toBe(4);
		expect(result.stored.pieces).toHaveLength(4);
		expect(result.stored.imageDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
		expect(result.pieceBlobUrls.size).toBe(4);
		for (let i = 0; i < 4; i++) {
			expect(result.pieceBlobUrls.get(i)).toMatch(/^blob:/);
		}
	});

	it('downscales images larger than the max dimension', async () => {
		const file = await makeTestImageFile(2400, 1800);
		const result = await generateQuickPuzzle(file, 4, 'Big');

		expect(Math.max(result.stored.imageWidth, result.stored.imageHeight)).toBeLessThanOrEqual(1200);
	});

	it('rejects piece counts outside [4, 100]', async () => {
		const file = await makeTestImageFile(200, 200);
		await expect(generateQuickPuzzle(file, 3, 'x')).rejects.toThrow(QuickPuzzleValidationError);
		await expect(generateQuickPuzzle(file, 101, 'x')).rejects.toThrow(QuickPuzzleValidationError);
	});

	it('reports progress via the optional onProgress callback', async () => {
		const file = await makeTestImageFile(200, 200);
		const calls: Array<{ done: number; total: number }> = [];
		await generateQuickPuzzle(file, 4, 'Prog', {
			onProgress: (done, total) => calls.push({ done, total })
		});
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[calls.length - 1]).toEqual({ done: 4, total: 4 });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/services/quickPuzzle/generator.test.ts
```

Expected: FAIL with "Cannot find module './generator'".

- [ ] **Step 3: Implement `generator.ts`**

Create `apps/web/src/lib/services/quickPuzzle/generator.ts`:

```ts
import {
	TAB_RATIO,
	generateJigsawSvgMask,
	getGridDimensions,
	getTopEdge,
	getRightEdge,
	getBottomEdge,
	getLeftEdge,
	type EdgeConfig
} from '@perseus/types';

import {
	QUICK_PUZZLE_ALLOWED_MIMES,
	QUICK_PUZZLE_DEFAULT_PIECES,
	QUICK_PUZZLE_ID_PREFIX,
	QUICK_PUZZLE_JPEG_QUALITY,
	QUICK_PUZZLE_MAX_DIMENSION,
	QUICK_PUZZLE_MAX_PIECES,
	QUICK_PUZZLE_MAX_UPLOAD_BYTES,
	QUICK_PUZZLE_MIN_PIECES,
	QUICK_PUZZLE_SCHEMA_VERSION,
	QuickPuzzleValidationError,
	type QuickPieceMeta,
	type StoredQuickPuzzle
} from './types';

export interface GenerateOptions {
	onProgress?: (done: number, total: number) => void;
}

export interface GenerateResult {
	stored: StoredQuickPuzzle;
	pieceBlobUrls: Map<number, string>;
}

export function validateUploadFile(file: File): void {
	const mime = file.type.toLowerCase();
	if (!(QUICK_PUZZLE_ALLOWED_MIMES as readonly string[]).includes(mime)) {
		throw new QuickPuzzleValidationError(
			'invalid-mime',
			'Please choose a JPEG, PNG, or WebP image.'
		);
	}
	if (file.size > QUICK_PUZZLE_MAX_UPLOAD_BYTES) {
		throw new QuickPuzzleValidationError('file-too-large', 'Image too large (max 20 MB).');
	}
}

function validatePieceCount(count: number): void {
	if (
		!Number.isInteger(count) ||
		count < QUICK_PUZZLE_MIN_PIECES ||
		count > QUICK_PUZZLE_MAX_PIECES
	) {
		throw new QuickPuzzleValidationError(
			'piece-count-out-of-range',
			`Choose between ${QUICK_PUZZLE_MIN_PIECES} and ${QUICK_PUZZLE_MAX_PIECES} pieces.`
		);
	}
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') resolve(reader.result);
			else reject(new Error('FileReader did not return a string'));
		};
		reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
		reader.readAsDataURL(blob);
	});
}

function svgStringToImage(svg: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load SVG mask'));
		img.src = url;
	});
}

async function decodeAndDownscale(file: File): Promise<{
	bitmap: ImageBitmap;
	width: number;
	height: number;
	imageDataUrl: string;
}> {
	let source: ImageBitmap;
	try {
		source = await createImageBitmap(file);
	} catch (err) {
		throw new QuickPuzzleValidationError(
			'decode-failed',
			"Couldn't read this image. Try a different file."
		);
	}

	const longest = Math.max(source.width, source.height);
	const scale = longest > QUICK_PUZZLE_MAX_DIMENSION ? QUICK_PUZZLE_MAX_DIMENSION / longest : 1;
	const targetW = Math.round(source.width * scale);
	const targetH = Math.round(source.height * scale);

	const canvas = new OffscreenCanvas(targetW, targetH);
	const ctx = canvas.getContext('2d');
	if (!ctx)
		throw new QuickPuzzleValidationError(
			'unsupported-browser',
			"Your browser doesn't support quick puzzles."
		);
	ctx.drawImage(source, 0, 0, targetW, targetH);
	source.close?.();

	const blob = await canvas.convertToBlob({
		type: 'image/jpeg',
		quality: QUICK_PUZZLE_JPEG_QUALITY
	});
	const imageDataUrl = await blobToDataUrl(blob);

	// Re-decode the downscaled blob so subsequent piece extraction operates on the
	// final, normalised pixel data (otherwise we'd pull from the larger source).
	const finalBitmap = await createImageBitmap(blob);

	return { bitmap: finalBitmap, width: targetW, height: targetH, imageDataUrl };
}

function buildPieceMeta(rows: number, cols: number, pieceCount: number): QuickPieceMeta[] {
	const pieces: QuickPieceMeta[] = [];
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const id = row * cols + col;
			if (id >= pieceCount) break;
			const edges: EdgeConfig = {
				top: getTopEdge(row, col, rows),
				right: getRightEdge(row, col, cols),
				bottom: getBottomEdge(row, col, rows),
				left: getLeftEdge(row, col, cols)
			};
			pieces.push({ id, correctX: col, correctY: row, edges });
		}
	}
	return pieces;
}

interface PieceBounds {
	extractLeft: number;
	extractTop: number;
	extractWidth: number;
	extractHeight: number;
	targetWidth: number;
	targetHeight: number;
	offsetX: number;
	offsetY: number;
}

function computePieceBounds(
	row: number,
	col: number,
	rows: number,
	cols: number,
	srcW: number,
	srcH: number
): PieceBounds {
	const basePieceWidth = Math.floor(srcW / cols);
	const extraWidth = srcW % cols;
	const basePieceHeight = Math.floor(srcH / rows);
	const extraHeight = srcH % rows;

	const baseWidth = basePieceWidth + (col === cols - 1 ? extraWidth : 0);
	const baseHeight = basePieceHeight + (row === rows - 1 ? extraHeight : 0);

	const overlapX = Math.floor(baseWidth * TAB_RATIO);
	const overlapY = Math.floor(baseHeight * TAB_RATIO);

	const targetWidth = baseWidth + 2 * overlapX;
	const targetHeight = baseHeight + 2 * overlapY;

	const baseLeft = col * basePieceWidth;
	const baseTop = row * basePieceHeight;
	const idealLeft = baseLeft - overlapX;
	const idealTop = baseTop - overlapY;

	const extractLeft = Math.max(0, idealLeft);
	const extractTop = Math.max(0, idealTop);
	const extractRight = Math.min(srcW, idealLeft + targetWidth);
	const extractBottom = Math.min(srcH, idealTop + targetHeight);

	const extractWidth = extractRight - extractLeft;
	const extractHeight = extractBottom - extractTop;
	const offsetX = extractLeft - idealLeft;
	const offsetY = extractTop - idealTop;

	return {
		extractLeft,
		extractTop,
		extractWidth,
		extractHeight,
		targetWidth,
		targetHeight,
		offsetX,
		offsetY
	};
}

async function renderPiece(
	source: ImageBitmap,
	piece: QuickPieceMeta,
	bounds: PieceBounds
): Promise<string> {
	const canvas = new OffscreenCanvas(bounds.targetWidth, bounds.targetHeight);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

	ctx.drawImage(
		source,
		bounds.extractLeft,
		bounds.extractTop,
		bounds.extractWidth,
		bounds.extractHeight,
		bounds.offsetX,
		bounds.offsetY,
		bounds.extractWidth,
		bounds.extractHeight
	);

	const svg = generateJigsawSvgMask(piece.edges, bounds.targetWidth, bounds.targetHeight);
	const maskImg = await svgStringToImage(svg);
	ctx.globalCompositeOperation = 'destination-in';
	ctx.drawImage(maskImg, 0, 0, bounds.targetWidth, bounds.targetHeight);
	ctx.globalCompositeOperation = 'source-over';

	const blob = await canvas.convertToBlob({ type: 'image/png' });
	return URL.createObjectURL(blob);
}

function generateId(): string {
	const uuid =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: Math.random().toString(36).slice(2) + Date.now().toString(36);
	return `${QUICK_PUZZLE_ID_PREFIX}${uuid}`;
}

export async function generateQuickPuzzle(
	file: File,
	pieceCount: number = QUICK_PUZZLE_DEFAULT_PIECES,
	name: string = '',
	options: GenerateOptions = {}
): Promise<GenerateResult> {
	validateUploadFile(file);
	validatePieceCount(pieceCount);

	const decoded = await decodeAndDownscale(file);
	const { rows, cols } = getGridDimensions(pieceCount);
	const pieces = buildPieceMeta(rows, cols, pieceCount);
	const pieceBlobUrls = new Map<number, string>();

	let done = 0;
	options.onProgress?.(done, pieces.length);

	for (const piece of pieces) {
		const bounds = computePieceBounds(
			piece.correctY,
			piece.correctX,
			rows,
			cols,
			decoded.width,
			decoded.height
		);
		const url = await renderPiece(decoded.bitmap, piece, bounds);
		pieceBlobUrls.set(piece.id, url);
		done += 1;
		options.onProgress?.(done, pieces.length);
	}

	decoded.bitmap.close?.();

	const stored: StoredQuickPuzzle = {
		id: generateId(),
		name: (name || 'Untitled').slice(0, 80),
		pieceCount,
		gridRows: rows,
		gridCols: cols,
		imageWidth: decoded.width,
		imageHeight: decoded.height,
		imageDataUrl: decoded.imageDataUrl,
		pieces,
		createdAt: Date.now(),
		schemaVersion: QUICK_PUZZLE_SCHEMA_VERSION
	};

	return { stored, pieceBlobUrls };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/services/quickPuzzle/generator.test.ts
```

Expected: PASS for all generator cases.

- [ ] **Step 5: Run typecheck**

Run from monorepo root:

```bash
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/services/quickPuzzle/generator.ts \
        apps/web/src/lib/services/quickPuzzle/generator.test.ts
git commit -m "feat(web): add Canvas-based quick-puzzle generator"
```

---

## Task 6: Implement `quickPuzzle/index.ts` public facade

Wraps `generator.ts` and `storage.ts`, owns the module-level in-memory blob-URL cache so the play page can find pieces it didn't generate this session.

**Files:**

- Create: `apps/web/src/lib/services/quickPuzzle/index.ts`
- Create: `apps/web/src/lib/services/quickPuzzle/index.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/web/src/lib/services/quickPuzzle/index.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createQuick, openQuick, evictBlobUrls, getReferenceImage } from './index';
import { deleteQuick } from './storage';

async function makeTestImageFile(width = 200, height = 200): Promise<File> {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#f00';
	ctx.fillRect(0, 0, width, height);
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
	return new File([blob], 'test.jpg', { type: 'image/jpeg' });
}

describe('createQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('returns stored puzzle, persisted=true, and seeds blob cache', async () => {
		const file = await makeTestImageFile();
		const result = await createQuick(file, 4, 'Hello');

		expect(result.stored.name).toBe('Hello');
		expect(result.persisted).toBe(true);

		const opened = await openQuick(result.stored.id);
		expect(opened).not.toBeNull();
		expect(opened!.resolvePieceImage(result.stored.pieces[0])).toMatch(/^blob:/);

		evictBlobUrls(result.stored.id);
	});
});

describe('openQuick', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('returns null for unknown ids', async () => {
		expect(await openQuick('q-missing')).toBeNull();
	});

	it('re-renders pieces from imageDataUrl when blob cache is empty', async () => {
		const file = await makeTestImageFile();
		const created = await createQuick(file, 4, 'Reload');
		const id = created.stored.id;

		// Simulate page-reload: drop the in-memory cache.
		evictBlobUrls(id);

		const opened = await openQuick(id);
		expect(opened).not.toBeNull();
		expect(opened!.resolvePieceImage(created.stored.pieces[0])).toMatch(/^blob:/);

		evictBlobUrls(id);
	});

	it('finds session-only puzzles when storage save failed', async () => {
		// Make every per-puzzle setItem fail to simulate quota exhaustion.
		const original = Storage.prototype.setItem;
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
			this: Storage,
			key: string,
			value: string
		) {
			if (key.startsWith('quickPuzzle:') && key !== 'quickPuzzle:index') {
				throw new DOMException('Quota exceeded', 'QuotaExceededError');
			}
			original.call(this, key, value);
		});

		try {
			const file = await makeTestImageFile();
			const created = await createQuick(file, 4, 'SessionOnly');
			expect(created.persisted).toBe(false);

			const opened = await openQuick(created.stored.id);
			expect(opened).not.toBeNull();
			expect(opened!.stored.name).toBe('SessionOnly');
			expect(opened!.resolvePieceImage(created.stored.pieces[0])).toMatch(/^blob:/);

			evictBlobUrls(created.stored.id);
			// After evict, openQuick can no longer find it.
			expect(await openQuick(created.stored.id)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('getReferenceImage', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('returns the imageDataUrl for a stored puzzle', async () => {
		const file = await makeTestImageFile();
		const created = await createQuick(file, 4, 'Ref');
		const ref = getReferenceImage(created.stored.id);
		expect(ref).toBe(created.stored.imageDataUrl);
		evictBlobUrls(created.stored.id);
	});

	it('returns null for unknown ids', () => {
		expect(getReferenceImage('q-missing')).toBeNull();
	});
});

describe('evictBlobUrls', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('revokes URLs and drops the cache entry', async () => {
		const file = await makeTestImageFile();
		const result = await createQuick(file, 4, 'Cleanup');
		evictBlobUrls(result.stored.id);

		// Subsequent open() must re-render (blobs should be different).
		const reopen1 = await openQuick(result.stored.id);
		const url1 = reopen1!.resolvePieceImage(result.stored.pieces[0]);
		evictBlobUrls(result.stored.id);

		const reopen2 = await openQuick(result.stored.id);
		const url2 = reopen2!.resolvePieceImage(result.stored.pieces[0]);
		expect(url1).not.toBe(url2);
		evictBlobUrls(result.stored.id);

		deleteQuick(result.stored.id);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/services/quickPuzzle/index.test.ts
```

Expected: FAIL with "Cannot find module './index'".

- [ ] **Step 3: Implement `index.ts`**

Create `apps/web/src/lib/services/quickPuzzle/index.ts`:

```ts
import type { PuzzlePiece } from '$lib/types/puzzle';

import { generateQuickPuzzle, type GenerateOptions } from './generator';
import { saveQuick, getQuick, listQuick as listQuickFromStorage, deleteQuick } from './storage';
import { getGridDimensions } from '@perseus/types';
import { TAB_RATIO } from '@perseus/types';
import { QUICK_PUZZLE_JPEG_QUALITY, type QuickPieceMeta, type StoredQuickPuzzle } from './types';
import {
	generateJigsawSvgMask,
	getTopEdge,
	getRightEdge,
	getBottomEdge,
	getLeftEdge
} from '@perseus/types';

export interface OpenedQuickPuzzle {
	stored: StoredQuickPuzzle;
	resolvePieceImage: (piece: Pick<PuzzlePiece | QuickPieceMeta, 'id'>) => string;
	resolveReferenceImage: () => string;
}

// Module-level caches:
//  - pieceUrlCache: puzzleId -> (pieceId -> object URL) — populated whenever piece bitmaps exist for this session.
//  - sessionOnlyMetadata: puzzleId -> StoredQuickPuzzle — for puzzles whose persist failed (quota), so the
//    play page can still find them via openQuick within the same session. Cleared when evictBlobUrls is called.
const pieceUrlCache = new Map<string, Map<number, string>>();
const sessionOnlyMetadata = new Map<string, StoredQuickPuzzle>();

function setCache(id: string, urls: Map<number, string>): void {
	const existing = pieceUrlCache.get(id);
	if (existing) {
		for (const url of existing.values()) URL.revokeObjectURL(url);
	}
	pieceUrlCache.set(id, urls);
}

export function evictBlobUrls(id: string): void {
	const urls = pieceUrlCache.get(id);
	if (urls) {
		for (const url of urls.values()) URL.revokeObjectURL(url);
		pieceUrlCache.delete(id);
	}
	sessionOnlyMetadata.delete(id);
}

function buildResolver(stored: StoredQuickPuzzle, urls: Map<number, string>) {
	return (piece: Pick<PuzzlePiece | QuickPieceMeta, 'id'>): string => {
		const url = urls.get(piece.id);
		if (!url) {
			throw new Error(`Quick puzzle ${stored.id} missing piece ${piece.id} in cache`);
		}
		return url;
	};
}

/**
 * Create + persist a new quick puzzle. Returns the stored record, whether it was
 * persisted to localStorage, and its in-memory piece blob-URL map (already cached).
 */
export async function createQuick(
	file: File,
	pieceCount: number,
	name: string,
	options: GenerateOptions = {}
): Promise<{ stored: StoredQuickPuzzle; persisted: boolean }> {
	const { stored, pieceBlobUrls } = await generateQuickPuzzle(file, pieceCount, name, options);
	setCache(stored.id, pieceBlobUrls);

	const { persisted } = saveQuick(stored);
	if (!persisted) {
		// Keep metadata in memory so openQuick can find this puzzle for the rest of the session.
		sessionOnlyMetadata.set(stored.id, stored);
	}
	return { stored, persisted };
}

/**
 * Re-open a stored quick puzzle. Returns null if not found or expired.
 * Lazily re-renders piece bitmaps from the stored data URL if the in-memory cache is empty.
 * Falls back to in-memory session-only metadata for puzzles that failed to persist.
 */
export async function openQuick(id: string): Promise<OpenedQuickPuzzle | null> {
	const stored = getQuick(id) ?? sessionOnlyMetadata.get(id) ?? null;
	if (!stored) return null;

	let urls = pieceUrlCache.get(id);
	if (!urls) {
		urls = await renderPiecesFromStored(stored);
		setCache(id, urls);
	}

	return {
		stored,
		resolvePieceImage: buildResolver(stored, urls),
		resolveReferenceImage: () => stored.imageDataUrl
	};
}

/**
 * Direct accessor for the reference image. Checks both persisted storage and the
 * session-only metadata cache.
 */
export function getReferenceImage(id: string): string | null {
	const stored = getQuick(id) ?? sessionOnlyMetadata.get(id) ?? null;
	return stored ? stored.imageDataUrl : null;
}

export function listQuick(): StoredQuickPuzzle[] {
	return listQuickFromStorage();
}

export function removeQuick(id: string): void {
	evictBlobUrls(id);
	deleteQuick(id);
}

// ---------------------------------------------------------------------------
// Lazy piece re-rendering (used on reopen)
// ---------------------------------------------------------------------------

async function renderPiecesFromStored(stored: StoredQuickPuzzle): Promise<Map<number, string>> {
	const bitmap = await loadDataUrlAsBitmap(stored.imageDataUrl);
	try {
		const urls = new Map<number, string>();
		for (const piece of stored.pieces) {
			const bounds = computePieceBoundsFromMeta(piece, stored);
			urls.set(piece.id, await renderPieceFromBitmap(bitmap, piece, bounds));
		}
		return urls;
	} finally {
		bitmap.close?.();
	}
}

async function loadDataUrlAsBitmap(dataUrl: string): Promise<ImageBitmap> {
	const res = await fetch(dataUrl);
	const blob = await res.blob();
	return createImageBitmap(blob);
}

interface PieceBounds {
	extractLeft: number;
	extractTop: number;
	extractWidth: number;
	extractHeight: number;
	targetWidth: number;
	targetHeight: number;
	offsetX: number;
	offsetY: number;
}

function computePieceBoundsFromMeta(piece: QuickPieceMeta, stored: StoredQuickPuzzle): PieceBounds {
	const rows = stored.gridRows;
	const cols = stored.gridCols;
	const srcW = stored.imageWidth;
	const srcH = stored.imageHeight;
	const row = piece.correctY;
	const col = piece.correctX;

	const basePieceWidth = Math.floor(srcW / cols);
	const extraWidth = srcW % cols;
	const basePieceHeight = Math.floor(srcH / rows);
	const extraHeight = srcH % rows;

	const baseWidth = basePieceWidth + (col === cols - 1 ? extraWidth : 0);
	const baseHeight = basePieceHeight + (row === rows - 1 ? extraHeight : 0);

	const overlapX = Math.floor(baseWidth * TAB_RATIO);
	const overlapY = Math.floor(baseHeight * TAB_RATIO);

	const targetWidth = baseWidth + 2 * overlapX;
	const targetHeight = baseHeight + 2 * overlapY;

	const baseLeft = col * basePieceWidth;
	const baseTop = row * basePieceHeight;
	const idealLeft = baseLeft - overlapX;
	const idealTop = baseTop - overlapY;

	const extractLeft = Math.max(0, idealLeft);
	const extractTop = Math.max(0, idealTop);
	const extractRight = Math.min(srcW, idealLeft + targetWidth);
	const extractBottom = Math.min(srcH, idealTop + targetHeight);

	const extractWidth = extractRight - extractLeft;
	const extractHeight = extractBottom - extractTop;
	const offsetX = extractLeft - idealLeft;
	const offsetY = extractTop - idealTop;

	return {
		extractLeft,
		extractTop,
		extractWidth,
		extractHeight,
		targetWidth,
		targetHeight,
		offsetX,
		offsetY
	};
}

async function renderPieceFromBitmap(
	source: ImageBitmap,
	piece: QuickPieceMeta,
	bounds: PieceBounds
): Promise<string> {
	const canvas = new OffscreenCanvas(bounds.targetWidth, bounds.targetHeight);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

	ctx.drawImage(
		source,
		bounds.extractLeft,
		bounds.extractTop,
		bounds.extractWidth,
		bounds.extractHeight,
		bounds.offsetX,
		bounds.offsetY,
		bounds.extractWidth,
		bounds.extractHeight
	);

	const svg = generateJigsawSvgMask(piece.edges, bounds.targetWidth, bounds.targetHeight);
	const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
	const maskImg = await new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load SVG mask'));
		img.src = url;
	});

	ctx.globalCompositeOperation = 'destination-in';
	ctx.drawImage(maskImg, 0, 0, bounds.targetWidth, bounds.targetHeight);
	ctx.globalCompositeOperation = 'source-over';

	const blob = await canvas.convertToBlob({ type: 'image/png' });
	return URL.createObjectURL(blob);
}
```

> Note on duplication: the bounds + render logic is intentionally repeated here to keep `generator.ts` focused on the create-from-File path. If a third caller appears, lift to a shared `pieceRendering.ts` then.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/services/quickPuzzle/index.test.ts
```

Expected: PASS for all index.ts cases.

- [ ] **Step 5: Run typecheck**

Run from monorepo root:

```bash
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/services/quickPuzzle/index.ts \
        apps/web/src/lib/services/quickPuzzle/index.test.ts
git commit -m "feat(web): add quick-puzzle public facade with blob URL cache"
```

---

## Task 7: Implement `lib/services/puzzleSource.ts`

Source-agnostic puzzle loader that the play page can use. Local first (for `q-`-prefixed IDs), falls through to the existing API for everything else.

**Files:**

- Create: `apps/web/src/lib/services/puzzleSource.ts`
- Create: `apps/web/src/lib/services/__tests__/puzzleSource.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/web/src/lib/services/__tests__/puzzleSource.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadPuzzleSource } from '../puzzleSource';

vi.mock('$lib/services/api', () => ({
	fetchPuzzle: vi.fn(),
	getPieceImageUrl: vi.fn(
		(puzzleId: string, pieceId: number) => `/api/puzzles/${puzzleId}/pieces/${pieceId}/image`
	),
	getReferenceImageUrl: vi.fn((puzzleId: string) => `/api/puzzles/${puzzleId}/reference`),
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public errorCode: string,
			message: string
		) {
			super(message);
		}
	}
}));

import * as api from '$lib/services/api';

describe('loadPuzzleSource', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	it('uses the API source for non-quick IDs', async () => {
		const fakePuzzle = {
			id: 'server-id',
			name: 'Server',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: 0,
			pieces: []
		};
		(api.fetchPuzzle as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePuzzle);

		const result = await loadPuzzleSource('server-id');
		expect(result.source).toBe('api');
		expect(result.puzzle).toEqual(fakePuzzle);
		expect(result.resolvePieceImage({ id: 1 } as never)).toContain(
			'/api/puzzles/server-id/pieces/1/image'
		);
		expect(result.resolveReferenceImage()).toContain('/api/puzzles/server-id/reference');
	});

	it('falls through to the API when local source returns null for a quick id', async () => {
		const fakePuzzle = {
			id: 'q-not-stored',
			name: 'Server-stored quick',
			pieceCount: 4,
			gridCols: 2,
			gridRows: 2,
			imageWidth: 100,
			imageHeight: 100,
			createdAt: 0,
			pieces: []
		};
		(api.fetchPuzzle as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePuzzle);

		const result = await loadPuzzleSource('q-not-stored');
		expect(result.source).toBe('api');
	});

	it('uses the local source for q- IDs that resolve via openQuick', async () => {
		const { createQuick } = await import('$lib/services/quickPuzzle');
		const canvas = new OffscreenCanvas(200, 200);
		canvas.getContext('2d')!.fillRect(0, 0, 200, 200);
		const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
		const file = new File([blob], 'a.jpg', { type: 'image/jpeg' });
		const created = await createQuick(file, 4, 'L');

		const result = await loadPuzzleSource(created.stored.id);
		expect(result.source).toBe('local');
		expect(result.puzzle.id).toBe(created.stored.id);
		expect(result.resolvePieceImage({ id: 0 } as never)).toMatch(/^blob:/);

		result.cleanup();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/services/__tests__/puzzleSource.test.ts
```

Expected: FAIL with "Cannot find module '../puzzleSource'".

- [ ] **Step 3: Implement `puzzleSource.ts`**

Create `apps/web/src/lib/services/puzzleSource.ts`:

```ts
import { fetchPuzzle, getPieceImageUrl, getReferenceImageUrl } from '$lib/services/api';
import { evictBlobUrls, openQuick } from '$lib/services/quickPuzzle';
import { QUICK_PUZZLE_ID_PREFIX } from '$lib/services/quickPuzzle/types';
import type { Puzzle, PuzzlePiece } from '$lib/types/puzzle';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';

export type PuzzleSourceKind = 'local' | 'api';

export interface LoadedPuzzleSource {
	puzzle: Puzzle;
	resolvePieceImage: (piece: Pick<PuzzlePiece, 'id'>) => string;
	resolveReferenceImage: () => string | null;
	source: PuzzleSourceKind;
	cleanup: () => void;
}

function storedToPuzzle(stored: StoredQuickPuzzle): Puzzle {
	return {
		id: stored.id,
		name: stored.name,
		pieceCount: stored.pieceCount,
		gridCols: stored.gridCols,
		gridRows: stored.gridRows,
		imageWidth: stored.imageWidth,
		imageHeight: stored.imageHeight,
		createdAt: stored.createdAt,
		pieces: stored.pieces.map((meta) => ({
			id: meta.id,
			puzzleId: stored.id,
			correctX: meta.correctX,
			correctY: meta.correctY,
			edges: meta.edges,
			imagePath: `pieces/${meta.id}.png`
		})),
		hasReference: true
	};
}

export async function loadPuzzleSource(id: string): Promise<LoadedPuzzleSource> {
	if (id.startsWith(QUICK_PUZZLE_ID_PREFIX)) {
		const opened = await openQuick(id);
		if (opened) {
			return {
				puzzle: storedToPuzzle(opened.stored),
				resolvePieceImage: opened.resolvePieceImage,
				resolveReferenceImage: opened.resolveReferenceImage,
				source: 'local',
				cleanup: () => evictBlobUrls(id)
			};
		}
		// fall through to API
	}

	const fetched = await fetchPuzzle(id);
	return {
		puzzle: fetched,
		resolvePieceImage: (piece) => getPieceImageUrl(fetched.id, piece.id),
		resolveReferenceImage: () =>
			fetched.hasReference === true ? getReferenceImageUrl(fetched.id) : null,
		source: 'api',
		cleanup: () => {
			/* no-op for API */
		}
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/services/__tests__/puzzleSource.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/services/puzzleSource.ts \
        apps/web/src/lib/services/__tests__/puzzleSource.test.ts
git commit -m "feat(web): add local-first puzzle source"
```

---

## Task 8: Refactor `PuzzlePiece.svelte` to take a `resolveImage` prop

Decouple the component from the API URL helper so it works with both server and local sources.

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`

- [ ] **Step 1: Update the failing tests first**

Read `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`. Wherever the test mocks `$lib/services/api` for `getPieceImageUrl`, replace those mocks with a `resolveImage` prop passed directly into `render(PuzzlePiece, { ... resolveImage: (piece) => '/test/' + piece.id + '.png' })`. Remove the `vi.mock('$lib/services/api', ...)` block. Update assertions that check the `<img src>` to expect `/test/<id>.png` instead.

(If the test file has many cases, copy the existing pattern: a single helper `const resolveImage = (p) => '/test/' + p.id + '.png'` defined at the top of the describe block, then passed into every `render()` call.)

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
```

Expected: FAIL with "PuzzlePiece does not accept prop resolveImage" or similar.

- [ ] **Step 3: Modify the component**

In `apps/web/src/lib/components/PuzzlePiece.svelte`:

- Remove the import line `import { getPieceImageUrl } from '$lib/services/api';`
- Add `resolveImage: (piece: PuzzlePiece) => string;` to the `Props` interface (required prop).
- In the `Props` destructure, add `resolveImage` to the list.
- Replace the single occurrence of `src={getPieceImageUrl(piece.puzzleId, piece.id)}` with `src={resolveImage(piece)}`.

The exact `Props` interface becomes:

```ts
interface Props {
	piece: PuzzlePiece;
	isPlaced: boolean;
	resolveImage: (piece: PuzzlePiece) => string;
	onDragStart?: (piece: PuzzlePiece) => void;
	onDragMove?: (piece: PuzzlePiece, x: number, y: number) => void;
	onDragEnd?: (piece: PuzzlePiece, x: number, y: number) => void;
	rotationEnabled?: boolean;
	rotation?: Rotation;
	onRotate?: (pieceId: number) => void;
}

let {
	piece,
	isPlaced,
	resolveImage,
	onDragStart,
	onDragMove,
	onDragEnd,
	rotationEnabled = false,
	rotation = 0,
	onRotate
}: Props = $props();
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/PuzzlePiece.svelte \
        apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts
git commit -m "refactor(web): pass resolveImage to PuzzlePiece via prop"
```

---

## Task 9: Refactor `PuzzleBoard.svelte` to take a `resolveImage` prop

Same pattern as Task 8.

**Files:**

- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`

- [ ] **Step 1: Update the failing tests**

Read `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`. Remove the `vi.mock('$lib/services/api', …)` for `getPieceImageUrl` (if present), and pass a `resolveImage` callback through the `render(PuzzleBoard, { … })` props. Update src-attribute assertions to use the test resolver's URL pattern.

- [ ] **Step 2: Run to verify failure**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Modify the component**

In `apps/web/src/lib/components/PuzzleBoard.svelte`:

- Remove `import { getPieceImageUrl } from '$lib/services/api';`.
- Add `resolveImage: (piece: PuzzlePiece) => string;` to `Props`.
- Add to the `let { ... }: Props = $props()` destructure.
- Replace `src={getPieceImageUrl(puzzle.id, placedPiece.id)}` (line ~180 in the `<img>` for placed pieces) with the resolved URL. Since the placed-piece block looks up the piece by id with `getPieceAtPosition`, swap the `<img>` line:

```svelte
<img
	src={resolveImage(getPieceAtPosition(x, y) ?? puzzle.pieces[0])}
	alt="Placed piece"
	class="h-full w-full"
/>
```

Wait — this is awkward because the existing template uses `placedPiece.id` (which references `placedPiece` which is the `PuzzlePiece`, not a `PlacedPiece`). Let me re-read.

Looking at PuzzleBoard.svelte:139, `placedPiece` here comes from `getPieceAtPosition(x, y)` and is typed `PuzzlePiece | undefined`. So `placedPiece` is the full piece object — the resolver call becomes:

```svelte
<img src={resolveImage(placedPiece)} alt="Placed piece" class="h-full w-full" />
```

Replace the existing `src={getPieceImageUrl(puzzle.id, placedPiece.id)}` with `src={resolveImage(placedPiece)}`.

- [ ] **Step 4: Run to verify pass**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/PuzzleBoard.svelte \
        apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts
git commit -m "refactor(web): pass resolveImage to PuzzleBoard via prop"
```

---

## Task 10: Refactor `ReferenceOverlay.svelte` to take an `imageUrl` prop

**Files:**

- Modify: `apps/web/src/lib/components/ReferenceOverlay.svelte`
- Modify: `apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts`

- [ ] **Step 1: Update the failing tests**

In `ReferenceOverlay.svelte.test.ts`:

- Remove the `vi.mock('$lib/services/api', …)` block.
- Replace every `render(ReferenceOverlay, { puzzleId: 'test-puzzle', active: true })` with `render(ReferenceOverlay, { imageUrl: '/api/puzzles/test-puzzle/reference', active: true })`.
- Update the inactive case similarly: `{ imageUrl: '/api/puzzles/test-puzzle/reference', active: false }`.
- The src-attribute assertions stay the same.

Also add a new test:

```ts
describe('when imageUrl is null', () => {
	it('renders the unavailable message', async () => {
		render(ReferenceOverlay, { imageUrl: null, active: true });
		const overlay = await page.getByTestId('reference-overlay').element();
		expect(overlay.textContent).toContain('Reference image unavailable');
	});
});
```

- [ ] **Step 2: Run the test to verify failure**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Modify the component**

Rewrite `apps/web/src/lib/components/ReferenceOverlay.svelte`:

```svelte
<script lang="ts">
	interface Props {
		imageUrl: string | null;
		active: boolean;
	}

	let { imageUrl, active }: Props = $props();
	let imageError = $state(false);

	$effect(() => {
		if (active) imageError = false;
	});
</script>

{#if active}
	<div
		data-testid="reference-overlay"
		class="pointer-events-none fixed inset-0 z-[1000] flex items-center justify-center bg-black/80"
	>
		{#if imageError || imageUrl === null}
			<p class="text-sm text-white/70">Reference image unavailable</p>
		{:else}
			<img
				src={imageUrl}
				alt="Puzzle reference"
				class="max-h-[90%] max-w-[90%] rounded-md object-contain shadow-lg"
				onerror={() => (imageError = true)}
			/>
		{/if}
	</div>
{/if}
```

- [ ] **Step 4: Run the test to verify pass**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/ReferenceOverlay.svelte \
        apps/web/src/lib/components/__tests__/ReferenceOverlay.svelte.test.ts
git commit -m "refactor(web): pass imageUrl to ReferenceOverlay via prop"
```

---

## Task 11: Refactor `/puzzle/[id]/+page.svelte` to use `puzzleSource`

The play page no longer calls `fetchPuzzle` or any API URL helper directly. It loads via `puzzleSource` and plumbs the resolvers down to `PuzzleBoard`, `PuzzlePiece`, and `ReferenceOverlay`.

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`

- [ ] **Step 1: Replace the API import and load call**

In `apps/web/src/routes/puzzle/[id]/+page.svelte`:

- Replace:

  ```ts
  import { fetchPuzzle, ApiError } from '$lib/services/api';
  ```

  with:

  ```ts
  import { ApiError } from '$lib/services/api';
  import { loadPuzzleSource, type LoadedPuzzleSource } from '$lib/services/puzzleSource';
  ```

- Add a new state holder near the other `$state(...)` declarations:

  ```ts
  let puzzleSource: LoadedPuzzleSource | null = $state(null);
  ```

- In `loadPuzzle(id)`, replace `const loadedPuzzle = await fetchPuzzle(id);` with:

  ```ts
  // Clean up any prior source's blob URLs before loading a new one.
  if (puzzleSource) {
  	puzzleSource.cleanup();
  	puzzleSource = null;
  }
  const source = await loadPuzzleSource(id);
  if (requestId !== activeLoadRequestId) {
  	source.cleanup();
  	return;
  }
  const loadedPuzzle = source.puzzle;
  puzzleSource = source;
  ```

- In `onDestroy`, before `clearSelectedPiece()`, add:

  ```ts
  if (puzzleSource) {
  	puzzleSource.cleanup();
  	puzzleSource = null;
  }
  ```

- [ ] **Step 2: Plumb resolvers into the template**

In the same file's template:

- The existing `<ReferenceOverlay puzzleId={currentPuzzle.id} active={showReferenceOverlay} />` becomes:

  ```svelte
  <ReferenceOverlay
  	imageUrl={puzzleSource?.resolveReferenceImage() ?? null}
  	active={showReferenceOverlay}
  />
  ```

- The `<PuzzleBoard ... />` invocation gains a prop. Add `resolveImage={puzzleSource!.resolvePieceImage}` to the props passed to `<PuzzleBoard>` (alongside the existing `puzzle`, `placedPieces`, etc.). The non-null assertion is safe because the template only renders this block when `puzzle` is set, which means `puzzleSource` is also set.

- The `<PuzzlePiece ... />` invocation in the inventory loop gains the same prop:

  ```svelte
  <PuzzlePiece
  	{piece}
  	resolveImage={puzzleSource!.resolvePieceImage}
  	isPlaced={false}
  	{rotationEnabled}
  	rotation={getDisplayedRotation(piece.id)}
  	onRotate={handlePieceRotate}
  />
  ```

- [ ] **Step 3: Run typecheck and existing tests**

Run from monorepo root:

```bash
bun run check --filter=@perseus/web && cd apps/web && bun run test:unit -- src/lib/components/__tests__
```

Expected: PASS.

- [ ] **Step 4: Run e2e to confirm the existing puzzle flow still works**

Run:

```bash
cd apps/web && bun run test:e2e -- puzzle-solving.spec.ts
```

Expected: PASS (no regressions in existing API-source flow).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/puzzle/[id]/+page.svelte
git commit -m "refactor(web): load play page via puzzleSource"
```

---

## Task 12: Build `QuickPuzzleUploader.svelte`

Form: file input (auto-fills name from filename), name input, piece-count number input, submit button, determinate progress bar during generation.

**Files:**

- Create: `apps/web/src/lib/components/QuickPuzzleUploader.svelte`
- Create: `apps/web/src/lib/components/__tests__/QuickPuzzleUploader.svelte.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/components/__tests__/QuickPuzzleUploader.svelte.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import QuickPuzzleUploader from '../QuickPuzzleUploader.svelte';

function makeFile(name: string, type: string, sizeBytes = 100): File {
	return new File([new Uint8Array(sizeBytes)], name, { type });
}

describe('QuickPuzzleUploader', () => {
	it('disables submit until a file is selected', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const submit = page.getByRole('button', { name: /create puzzle/i });
		await expect.element(submit).toBeDisabled();
	});

	it('auto-fills name from filename', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabel(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('beach.jpg', 'image/jpeg')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const nameInput = page.getByLabel(/name/i);
		await expect.element(nameInput).toHaveValue('beach');
	});

	it('shows inline error for unsupported MIME', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabel(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('a.gif', 'image/gif')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(page.getByText(/JPEG, PNG, or WebP/)).toBeInTheDocument();
	});

	it('shows inline error for files > 20 MB', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabel(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([
			makeFile('big.jpg', 'image/jpeg', 21 * 1024 * 1024)
		]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(page.getByText(/max 20 MB/i)).toBeInTheDocument();
	});

	it('rejects piece counts outside 4–100', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		// Set a valid file first
		const fileInput = await page.getByLabel(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('a.jpg', 'image/jpeg')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const pieceInput = await page.getByLabel(/pieces/i).element();
		(pieceInput as HTMLInputElement).value = '3';
		(pieceInput as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));

		const submit = page.getByRole('button', { name: /create puzzle/i });
		await submit.click();
		expect(onSubmit).not.toHaveBeenCalled();
		await expect.element(page.getByText(/between 4 and 100/i)).toBeInTheDocument();
	});

	it('calls onSubmit with file + pieceCount + name', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		const file = makeFile('forest.jpg', 'image/jpeg');
		const fileInput = await page.getByLabel(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([file]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const submit = page.getByRole('button', { name: /create puzzle/i });
		await submit.click();
		expect(onSubmit).toHaveBeenCalledWith({
			file,
			pieceCount: 24,
			name: 'forest'
		});
	});
});

function makeFileList(files: File[]): FileList {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	return dt.files;
}
```

- [ ] **Step 2: Run to verify failure**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/QuickPuzzleUploader.svelte.test.ts
```

Expected: FAIL with "Cannot find module '../QuickPuzzleUploader.svelte'".

- [ ] **Step 3: Implement the component**

Create `apps/web/src/lib/components/QuickPuzzleUploader.svelte`:

```svelte
<script lang="ts">
	import {
		QUICK_PUZZLE_ALLOWED_MIMES,
		QUICK_PUZZLE_DEFAULT_PIECES,
		QUICK_PUZZLE_MAX_PIECES,
		QUICK_PUZZLE_MAX_UPLOAD_BYTES,
		QUICK_PUZZLE_MIN_PIECES
	} from '$lib/services/quickPuzzle/types';

	interface SubmitArgs {
		file: File;
		pieceCount: number;
		name: string;
	}

	interface Props {
		onSubmit: (args: SubmitArgs) => void;
		busy?: boolean;
		progress?: { done: number; total: number } | null;
	}

	let { onSubmit, busy = false, progress = null }: Props = $props();

	let file: File | null = $state(null);
	let name = $state('');
	let pieceCount = $state(QUICK_PUZZLE_DEFAULT_PIECES);
	let error = $state<string | null>(null);

	function deriveName(filename: string): string {
		const dot = filename.lastIndexOf('.');
		const stem = dot > 0 ? filename.slice(0, dot) : filename;
		return stem.slice(0, 80);
	}

	function handleFileChange(event: Event) {
		error = null;
		const target = event.target as HTMLInputElement;
		const next = target.files?.item(0) ?? null;
		if (!next) {
			file = null;
			return;
		}

		const mime = next.type.toLowerCase();
		if (!(QUICK_PUZZLE_ALLOWED_MIMES as readonly string[]).includes(mime)) {
			file = null;
			error = 'Please choose a JPEG, PNG, or WebP image.';
			return;
		}
		if (next.size > QUICK_PUZZLE_MAX_UPLOAD_BYTES) {
			file = null;
			error = 'Image too large (max 20 MB).';
			return;
		}

		file = next;
		if (!name) name = deriveName(next.name);
	}

	function handlePieceInput(event: Event) {
		const target = event.target as HTMLInputElement;
		const parsed = Number.parseInt(target.value, 10);
		pieceCount = Number.isFinite(parsed) ? parsed : 0;
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		error = null;

		if (!file) {
			error = 'Please choose an image.';
			return;
		}
		if (
			!Number.isInteger(pieceCount) ||
			pieceCount < QUICK_PUZZLE_MIN_PIECES ||
			pieceCount > QUICK_PUZZLE_MAX_PIECES
		) {
			error = `Choose between ${QUICK_PUZZLE_MIN_PIECES} and ${QUICK_PUZZLE_MAX_PIECES} pieces.`;
			return;
		}

		onSubmit({ file, pieceCount, name: name.trim() || deriveName(file.name) });
	}

	const progressPct = $derived(
		progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
	);
</script>

<form class="quick-uploader space-y-4" onsubmit={handleSubmit} data-testid="quick-uploader">
	<label class="block text-sm">
		<span class="mb-1 block text-(--text-2)">Image</span>
		<input
			type="file"
			accept="image/jpeg,image/png,image/webp"
			onchange={handleFileChange}
			disabled={busy}
			data-testid="quick-uploader-file"
		/>
	</label>

	<label class="block text-sm">
		<span class="mb-1 block text-(--text-2)">Name</span>
		<input
			type="text"
			class="w-full rounded border border-(--border) bg-(--bg-1) p-2 text-(--text-0)"
			bind:value={name}
			maxlength="80"
			disabled={busy}
			data-testid="quick-uploader-name"
		/>
	</label>

	<label class="block text-sm">
		<span class="mb-1 block text-(--text-2)">Pieces</span>
		<input
			type="number"
			class="w-full rounded border border-(--border) bg-(--bg-1) p-2 text-(--text-0)"
			min={QUICK_PUZZLE_MIN_PIECES}
			max={QUICK_PUZZLE_MAX_PIECES}
			value={pieceCount}
			oninput={handlePieceInput}
			disabled={busy}
			data-testid="quick-uploader-pieces"
		/>
	</label>

	{#if error}
		<p class="text-sm text-(--hot)" data-testid="quick-uploader-error">{error}</p>
	{/if}

	{#if busy && progress}
		<div class="space-y-1" data-testid="quick-uploader-progress">
			<div class="h-1 w-full overflow-hidden rounded bg-(--bg-3)">
				<div class="h-full bg-(--accent) transition-[width]" style="width: {progressPct}%;"></div>
			</div>
			<p class="text-xs text-(--text-2)">
				Generating piece {progress.done} / {progress.total}…
			</p>
		</div>
	{/if}

	<button
		type="submit"
		class="arcade-btn w-full"
		disabled={busy || !file}
		data-testid="quick-uploader-submit"
	>
		{busy ? 'Generating…' : 'Create Puzzle'}
	</button>
</form>
```

- [ ] **Step 4: Run the tests to verify pass**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/QuickPuzzleUploader.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/QuickPuzzleUploader.svelte \
        apps/web/src/lib/components/__tests__/QuickPuzzleUploader.svelte.test.ts
git commit -m "feat(web): add QuickPuzzleUploader component"
```

---

## Task 13: Build `QuickPuzzleList.svelte`

Lists saved quick puzzles with thumbnails (data URL), name, age, piece count, delete button.

**Files:**

- Create: `apps/web/src/lib/components/QuickPuzzleList.svelte`
- Create: `apps/web/src/lib/components/__tests__/QuickPuzzleList.svelte.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/components/__tests__/QuickPuzzleList.svelte.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import QuickPuzzleList from '../QuickPuzzleList.svelte';
import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';

function makeStored(overrides: Partial<StoredQuickPuzzle> = {}): StoredQuickPuzzle {
	return {
		id: 'q-a',
		name: 'Test',
		pieceCount: 24,
		gridRows: 4,
		gridCols: 6,
		imageWidth: 100,
		imageHeight: 100,
		imageDataUrl: 'data:image/jpeg;base64,/9j/AAAA',
		pieces: [],
		createdAt: Date.now(),
		schemaVersion: 1,
		...overrides
	};
}

describe('QuickPuzzleList', () => {
	it('renders empty state when list is empty', async () => {
		render(QuickPuzzleList, { puzzles: [], onDelete: vi.fn() });
		await expect.element(page.getByTestId('quick-list-empty')).toBeInTheDocument();
	});

	it('renders one row per puzzle with name and piece count', async () => {
		render(QuickPuzzleList, {
			puzzles: [
				makeStored({ id: 'q-a', name: 'Beach' }),
				makeStored({ id: 'q-b', name: 'Forest', pieceCount: 48 })
			],
			onDelete: vi.fn()
		});
		await expect.element(page.getByText('Beach')).toBeInTheDocument();
		await expect.element(page.getByText('Forest')).toBeInTheDocument();
		await expect.element(page.getByText('24 pieces')).toBeInTheDocument();
		await expect.element(page.getByText('48 pieces')).toBeInTheDocument();
	});

	it('uses imageDataUrl for the thumbnail', async () => {
		render(QuickPuzzleList, {
			puzzles: [makeStored({ imageDataUrl: 'data:image/jpeg;base64,XYZ' })],
			onDelete: vi.fn()
		});
		const thumbnail = await page.getByTestId('quick-list-thumb-q-a').element();
		expect((thumbnail as HTMLImageElement).src).toContain('data:image/jpeg;base64,XYZ');
	});

	it('calls onDelete when the delete button is clicked', async () => {
		const onDelete = vi.fn();
		render(QuickPuzzleList, { puzzles: [makeStored({ id: 'q-x' })], onDelete });
		await page.getByTestId('quick-list-delete-q-x').click();
		expect(onDelete).toHaveBeenCalledWith('q-x');
	});

	it('row has a link to /puzzle/<id>', async () => {
		render(QuickPuzzleList, { puzzles: [makeStored({ id: 'q-link' })], onDelete: vi.fn() });
		const link = await page.getByTestId('quick-list-link-q-link').element();
		expect((link as HTMLAnchorElement).getAttribute('href')).toContain('/puzzle/q-link');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/QuickPuzzleList.svelte.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/lib/components/QuickPuzzleList.svelte`:

```svelte
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';

	interface Props {
		puzzles: StoredQuickPuzzle[];
		onDelete: (id: string) => void;
	}

	let { puzzles, onDelete }: Props = $props();

	const relativeFormatter =
		typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl
			? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
			: null;

	function formatAge(createdAt: number): string {
		const ms = Date.now() - createdAt;
		const minutes = Math.round(ms / 60_000);
		const hours = Math.round(ms / 3_600_000);
		const days = Math.round(ms / 86_400_000);

		if (!relativeFormatter) {
			if (days >= 1) return `${days}d ago`;
			if (hours >= 1) return `${hours}h ago`;
			return `${Math.max(1, minutes)}m ago`;
		}

		if (days >= 1) return relativeFormatter.format(-days, 'day');
		if (hours >= 1) return relativeFormatter.format(-hours, 'hour');
		return relativeFormatter.format(-Math.max(1, minutes), 'minute');
	}
</script>

{#if puzzles.length === 0}
	<p
		class="rounded border border-(--border) p-6 text-center text-sm text-(--text-2)"
		data-testid="quick-list-empty"
	>
		Upload an image to create your first quick puzzle. Stays on your device for 7 days, max 5.
	</p>
{:else}
	<ul class="space-y-2" data-testid="quick-list">
		{#each puzzles as puzzle (puzzle.id)}
			<li
				class="flex items-center gap-3 rounded border border-(--border) bg-(--bg-1) p-3"
				data-testid={`quick-list-row-${puzzle.id}`}
			>
				<a
					href={resolve(`/puzzle/${puzzle.id}`)}
					class="flex flex-1 items-center gap-3"
					data-testid={`quick-list-link-${puzzle.id}`}
				>
					<img
						src={puzzle.imageDataUrl}
						alt=""
						class="h-12 w-12 rounded object-cover"
						data-testid={`quick-list-thumb-${puzzle.id}`}
					/>
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium text-(--text-0)">{puzzle.name}</div>
						<div class="text-xs text-(--text-2)">
							{puzzle.pieceCount} pieces · {formatAge(puzzle.createdAt)}
						</div>
					</div>
				</a>
				<button
					type="button"
					class="rounded border border-(--border) px-2 py-1 text-xs text-(--text-2) hover:text-(--hot)"
					onclick={() => onDelete(puzzle.id)}
					aria-label={`Delete ${puzzle.name}`}
					data-testid={`quick-list-delete-${puzzle.id}`}
				>
					Delete
				</button>
			</li>
		{/each}
	</ul>
{/if}
```

- [ ] **Step 4: Run the tests to verify pass**

Run:

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/QuickPuzzleList.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/QuickPuzzleList.svelte \
        apps/web/src/lib/components/__tests__/QuickPuzzleList.svelte.test.ts
git commit -m "feat(web): add QuickPuzzleList component"
```

---

## Task 14: Build the `/quick` route

Glue page: uploader on top, list below, redirect to `/puzzle/<id>` on success.

**Files:**

- Create: `apps/web/src/routes/quick/+page.svelte`
- Create: `apps/web/src/routes/quick/+page.ts`

- [ ] **Step 1: Add `+page.ts` to mark the route prerenderable**

Create `apps/web/src/routes/quick/+page.ts`:

```ts
export const prerender = true;
```

- [ ] **Step 2: Create the page**

Create `apps/web/src/routes/quick/+page.svelte`:

```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import QuickPuzzleUploader from '$lib/components/QuickPuzzleUploader.svelte';
	import QuickPuzzleList from '$lib/components/QuickPuzzleList.svelte';
	import { createQuick, listQuick, removeQuick } from '$lib/services/quickPuzzle';
	import type { StoredQuickPuzzle } from '$lib/services/quickPuzzle/types';

	let puzzles: StoredQuickPuzzle[] = $state([]);
	let busy = $state(false);
	let progress: { done: number; total: number } | null = $state(null);
	let toast: string | null = $state(null);

	function refresh() {
		puzzles = listQuick();
	}

	$effect(() => {
		refresh();
	});

	async function handleSubmit({
		file,
		pieceCount,
		name
	}: {
		file: File;
		pieceCount: number;
		name: string;
	}) {
		busy = true;
		toast = null;
		progress = { done: 0, total: pieceCount };
		try {
			const result = await createQuick(file, pieceCount, name, {
				onProgress: (done, total) => {
					progress = { done, total };
				}
			});
			refresh();
			if (!result.persisted) {
				// Session-only fallback: surface the toast briefly before navigating away,
				// since the /quick page unmounts on goto.
				toast = 'Storage full — this puzzle will only last for this session.';
				await new Promise((r) => setTimeout(r, 1500));
			}
			await goto(resolve(`/puzzle/${result.stored.id}`));
		} catch (err) {
			console.error('Quick puzzle generation failed:', err);
			toast =
				err instanceof Error
					? err.message
					: "Couldn't generate puzzle. Try fewer pieces or a smaller image.";
		} finally {
			busy = false;
			progress = null;
		}
	}

	function handleDelete(id: string) {
		removeQuick(id);
		refresh();
	}
</script>

<svelte:head>
	<title>Quick Puzzle | Perseus Arcade</title>
</svelte:head>

<div class="mx-auto max-w-(--breakpoint-md) px-6 py-10">
	<header class="mb-6">
		<a
			class="text-xs text-(--text-2) hover:text-(--accent)"
			href={resolve('/')}
			data-testid="quick-back-link"
		>
			← Back to arcade
		</a>
		<h1 class="mt-2 text-2xl font-bold text-(--text-0)">Quick Puzzle</h1>
		<p class="mt-1 text-sm text-(--text-2)">
			Upload an image to play it as a jigsaw puzzle. Stays on your device only.
		</p>
	</header>

	<section class="mb-8">
		<QuickPuzzleUploader onSubmit={handleSubmit} {busy} {progress} />
		{#if toast}
			<p class="mt-3 text-sm text-(--accent)" data-testid="quick-toast">{toast}</p>
		{/if}
	</section>

	<section>
		<h2 class="mb-3 text-sm font-semibold tracking-wider text-(--text-2) uppercase">
			My Quick Puzzles
		</h2>
		<QuickPuzzleList {puzzles} onDelete={handleDelete} />
	</section>
</div>
```

- [ ] **Step 3: Confirm typecheck and svelte-kit sync are happy**

Run from monorepo root:

```bash
bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 4: Manually smoke-test the page**

Run:

```bash
cd apps/web && bun run dev
```

In a browser, navigate to `http://localhost:4692/quick`. Confirm:

- Upload form renders.
- Selecting a small JPEG → name auto-fills.
- Submit → progress bar shows → redirected to `/puzzle/q-…`.
- Pieces render in the inventory; can drag one onto its correct cell.
- Reload `/puzzle/q-…` → still works (pieces re-render).
- Navigate back to `/quick` → list shows the puzzle.
- Click Delete → row disappears.

If anything fails, use the browser console + svelte devtools to diagnose.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/quick/+page.svelte \
        apps/web/src/routes/quick/+page.ts
git commit -m "feat(web): add /quick page for browser-side puzzles"
```

---

## Task 15: Add Quick Puzzle link to the home page header

The shared `+layout.svelte` is empty; the home page (`/`) is the natural entry surface. Add a small link in the existing home-page header.

**Files:**

- Modify: `apps/web/src/routes/+page.svelte`

- [ ] **Step 1: Add the link**

In `apps/web/src/routes/+page.svelte`, locate the `<div class="flex flex-col items-end gap-[0.3rem] text-right ...">` block (near line 168 in the original file). Inside that block, immediately after the `<span>SELECT YOUR MISSION</span>` (line 174), add a new link:

```svelte
<a
	href={resolve('/quick')}
	class="text-[0.65rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-80 hover:opacity-100"
	data-testid="quick-puzzle-link"
>
	→ QUICK PUZZLE
</a>
```

(The `resolve` helper is already imported at the top of the file.)

- [ ] **Step 2: Confirm the home-page test still passes**

Run:

```bash
cd apps/web && bun run test:unit -- src/routes/page.svelte.test.ts src/routes/page.svelte.spec.ts
```

Expected: PASS. If a test asserts on header content shape and breaks, update it to also expect the new link.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/+page.svelte
git commit -m "feat(web): add Quick Puzzle link to home page header"
```

---

## Task 16: E2E test for the quick-puzzle flow

Smoke-test the full path: upload → play → reload → return to list → delete → 404.

**Files:**

- Create: `apps/web/e2e/fixtures/test-image.jpg` (a 200×200 JPEG, ~5 KB)
- Create: `apps/web/e2e/quick-puzzle.spec.ts`

- [ ] **Step 1: Generate and commit the fixture image**

The fixture is generated programmatically via Node with the built-in `Buffer`. Run this from the monorepo root (one-shot script — does not need to live in the repo):

```bash
bun run -e '
const fs = require("node:fs");
// 200x200 solid red JPEG, base64 from a hand-crafted minimal file.
// Generated via canvas in browser; here we just inline a known-small JPEG.
// Use Bun's built-in Image API instead:
const { Buffer } = require("node:buffer");
const buf = Buffer.from(
	"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCADIAMgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAAH/2Q==",
	"base64"
);
fs.mkdirSync("apps/web/e2e/fixtures", { recursive: true });
fs.writeFileSync("apps/web/e2e/fixtures/test-image.jpg", buf);
console.log("Wrote", buf.length, "bytes to apps/web/e2e/fixtures/test-image.jpg");
'
```

If the inlined base64 above is malformed in your environment, alternative: open `http://localhost:4692/`, run this in the browser console to generate a 200×200 JPEG and download it:

```js
const c = new OffscreenCanvas(200, 200);
const ctx = c.getContext('2d');
ctx.fillStyle = '#ff8800';
ctx.fillRect(0, 0, 200, 200);
ctx.fillStyle = '#0088ff';
ctx.fillRect(50, 50, 100, 100);
const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'test-image.jpg';
a.click();
```

Move the downloaded `test-image.jpg` to `apps/web/e2e/fixtures/test-image.jpg`.

- [ ] **Step 2: Write the e2e spec**

Create `apps/web/e2e/quick-puzzle.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import path from 'node:path';

const FIXTURE = path.join(__dirname, 'fixtures', 'test-image.jpg');

test.describe('Quick puzzle', () => {
	test.beforeEach(async ({ page }) => {
		// Pristine localStorage per test. Visiting any same-origin page first lets
		// us call clear() before the route under test runs.
		await page.goto('/');
		await page.evaluate(() => localStorage.clear());
	});

	test('upload → redirect → play → list → delete → 404', async ({ page }) => {
		await page.goto('/quick');

		// 1. Upload + submit
		await page.getByTestId('quick-uploader-file').setInputFiles(FIXTURE);
		await expect(page.getByTestId('quick-uploader-name')).toHaveValue('test-image');
		await page.getByTestId('quick-uploader-pieces').fill('4');
		await page.getByTestId('quick-uploader-submit').click();

		// 2. Redirect to play page
		await page.waitForURL(/\/puzzle\/q-/, { timeout: 10_000 });
		const url = page.url();
		const id = url.match(/\/puzzle\/(q-[\w-]+)/)![1];
		await expect(page.getByTestId('puzzle-board')).toBeVisible();

		// Inventory has 4 pieces
		const inventoryPieces = page.getByTestId('puzzle-piece');
		await expect(inventoryPieces).toHaveCount(4);

		// 3. Reload still works (pieces re-render)
		await page.reload();
		await expect(page.getByTestId('puzzle-board')).toBeVisible();
		await expect(page.getByTestId('puzzle-piece')).toHaveCount(4);

		// 4. Back to /quick: list shows the puzzle
		await page.goto('/quick');
		await expect(page.getByTestId(`quick-list-row-${id}`)).toBeVisible();

		// 5. Delete it
		await page.getByTestId(`quick-list-delete-${id}`).click();
		await expect(page.getByTestId(`quick-list-row-${id}`)).toHaveCount(0);

		// 6. Navigating back to /puzzle/<id> shows 404 path
		await page.goto(`/puzzle/${id}`);
		// The play page falls through to the API for unknown ids; on a static deploy
		// or local dev where the API has no record, the user sees the existing error UI.
		await expect(
			page.getByText(/Mission no longer available|Failed to load mission/i)
		).toBeVisible();
	});
});
```

- [ ] **Step 3: Run the e2e suite**

Run from `apps/web`:

```bash
bun run test:e2e -- quick-puzzle.spec.ts
```

Expected: PASS.

If the test relies on the API being unreachable for the final 404 step and that fails because the API is actually running and matches non-existent IDs differently, adjust the assertion to whichever copy the play page renders for a missing ID (`Mission no longer available` for a 404 from API, `Failed to load mission` for other errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/fixtures/test-image.jpg apps/web/e2e/quick-puzzle.spec.ts
git commit -m "test(web): add e2e for quick puzzle upload + play + delete"
```

---

## Task 17: Final verification + lint pass

Catch any issue introduced by cumulative changes.

- [ ] **Step 1: Run the full check + lint + test suite**

From the monorepo root:

```bash
bun run check && bun run lint && bun run test:unit
```

Expected: all green across `@perseus/types`, `@perseus/api`, `@perseus/workflows`, `@perseus/web`.

- [ ] **Step 2: Run e2e**

Run:

```bash
cd apps/web && bun run test:e2e
```

Expected: all e2e specs pass (gallery, puzzle-solving, quick-puzzle).

- [ ] **Step 3: Manual smoke check**

Run `bun run dev` from monorepo root. In the browser:

- `/` → header has "→ QUICK PUZZLE" link.
- `/quick` → upload a real photo, generate a 24-piece puzzle.
- Place a couple pieces, reload the puzzle page mid-game (progress restores via the existing `progress.ts`).
- Generate a 6th puzzle to verify silent eviction.
- Verify no console errors.

- [ ] **Step 4: Final commit if anything was touched during smoke check**

If the smoke check uncovered no code changes, skip. Otherwise:

```bash
git add <changed files>
git commit -m "fix: <specific tweak from smoke check>"
```

---

## Self-review notes (writer)

Before handing off:

- **Spec coverage:** every section of the spec maps to a task above:
  - Architecture file layout → Tasks 1–7, 12–14.
  - Shared geometry move → Tasks 1, 2.
  - Data model → Task 3 (types) + Task 4 (storage).
  - Generation pipeline → Task 5.
  - In-memory piece cache → Task 6.
  - Routing & data flow → Tasks 7 (puzzleSource), 11 (play page), 14 (/quick page), 15 (header link).
  - Component prop changes → Tasks 8, 9, 10.
  - Lifecycle, eviction & expiry → Task 4.
  - Error handling → Tasks 4 (storage), 5 (generator), 12 (uploader inline errors), 14 (toast).
  - Testing strategy → Tasks 1–13 (unit + component), 16 (e2e).
  - Build sequence → matches Task ordering.
- **No placeholders:** every step contains exact files, exact code, exact commands, expected output.
- **Type consistency:** `resolveImage` is the consistent prop name across `PuzzlePiece`, `PuzzleBoard`; `loadPuzzleSource` returns `LoadedPuzzleSource` everywhere; the storage layer's exports (`saveQuick`, `getQuick`, `listQuick`, `deleteQuick`) line up with the index.ts facade's calls. The `QUICK_PUZZLE_*` constants are defined once in `types.ts` and imported elsewhere.
