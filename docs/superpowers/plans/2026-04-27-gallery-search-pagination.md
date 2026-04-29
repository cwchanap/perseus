# Gallery Search & Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side text search (by puzzle name) and infinite scroll pagination (20 per page) to the public gallery, completing PRD Requirement 1.

**Architecture:** The Worker fetches all puzzle summaries from KV, filters and paginates in memory, and returns `{ puzzles, total, offset, limit }`. The web client debounces search input, resets on filter change, and auto-loads the next page via `IntersectionObserver` when a sentinel element enters the viewport.

**Tech Stack:** Hono (Worker route), Cloudflare KV, SvelteKit + Svelte 5 runes, Vitest browser-mode, Playwright E2E

**Spec:** `docs/superpowers/specs/2026-04-27-gallery-search-pagination-design.md`

---

## File Map

| Action | File                                                             | Responsibility                                         |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------ |
| Modify | `packages/types/src/index.ts`                                    | Add `total`, `offset`, `limit` to `PuzzleListResponse` |
| Modify | `apps/api/src/types/index.ts`                                    | Same update for Bun-local `PuzzleListResponse`         |
| Modify | `apps/api/src/services/storage.worker.ts`                        | Add `listPuzzlesPage`                                  |
| Modify | `apps/api/src/services/storage.worker.test.ts`                   | Tests for `listPuzzlesPage`                            |
| Modify | `apps/api/src/routes/puzzles.worker.ts`                          | Parse query params, call `listPuzzlesPage`             |
| Modify | `apps/api/src/routes/__tests__/puzzles.worker.test.ts`           | Update list tests, add param tests                     |
| Modify | `apps/api/src/services/storage.ts`                               | Add `listPuzzlesPage` (Bun parity)                     |
| Modify | `apps/api/src/services/storage.test.ts`                          | Tests for Bun `listPuzzlesPage`                        |
| Modify | `apps/api/src/routes/puzzles.ts`                                 | Bun route update                                       |
| Modify | `apps/api/src/routes/puzzles.test.ts`                            | Update Bun list tests                                  |
| Modify | `apps/web/src/lib/services/api.ts`                               | Update `fetchPuzzles` signature + return type          |
| Modify | `apps/web/src/lib/services/__tests__/api.test.ts`                | Update `fetchPuzzles` tests                            |
| Create | `apps/web/src/lib/components/SearchBar.svelte`                   | Controlled search input, arcade-styled                 |
| Create | `apps/web/src/lib/components/__tests__/SearchBar.svelte.test.ts` | Component tests                                        |
| Modify | `apps/web/src/routes/+page.svelte`                               | Add search state, debounce, infinite scroll            |
| Create | `apps/web/src/routes/page.svelte.test.ts`                        | Gallery page unit tests                                |
| Modify | `apps/web/e2e/gallery.spec.ts`                                   | Update mock shape, add search + scroll tests           |

---

## Task 1: Update `PuzzleListResponse` types

**Files:**

- Modify: `packages/types/src/index.ts`
- Modify: `apps/api/src/types/index.ts`

- [ ] **Step 1: Update shared `PuzzleListResponse` in `packages/types/src/index.ts`**

Replace lines 96–98:

```ts
export interface PuzzleListResponse {
	puzzles: PuzzleSummary[];
	total: number;
	offset: number;
	limit: number;
}
```

- [ ] **Step 2: Update Bun-local `PuzzleListResponse` in `apps/api/src/types/index.ts`**

Replace lines 64–66:

```ts
export interface PuzzleListResponse {
	puzzles: PuzzleSummary[];
	total: number;
	offset: number;
	limit: number;
}
```

- [ ] **Step 3: Run type check to confirm no regressions**

```bash
cd /path/to/repo && bun run check
```

Expected: type errors only in files that still return the old shape (routes/api client) — those are fixed in later tasks. Zero errors in `packages/types`.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/index.ts apps/api/src/types/index.ts
git commit -m "feat: add total/offset/limit to PuzzleListResponse"
```

---

## Task 2: Add `listPuzzlesPage` to Worker storage (TDD)

**Files:**

- Modify: `apps/api/src/services/storage.worker.test.ts`
- Modify: `apps/api/src/services/storage.worker.ts`

- [ ] **Step 1: Write failing tests — add this block at the end of `storage.worker.test.ts`**

```ts
import {
	// existing imports …
	listPuzzlesPage
} from './storage.worker';

// add inside the file, after existing describe blocks:

describe('listPuzzlesPage', () => {
	function makeReadyPuzzle(overrides: Partial<PuzzleMetadata> = {}): PuzzleMetadata {
		return {
			id: 'p-default',
			name: 'Test Puzzle',
			pieceCount: 225,
			gridCols: 15,
			gridRows: 15,
			imageWidth: 1000,
			imageHeight: 800,
			createdAt: 1000,
			status: 'ready',
			version: 0,
			pieces: [],
			...overrides
		} as PuzzleMetadata;
	}

	it('returns empty result when no puzzles exist', async () => {
		const kv = createMockKV();
		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			offset: 0,
			limit: 20
		});
		expect(result).toEqual({ puzzles: [], total: 0, offset: 0, limit: 20 });
	});

	it('excludes non-ready puzzles', async () => {
		const kv = createMockKV();
		kv._store.set('puzzle:r1', JSON.stringify(makeReadyPuzzle({ id: 'r1', status: 'ready' })));
		kv._store.set(
			'puzzle:p1',
			JSON.stringify(
				makeReadyPuzzle({
					id: 'p1',
					status: 'processing',
					progress: { totalPieces: 225, generatedPieces: 0, updatedAt: 0 }
				} as unknown as PuzzleMetadata)
			)
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 0, limit: 20 });
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('r1');
	});

	it('returns correct page slice', async () => {
		const kv = createMockKV();
		for (let i = 0; i < 5; i++) {
			kv._store.set(
				`puzzle:p${i}`,
				JSON.stringify(makeReadyPuzzle({ id: `p${i}`, name: `Puzzle ${i}`, createdAt: i }))
			);
		}

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 2, limit: 2 });
		expect(result.total).toBe(5);
		expect(result.puzzles).toHaveLength(2);
		expect(result.offset).toBe(2);
		expect(result.limit).toBe(2);
	});

	it('filters by q — case-insensitive substring on name', async () => {
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Mountain Forest' }))
		);
		kv._store.set('puzzle:b', JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'Ocean View' })));

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			q: 'FOREST',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('a');
	});

	it('filters by category', async () => {
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'A', category: 'Nature' }))
		);
		kv._store.set(
			'puzzle:b',
			JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'B', category: 'Art' }))
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			category: 'Nature',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('a');
	});

	it('combines q and category filters', async () => {
		const kv = createMockKV();
		kv._store.set(
			'puzzle:a',
			JSON.stringify(makeReadyPuzzle({ id: 'a', name: 'Mountain Forest', category: 'Nature' }))
		);
		kv._store.set(
			'puzzle:b',
			JSON.stringify(makeReadyPuzzle({ id: 'b', name: 'Mountain Art', category: 'Art' }))
		);
		kv._store.set(
			'puzzle:c',
			JSON.stringify(makeReadyPuzzle({ id: 'c', name: 'Ocean View', category: 'Nature' }))
		);

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, {
			q: 'mountain',
			category: 'Nature',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('a');
	});

	it('returns empty puzzles when offset exceeds total', async () => {
		const kv = createMockKV();
		kv._store.set('puzzle:p1', JSON.stringify(makeReadyPuzzle({ id: 'p1' })));

		const result = await listPuzzlesPage(kv as unknown as KVNamespace, { offset: 100, limit: 20 });
		expect(result.total).toBe(1);
		expect(result.puzzles).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && bun run test src/services/storage.worker.test.ts
```

Expected: `listPuzzlesPage is not a function` or similar.

- [ ] **Step 3: Implement `listPuzzlesPage` in `storage.worker.ts`**

Add the import at the top of the file (it's already exported via the existing re-exports, but we need `PUZZLE_CATEGORIES` for type checking — it's already imported):

Add this function after `listPuzzles` (around line 249):

```ts
export async function listPuzzlesPage(
	kv: KVNamespace,
	params: { q?: string; category?: PuzzleCategory; offset: number; limit: number }
): Promise<{ puzzles: PuzzleSummary[]; total: number; offset: number; limit: number }> {
	const keys: { name: string }[] = [];
	let cursor: string | undefined;

	while (true) {
		const list = await kv.list({ prefix: 'puzzle:', cursor });
		keys.push(...list.keys);
		if (list.list_complete) break;
		cursor = list.cursor;
	}

	const fetched = await Promise.all(keys.map((k) => kv.get(k.name, 'json')));
	const all: PuzzleMetadata[] = [];

	fetched.forEach((puzzle) => {
		if (puzzle === null) return;
		if (!validatePuzzleMetadataLight(puzzle)) return;
		all.push(puzzle as PuzzleMetadata);
	});

	let filtered = all.filter((p) => p.status === 'ready').sort((a, b) => b.createdAt - a.createdAt);

	if (params.category) {
		filtered = filtered.filter((p) => p.category === params.category);
	}

	if (params.q) {
		const q = params.q.toLowerCase();
		filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
	}

	const total = filtered.length;
	const page = filtered.slice(params.offset, params.offset + params.limit);

	return {
		puzzles: page.map((p) => ({
			id: p.id,
			name: p.name,
			pieceCount: p.pieceCount,
			status: p.status,
			progress: p.progress,
			category: p.category
		})),
		total,
		offset: params.offset,
		limit: params.limit
	};
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/api && bun run test src/services/storage.worker.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/storage.worker.ts apps/api/src/services/storage.worker.test.ts
git commit -m "feat: add listPuzzlesPage to Worker storage"
```

---

## Task 3: Update Worker puzzle route (TDD)

**Files:**

- Modify: `apps/api/src/routes/__tests__/puzzles.worker.test.ts`
- Modify: `apps/api/src/routes/puzzles.worker.ts`

- [ ] **Step 1: Update the mock and existing list test in `puzzles.worker.test.ts`**

The file currently mocks `storage.listPuzzles`. Replace the `GET / - List puzzles` describe block entirely:

```ts
// At the top of the file, the mock line stays the same:
vi.mock('../../services/storage.worker');

// Update the 'GET / - List puzzles' describe block:
describe('GET / - List puzzles', () => {
	it('returns paginated ready puzzles with total/offset/limit', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [
				{
					id: '550e8400-e29b-41d4-a716-446655440001',
					name: 'Ready',
					pieceCount: 4,
					status: 'ready'
				}
			],
			total: 1,
			offset: 0,
			limit: 20
		} as any);

		const req = new Request('http://localhost/');
		const res = await puzzles.fetch(req, mockEnv);
		const body = (await res.json()) as any;

		expect(res.status).toBe(200);
		expect(body.puzzles).toHaveLength(1);
		expect(body.total).toBe(1);
		expect(body.offset).toBe(0);
		expect(body.limit).toBe(20);
	});

	it('passes q param to listPuzzlesPage', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const req = new Request('http://localhost/?q=forest');
		await puzzles.fetch(req, mockEnv);

		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ q: 'forest' })
		);
	});

	it('passes category param to listPuzzlesPage', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const req = new Request('http://localhost/?category=Nature');
		await puzzles.fetch(req, mockEnv);

		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ category: 'Nature' })
		);
	});

	it('ignores invalid category param', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const req = new Request('http://localhost/?category=InvalidCat');
		await puzzles.fetch(req, mockEnv);

		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ category: undefined })
		);
	});

	it('parses offset and limit params', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 50,
			offset: 20,
			limit: 20
		} as any);

		const req = new Request('http://localhost/?offset=20&limit=20');
		await puzzles.fetch(req, mockEnv);

		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ offset: 20, limit: 20 })
		);
	});

	it('clamps invalid offset to 0', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const req = new Request('http://localhost/?offset=-5');
		await puzzles.fetch(req, mockEnv);

		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ offset: 0 })
		);
	});

	it('clamps out-of-range limit to 20', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [],
			total: 0,
			offset: 0,
			limit: 20
		} as any);

		const req = new Request('http://localhost/?limit=999');
		await puzzles.fetch(req, mockEnv);

		expect(storage.listPuzzlesPage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ limit: 20 })
		);
	});

	it('returns 500 when storage throws', async () => {
		vi.mocked(storage.listPuzzlesPage).mockRejectedValue(new Error('KV failure'));

		const req = new Request('http://localhost/');
		const res = await puzzles.fetch(req, mockEnv);

		expect(res.status).toBe(500);
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && bun run test src/routes/__tests__/puzzles.worker.test.ts
```

Expected: `storage.listPuzzlesPage is not a function` or mock-call mismatches.

- [ ] **Step 3: Update `puzzles.worker.ts` — replace the `GET /` handler**

At the top, update the import to include `listPuzzlesPage` and `PUZZLE_CATEGORIES`:

```ts
import {
	getPuzzle,
	listPuzzlesPage,
	getThumbnailKey,
	getPieceKey,
	getOriginalKey,
	getImage,
	PUZZLE_CATEGORIES
} from '../services/storage.worker';
import type { PuzzleCategory } from '../services/storage.worker';
```

Replace the `GET /` handler:

```ts
// GET /api/puzzles - List ready puzzles (paginated, filterable)
puzzles.get('/', async (c) => {
	const q = c.req.query('q') || undefined;

	const categoryParam = c.req.query('category');
	const category =
		categoryParam && PUZZLE_CATEGORIES.includes(categoryParam as PuzzleCategory)
			? (categoryParam as PuzzleCategory)
			: undefined;

	const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
	const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

	const rawLimit = parseInt(c.req.query('limit') ?? '20', 10);
	const limit = Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;

	try {
		const result = await listPuzzlesPage(c.env.PUZZLE_METADATA, { q, category, offset, limit });
		return c.json(result);
	} catch (error) {
		console.error('Failed to list puzzles', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/api && bun run test src/routes/__tests__/puzzles.worker.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full API test suite to check no regressions**

```bash
cd apps/api && bun run test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/puzzles.worker.ts apps/api/src/routes/__tests__/puzzles.worker.test.ts
git commit -m "feat: add search and pagination to Worker puzzle list route"
```

---

## Task 4: Bun storage and route parity

**Files:**

- Modify: `apps/api/src/services/storage.ts`
- Modify: `apps/api/src/services/storage.test.ts`
- Modify: `apps/api/src/routes/puzzles.ts`
- Modify: `apps/api/src/routes/puzzles.test.ts`

- [ ] **Step 1: Add `listPuzzlesPage` to `storage.ts`**

Add after `listPuzzlesSorted` (end of file):

```ts
export async function listPuzzlesPage(params: {
	q?: string;
	category?: PuzzleCategory;
	offset: number;
	limit: number;
}): Promise<{ puzzles: PuzzleSummary[]; total: number; offset: number; limit: number }> {
	const puzzlesWithDate = await listPuzzlesWithDate();
	puzzlesWithDate.sort((a, b) => b.createdAt - a.createdAt);

	let filtered = puzzlesWithDate.map((p) => p.summary);

	if (params.category) {
		filtered = filtered.filter((p) => p.category === params.category);
	}

	if (params.q) {
		const q = params.q.toLowerCase();
		filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
	}

	const total = filtered.length;
	const page = filtered.slice(params.offset, params.offset + params.limit);

	return { puzzles: page, total, offset: params.offset, limit: params.limit };
}
```

Note: `PuzzleCategory` is already imported in `storage.ts` via `../types/index`. `PuzzleSummary` (Bun-local type, no `status` field) is also already imported.

- [ ] **Step 2: Add `listPuzzlesPage` tests to `storage.test.ts`**

Add after the `listPuzzles and listPuzzlesSorted` describe block. The Bun tests use a real temp filesystem set up earlier in the file via `storageModule`. Use the same `beforeEach` cleanup pattern already present:

```ts
describe('listPuzzlesPage', () => {
	beforeEach(async () => {
		const { rm, mkdir } = await import('node:fs/promises');
		const { join } = await import('node:path');
		await rm(join(tempDir, 'puzzles'), { recursive: true, force: true });
		await storageModule.initializeStorage();
	});

	it('returns empty result when no puzzles exist', async () => {
		const result = await storageModule.listPuzzlesPage({ offset: 0, limit: 20 });
		expect(result).toEqual({ puzzles: [], total: 0, offset: 0, limit: 20 });
	});

	it('returns correct page slice', async () => {
		for (let i = 0; i < 5; i++) {
			await storageModule.createPuzzle(
				makePuzzle(`page-${i}`, { name: `Puzzle ${i}`, createdAt: i * 1000 })
			);
		}
		const result = await storageModule.listPuzzlesPage({ offset: 2, limit: 2 });
		expect(result.total).toBe(5);
		expect(result.puzzles).toHaveLength(2);
	});

	it('filters by q', async () => {
		await storageModule.createPuzzle(makePuzzle('forest-1', { name: 'Mountain Forest' }));
		await storageModule.createPuzzle(makePuzzle('ocean-1', { name: 'Ocean View' }));

		const result = await storageModule.listPuzzlesPage({ q: 'forest', offset: 0, limit: 20 });
		expect(result.total).toBe(1);
		expect(result.puzzles[0].name).toBe('Mountain Forest');
	});

	it('filters by category', async () => {
		await storageModule.createPuzzle(makePuzzle('nat-1', { name: 'A', category: 'Nature' }));
		await storageModule.createPuzzle(makePuzzle('art-1', { name: 'B', category: 'Art' }));

		const result = await storageModule.listPuzzlesPage({
			category: 'Nature',
			offset: 0,
			limit: 20
		});
		expect(result.total).toBe(1);
		expect(result.puzzles[0].id).toBe('nat-1');
	});
});
```

Note: `makePuzzle` and `storageModule` are already defined earlier in `storage.test.ts`. Check the top of that file for the exact `makePuzzle` signature — it takes `(id, overrides)`.

- [ ] **Step 3: Update `puzzles.ts` Bun route — replace the `GET /` handler**

In `puzzles.ts`, add `listPuzzlesPage` to the import from `'../services/storage'` and replace the handler:

```ts
import {
	getPuzzle,
	listPuzzlesPage,
	getThumbnailPath,
	getPieceImagePath,
	findOriginalImagePath,
	InvalidPuzzleIdError
} from '../services/storage';
import { PUZZLE_CATEGORIES } from '../types/index';
import type { PuzzleCategory } from '../types/index';
```

Replace the `GET /` handler:

```ts
puzzles.get('/', async (c) => {
	const q = c.req.query('q') || undefined;

	const categoryParam = c.req.query('category');
	const category =
		categoryParam && PUZZLE_CATEGORIES.includes(categoryParam as PuzzleCategory)
			? (categoryParam as PuzzleCategory)
			: undefined;

	const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
	const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

	const rawLimit = parseInt(c.req.query('limit') ?? '20', 10);
	const limit = Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;

	try {
		const result = await listPuzzlesPage({ q, category, offset, limit });
		return c.json(result);
	} catch (error) {
		console.error('Failed to list puzzles', error);
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});
```

- [ ] **Step 4: Update `puzzles.test.ts` Bun route tests**

The mock for the Bun route uses `listPuzzlesSorted`. Update the mock and the list test:

In the `vi.mock('../services/storage', ...)` factory, replace `listPuzzlesSorted: vi.fn()` with `listPuzzlesPage: vi.fn()`.

Replace the `GET / - List puzzles` describe block:

```ts
describe('GET / - List puzzles', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns paginated shape on success', async () => {
		vi.mocked(storage.listPuzzlesPage).mockResolvedValue({
			puzzles: [{ id: 'test-puzzle-abc', name: 'Test Puzzle', pieceCount: 4 }] as any,
			total: 1,
			offset: 0,
			limit: 20
		});

		const req = new Request('http://localhost/');
		const res = await puzzles.fetch(req);
		const body = (await res.json()) as any;

		expect(res.status).toBe(200);
		expect(body.puzzles).toHaveLength(1);
		expect(body.total).toBe(1);
	});

	it('returns 500 when storage throws', async () => {
		vi.mocked(storage.listPuzzlesPage).mockRejectedValue(new Error('disk failure'));

		const req = new Request('http://localhost/');
		const res = await puzzles.fetch(req);

		expect(res.status).toBe(500);
	});
});
```

- [ ] **Step 5: Run all API tests**

```bash
cd apps/api && bun run test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/storage.ts apps/api/src/services/storage.test.ts \
        apps/api/src/routes/puzzles.ts apps/api/src/routes/puzzles.test.ts
git commit -m "feat: add listPuzzlesPage to Bun storage and route (parity)"
```

---

## Task 5: Update `fetchPuzzles` in web `api.ts` (TDD)

**Files:**

- Modify: `apps/web/src/lib/services/api.ts`
- Modify: `apps/web/src/lib/services/__tests__/api.test.ts`

- [ ] **Step 1: Update failing tests in `api.test.ts`**

Replace the `API Service - fetchPuzzles` describe block:

```ts
describe('API Service - fetchPuzzles', () => {
	it('returns paginated response on success', async () => {
		const mockPuzzles = [
			{ id: 'p1', name: 'Puzzle 1', pieceCount: 25, status: 'ready' },
			{ id: 'p2', name: 'Puzzle 2', pieceCount: 100, status: 'ready' }
		];
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: mockPuzzles, total: 2, offset: 0, limit: 20 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		const result = await fetchPuzzles();

		expect(result.puzzles).toEqual(mockPuzzles);
		expect(result.total).toBe(2);
		expect(result.offset).toBe(0);
		expect(result.limit).toBe(20);
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/puzzles$/));
	});

	it('appends q param when provided', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: [], total: 0, offset: 0, limit: 20 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await fetchPuzzles({ q: 'forest' });

		expect(fetch).toHaveBeenCalledWith(expect.stringContaining('q=forest'));
	});

	it('appends category param when provided', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: [], total: 0, offset: 0, limit: 20 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await fetchPuzzles({ category: 'Nature' });

		expect(fetch).toHaveBeenCalledWith(expect.stringContaining('category=Nature'));
	});

	it('appends offset param when non-zero', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: [], total: 50, offset: 20, limit: 20 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await fetchPuzzles({ offset: 20 });

		expect(fetch).toHaveBeenCalledWith(expect.stringContaining('offset=20'));
	});

	it('does not append undefined or default params', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ puzzles: [], total: 0, offset: 0, limit: 20 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await fetchPuzzles();

		const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(url).not.toContain('?');
	});

	it('throws ApiError on non-ok response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'internal_error', message: 'Server failure' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		await expect(fetchPuzzles()).rejects.toMatchObject({ status: 500 });
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/web && bun run test:unit -- src/lib/services/__tests__/api.test.ts
```

Expected: type mismatch on return value (still `PuzzleSummary[]`).

- [ ] **Step 3: Update `fetchPuzzles` in `api.ts`**

Replace the existing `fetchPuzzles` function (lines 113–117):

```ts
export async function fetchPuzzles(params?: {
	q?: string;
	category?: PuzzleCategory;
	offset?: number;
	limit?: number;
	signal?: AbortSignal;
}): Promise<{ puzzles: PuzzleSummary[]; total: number; offset: number; limit: number }> {
	const searchParams = new URLSearchParams();
	if (params?.q) searchParams.set('q', params.q);
	if (params?.category) searchParams.set('category', params.category);
	if (params?.offset && params.offset > 0) searchParams.set('offset', String(params.offset));
	if (params?.limit && params.limit !== 20) searchParams.set('limit', String(params.limit));
	const query = searchParams.toString();
	const url = query ? `${API_BASE}/api/puzzles?${query}` : `${API_BASE}/api/puzzles`;
	const fetchOpts: RequestInit = {};
	if (params?.signal) fetchOpts.signal = params.signal;
	const response = await fetch(url, fetchOpts);
	return handleResponse<{ puzzles: PuzzleSummary[]; total: number; offset: number; limit: number }>(
		response
	);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/web && bun run test:unit -- src/lib/services/__tests__/api.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/services/api.ts apps/web/src/lib/services/__tests__/api.test.ts
git commit -m "feat: update fetchPuzzles to return paginated response"
```

---

## Task 6: Create `SearchBar.svelte` (TDD)

**Files:**

- Create: `apps/web/src/lib/components/SearchBar.svelte`
- Create: `apps/web/src/lib/components/__tests__/SearchBar.svelte.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/web/src/lib/components/__tests__/SearchBar.svelte.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SearchBar from '../SearchBar.svelte';

describe('SearchBar', () => {
	it('renders a search input with the provided value', async () => {
		render(SearchBar, { value: 'forest', onInput: vi.fn() });

		const input = page.getByTestId('search-input');
		await expect.element(input).toBeVisible();
		await expect.element(input).toHaveValue('forest');
	});

	it('calls onInput with the new value when the user types', async () => {
		const onInput = vi.fn();
		render(SearchBar, { value: '', onInput });

		const input = page.getByTestId('search-input');
		await input.fill('ocean');

		expect(onInput).toHaveBeenCalledWith('ocean');
	});

	it('has an accessible label', async () => {
		render(SearchBar, { value: '', onInput: vi.fn() });

		const input = page.getByRole('searchbox', { name: 'Search puzzles' });
		await expect.element(input).toBeVisible();
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/SearchBar.svelte.test.ts
```

Expected: `Cannot find module '../SearchBar.svelte'`.

- [ ] **Step 3: Create `SearchBar.svelte`**

```svelte
<script lang="ts">
	interface Props {
		value: string;
		onInput: (value: string) => void;
	}

	let { value, onInput }: Props = $props();
</script>

<div class="relative w-full">
	<div class="pointer-events-none absolute inset-y-0 left-3 flex items-center" aria-hidden="true">
		<svg
			class="h-3.5 w-3.5 text-(--accent) opacity-50"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
			/>
		</svg>
	</div>
	<input
		type="search"
		{value}
		oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
		placeholder="SEARCH MISSIONS..."
		aria-label="Search puzzles"
		data-testid="search-input"
		class="w-full border border-(--border) bg-(--bg-1) py-2.5 pr-4 pl-9
		text-[0.65rem] font-(--font-mono) tracking-[0.12em] text-(--text-1)
		transition-[border-color,box-shadow] duration-150
		placeholder:text-(--text-2) placeholder:opacity-40
		focus:border-(--accent) focus:[box-shadow:0_0_15px_var(--accent-glow)]
		focus:outline-none"
	/>
</div>
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/web && bun run test:unit -- src/lib/components/__tests__/SearchBar.svelte.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/components/SearchBar.svelte \
        apps/web/src/lib/components/__tests__/SearchBar.svelte.test.ts
git commit -m "feat: add SearchBar component"
```

---

## Task 7: Update `+page.svelte` with search, debounce, and infinite scroll (TDD)

**Files:**

- Create: `apps/web/src/routes/page.svelte.test.ts`
- Modify: `apps/web/src/routes/+page.svelte`

- [ ] **Step 1: Write the gallery page tests**

Create `apps/web/src/routes/page.svelte.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import GalleryPage from './+page.svelte';
import type { PuzzleSummary } from '$lib/types/puzzle';
import { fetchPuzzles, ApiError } from '$lib/services/api';

vi.mock('$lib/services/api', () => {
	class MockApiError extends Error {
		status: number;
		error: string;
		constructor(status: number, error: string, message: string) {
			super(message);
			this.name = 'ApiError';
			this.status = status;
			this.error = error;
		}
	}
	return {
		fetchPuzzles: vi.fn().mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 }),
		getThumbnailUrl: vi.fn((id: string) => `/api/puzzles/${id}/thumbnail`),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/stats', () => ({
	getBestTime: vi.fn().mockReturnValue(null)
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
}));

const makePuzzle = (id: string, overrides: Partial<PuzzleSummary> = {}): PuzzleSummary => ({
	id,
	name: `Puzzle ${id}`,
	pieceCount: 225,
	status: 'ready',
	...overrides
});

describe('Gallery Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchPuzzles).mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
	});

	it('shows puzzle cards when puzzles are returned', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue({
			puzzles: [makePuzzle('p1'), makePuzzle('p2')],
			total: 2,
			offset: 0,
			limit: 20
		});

		render(GalleryPage);

		const grid = page.getByTestId('puzzle-grid');
		await expect.element(grid).toBeVisible();
		const cards = page.getByTestId('puzzle-card');
		await expect.element(cards.nth(0)).toBeVisible();
		await expect.element(cards.nth(1)).toBeVisible();
	});

	it('shows empty state when total is 0 and no query is active', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('empty-state')).toBeVisible();
	});

	it('shows no-results state when total is 0 and query is active', async () => {
		vi.mocked(fetchPuzzles).mockResolvedValue({ puzzles: [], total: 0, offset: 0, limit: 20 });
		render(GalleryPage);

		const input = page.getByTestId('search-input');
		await input.fill('nonexistent');

		// After debounce fires (300ms) + fetch resolves
		await expect.element(page.getByTestId('no-results-state')).toBeVisible();
	});

	it('calls fetchPuzzles with q after debounce', async () => {
		render(GalleryPage);

		const input = page.getByTestId('search-input');
		await input.fill('forest');

		// Wait for debounce (300ms) and fetch
		await vi.waitFor(() => {
			expect(fetchPuzzles).toHaveBeenCalledWith(expect.objectContaining({ q: 'forest' }));
		});
	});

	it('shows error state on initial fetch failure', async () => {
		vi.mocked(fetchPuzzles).mockRejectedValue(new ApiError(500, 'internal_error', 'Server error'));

		render(GalleryPage);

		await expect.element(page.getByTestId('error-state')).toBeVisible();
	});

	it('renders the search input', async () => {
		render(GalleryPage);

		await expect.element(page.getByTestId('search-input')).toBeVisible();
	});
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/web && bun run test:unit -- src/routes/page.svelte.test.ts
```

Expected: tests fail because `SearchBar` doesn't exist in the page yet and mock shapes don't match.

- [ ] **Step 3: Rewrite `+page.svelte` script section**

Replace the entire `<script lang="ts">` block:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchPuzzles, ApiError } from '$lib/services/api';
	import type { PuzzleSummary } from '$lib/types/puzzle';
	import PuzzleCard from '$lib/components/PuzzleCard.svelte';
	import CategoryFilter from '$lib/components/CategoryFilter.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import { CATEGORY_ALL } from '$lib/constants/categories';
	import type { PuzzleCategory } from '$lib/constants/categories';
	import { resolve } from '$app/paths';

	let puzzles: PuzzleSummary[] = $state([]);
	let loading = $state(true);
	let error: string | null = $state(null);
	let loadMoreError = $state(false);
	let selectedCategory: PuzzleCategory | typeof CATEGORY_ALL = $state(CATEGORY_ALL);
	let searchQuery = $state('');
	let debouncedQuery = $state('');
	let total = $state(0);
	let loadingMore = $state(false);
	let hasMore = $derived(puzzles.length < total);

	// Debounce raw input into debouncedQuery (300 ms)
	$effect(() => {
		const q = searchQuery;
		const timer = setTimeout(() => {
			debouncedQuery = q;
		}, 300);
		return () => clearTimeout(timer);
	});

	// Re-fetch whenever debouncedQuery or selectedCategory changes
	$effect(() => {
		const q = debouncedQuery;
		const cat = selectedCategory;

		loading = true;
		error = null;
		loadMoreError = false;

		const controller = new AbortController();
		const catParam = cat === CATEGORY_ALL ? undefined : (cat as PuzzleCategory);

		fetchPuzzles({ q: q || undefined, category: catParam, offset: 0 })
			.then((result) => {
				if (controller.signal.aborted) return;
				puzzles = result.puzzles;
				total = result.total;
			})
			.catch((e) => {
				if (controller.signal.aborted) return;
				error = e instanceof ApiError ? e.message : 'Failed to load puzzles. Please try again.';
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});

		return () => controller.abort();
	});

	async function loadNextPage() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		loadMoreError = false;
		const catParam =
			selectedCategory === CATEGORY_ALL ? undefined : (selectedCategory as PuzzleCategory);
		try {
			const result = await fetchPuzzles({
				q: debouncedQuery || undefined,
				category: catParam,
				offset: puzzles.length
			});
			puzzles = [...puzzles, ...result.puzzles];
			total = result.total;
		} catch {
			loadMoreError = true;
		} finally {
			loadingMore = false;
		}
	}

	onMount(() => {
		const sentinel = document.querySelector('[data-testid="scroll-sentinel"]');
		if (!sentinel) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) loadNextPage();
			},
			{ rootMargin: '200px' }
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	function handleCategorySelect(category: PuzzleCategory | typeof CATEGORY_ALL) {
		selectedCategory = category;
	}

	function clearFilters() {
		searchQuery = '';
		selectedCategory = CATEGORY_ALL;
	}
</script>
```

- [ ] **Step 4: Update the template section of `+page.svelte`**

Replace everything from `<svelte:head>` onwards with:

```svelte
<svelte:head>
	<title>Puzzle Arcade | Perseus</title>
</svelte:head>

<main
	class="min-h-screen bg-(--bg-0)
[background-image:linear-gradient(rgba(0,240,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(0,240,255,0.025)_1px,transparent_1px)]
[background-size:48px_48px]"
>
	<div class="mx-auto max-w-[80rem] px-6 pt-8 pb-16 sm:px-8 sm:pt-10">
		<header class="mb-12">
			<div
				class="h-px bg-[linear-gradient(90deg,transparent_0%,var(--accent)_30%,var(--accent)_70%,transparent_100%)] opacity-40"
			></div>
			<div class="flex items-end justify-between gap-4 py-5 max-sm:flex-col max-sm:items-start">
				<div class="shrink-0">
					<div
						class="mb-1 text-[0.65rem] font-(--font-mono) tracking-[0.2em] text-(--accent) opacity-60"
					>
						// PERSEUS SYSTEM v1.0
					</div>
					<h1
						class="text-[clamp(1.75rem,5vw,3.25rem)] leading-none font-(--font-display)
font-black tracking-[0.06em] text-(--text-0) uppercase"
					>
						PUZZLE
						<span
							class="ml-[0.3em] text-(--accent)
[text-shadow:0_0_20px_var(--accent),0_0_50px_var(--accent-glow-strong)]"
						>
							ARCADE
						</span>
					</h1>
				</div>
				<div
					class="flex flex-col items-end gap-[0.3rem] text-right max-sm:items-start max-sm:text-left"
				>
					<span
						class="text-[0.7rem] font-(--font-mono) tracking-[0.25em] text-(--text-2) uppercase"
					>
						SELECT YOUR MISSION
					</span>
					{#if total > 0}
						<span
							class="text-[0.7rem] font-(--font-mono) tracking-[0.15em] text-(--accent) opacity-70"
						>
							{total} AVAILABLE
						</span>
					{/if}
				</div>
			</div>
			<div
				class="h-px bg-[linear-gradient(90deg,transparent_0%,var(--accent)_30%,var(--accent)_70%,transparent_100%)] opacity-40"
			></div>

			{#if !loading}
				<div class="flex flex-col gap-3 pt-5">
					<SearchBar value={searchQuery} onInput={(v) => (searchQuery = v)} />
					<CategoryFilter selected={selectedCategory} onSelect={handleCategorySelect} />
				</div>
			{/if}
		</header>

		{#if loading}
			<div
				class="flex flex-col items-center justify-center gap-6 py-24"
				data-testid="loading-state"
				role="status"
				aria-live="polite"
			>
				<div
					class="h-11 w-11 rounded-full border-2 border-(--border) border-t-(--accent)
[box-shadow:0_0_20px_var(--accent-glow)]
motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none
motion-reduce:[box-shadow:none]"
				></div>
				<span
					class="text-[0.75rem] font-(--font-mono) tracking-[0.25em] text-(--accent)
motion-safe:animate-[neon-flicker_3s_ease-in-out_infinite]
motion-reduce:animate-none"
				>
					SCANNING MISSIONS...
				</span>
			</div>
		{:else if error}
			<div
				class="mx-auto flex max-w-[32rem] flex-col items-center gap-4 border border-(--hot)
bg-(--bg-1) px-8 py-12 text-center
[box-shadow:0_0_40px_var(--hot-glow),inset_0_0_40px_rgba(255,0,102,0.04)]"
				data-testid="error-state"
			>
				<div
					class="text-[1.75rem] font-(--font-display) font-black tracking-[0.15em] text-(--hot)
[text-shadow:0_0_25px_var(--hot)]"
				>
					SYS_ERR
				</div>
				<p class="text-[0.8rem] font-(--font-mono) tracking-[0.05em] text-(--text-1)">{error}</p>
				<button
					onclick={() => window.location.reload()}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
				>
					RETRY SCAN
				</button>
			</div>
		{:else if total === 0 && !debouncedQuery && selectedCategory === CATEGORY_ALL}
			<div
				class="flex flex-col items-center gap-4 border border-(--border) bg-(--bg-1) px-8 py-16 text-center"
				data-testid="empty-state"
			>
				<div
					class="opacity-35 motion-safe:animate-[float_3s_ease-in-out_infinite]
motion-reduce:animate-none"
				>
					<svg
						class="h-16 w-16 text-(--text-1)"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						aria-hidden="true"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="1.5"
							d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
						/>
					</svg>
				</div>
				<h2
					class="text-[1rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-1)
uppercase"
				>
					NO MISSIONS AVAILABLE
				</h2>
				<p class="text-[0.9rem] tracking-[0.05em] text-(--text-2)">
					Initialize the system via the admin portal.
				</p>
				<a
					href={resolve('/admin')}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
				>
					ADMIN PORTAL
				</a>
			</div>
		{:else if total === 0}
			<div
				class="flex flex-col items-center gap-4 border border-(--border) bg-(--bg-1) px-8 py-16 text-center"
				data-testid="no-results-state"
			>
				<h2
					class="text-[1rem] font-(--font-display) font-bold tracking-[0.12em] text-(--text-1)
uppercase"
				>
					NO MISSIONS MATCH YOUR SCAN
				</h2>
				<p class="text-[0.9rem] tracking-[0.05em] text-(--text-2)">
					Try a different search term or category.
				</p>
				<button
					onclick={clearFilters}
					class="relative mt-2 overflow-hidden border border-(--accent) px-7 py-2.5
text-[0.65rem] font-(--font-display) font-bold tracking-[0.2em]
text-(--accent) uppercase transition-all duration-200
before:pointer-events-none before:absolute before:inset-0
before:bg-[linear-gradient(135deg,var(--accent-glow)_0%,transparent_60%)]
before:opacity-0 before:transition-opacity before:duration-200
hover:bg-(--accent-glow)
hover:[box-shadow:0_0_25px_var(--accent-glow-strong)]
hover:[text-shadow:0_0_10px_var(--accent)] hover:before:opacity-100"
					data-testid="clear-filters-btn"
				>
					CLEAR FILTERS
				</button>
			</div>
		{:else}
			<div
				class="grid grid-cols-1 gap-5 motion-safe:animate-[slide-up_0.4s_ease-out]
motion-reduce:animate-none sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
				data-testid="puzzle-grid"
			>
				{#each puzzles as puzzle (puzzle.id)}
					<PuzzleCard {puzzle} />
				{/each}
			</div>

			{#if loadingMore}
				<div
					class="flex justify-center py-8"
					role="status"
					aria-live="polite"
					data-testid="load-more-spinner"
				>
					<div
						class="h-8 w-8 rounded-full border-2 border-(--border) border-t-(--accent)
[box-shadow:0_0_15px_var(--accent-glow)]
motion-safe:animate-[spin-cw_0.75s_linear_infinite] motion-reduce:animate-none"
					></div>
				</div>
			{:else if loadMoreError}
				<div class="flex justify-center py-8" data-testid="load-more-error">
					<button
						onclick={loadNextPage}
						class="border border-(--hot) px-6 py-2 text-[0.65rem] font-(--font-mono)
tracking-[0.15em] text-(--hot) uppercase transition-colors duration-150
hover:bg-[rgba(255,0,102,0.08)]"
					>
						RETRY LOAD
					</button>
				</div>
			{/if}

			<div data-testid="scroll-sentinel" class="h-px" aria-hidden="true"></div>
		{/if}
	</div>
</main>
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd apps/web && bun run test:unit -- src/routes/page.svelte.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run full web unit test suite to check no regressions**

```bash
cd apps/web && bun run test:unit
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/+page.svelte apps/web/src/routes/page.svelte.test.ts
git commit -m "feat: add search, debounce, and infinite scroll to gallery page"
```

---

## Task 8: Update E2E gallery tests

**Files:**

- Modify: `apps/web/e2e/gallery.spec.ts`

- [ ] **Step 1: Update `gallery.spec.ts` — mock shape + new tests**

Replace the entire file content:

```ts
import { test, expect, type Page } from '@playwright/test';

const pagedResponse = (puzzles: Array<{ id: string; name: string; pieceCount: number }>) => ({
	puzzles,
	total: puzzles.length,
	offset: 0,
	limit: 20
});

const samplePuzzleSummary = { id: 'puzzle-1', name: 'Test Puzzle', pieceCount: 1 };

const samplePuzzle = {
	id: 'puzzle-1',
	name: 'Test Puzzle',
	pieceCount: 1,
	gridCols: 1,
	gridRows: 1,
	imageWidth: 100,
	imageHeight: 100,
	createdAt: 0,
	pieces: [
		{
			id: 1,
			puzzleId: 'puzzle-1',
			correctX: 0,
			correctY: 0,
			edges: { top: 'flat', right: 'flat', bottom: 'flat', left: 'flat' },
			imagePath: 'placeholder'
		}
	]
};

async function mockPuzzleList(
	page: Page,
	puzzles: Array<{ id: string; name: string; pieceCount: number }>
) {
	await page.route('**/api/puzzles**', (route) => route.fulfill({ json: pagedResponse(puzzles) }));
}

async function mockPuzzleDetail(page: Page, puzzle: typeof samplePuzzle) {
	await page.route(`**/api/puzzles/${puzzle.id}`, (route) => route.fulfill({ json: puzzle }));
}

test.describe('Main Gallery Page', () => {
	test('should display the gallery page', async ({ page }) => {
		await mockPuzzleList(page, []);
		await page.goto('/');
		await expect(page).toHaveTitle(/Perseus|Jigsaw/i);
	});

	test('should show empty state when no puzzles exist', async ({ page }) => {
		await mockPuzzleList(page, []);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		await expect(page.getByTestId('error-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeHidden();
		await expect(page.getByTestId('empty-state')).toBeVisible();
	});

	test('should display puzzle cards when puzzles exist', async ({ page }) => {
		await mockPuzzleList(page, [samplePuzzleSummary]);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		await expect(page.getByTestId('error-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeVisible();
		await expect(page.getByTestId('empty-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-card')).toHaveCount(1);
	});

	test('should navigate to puzzle page when clicking a card', async ({ page }) => {
		await mockPuzzleList(page, [samplePuzzleSummary]);
		await mockPuzzleDetail(page, samplePuzzle);
		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const puzzleCard = page.locator('[data-testid="puzzle-card"]').first();
		await expect(puzzleCard).toBeVisible();
		await puzzleCard.click();
		await expect(page).toHaveURL(/\/puzzle\/puzzle-1/);
	});

	test('should show no-results state when search returns empty', async ({ page }) => {
		// First load with puzzles, then search returns empty
		await page.route('**/api/puzzles**', async (route) => {
			const url = route.request().url();
			if (url.includes('q=')) {
				await route.fulfill({ json: pagedResponse([]) });
			} else {
				await route.fulfill({ json: pagedResponse([samplePuzzleSummary]) });
			}
		});

		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();

		const searchInput = page.getByTestId('search-input');
		await searchInput.fill('xyznotfound');

		await expect(page.getByTestId('no-results-state')).toBeVisible({ timeout: 1000 });
	});

	test('should append more puzzles when scrolling to sentinel', async ({ page }) => {
		const firstPage = Array.from({ length: 20 }, (_, i) => ({
			id: `p${i}`,
			name: `Puzzle ${i}`,
			pieceCount: 225
		}));
		const secondPage = [{ id: 'p20', name: 'Puzzle 20', pieceCount: 225 }];

		let callCount = 0;
		await page.route('**/api/puzzles**', async (route) => {
			callCount++;
			const url = route.request().url();
			if (url.includes('offset=20')) {
				await route.fulfill({
					json: { puzzles: secondPage, total: 21, offset: 20, limit: 20 }
				});
			} else {
				await route.fulfill({
					json: { puzzles: firstPage, total: 21, offset: 0, limit: 20 }
				});
			}
		});

		await page.goto('/');
		await expect(page.getByTestId('loading-state')).toBeHidden();
		await expect(page.getByTestId('puzzle-grid')).toBeVisible();

		// Scroll sentinel into view
		await page.getByTestId('scroll-sentinel').scrollIntoViewIfNeeded();

		// Second page should be appended
		await expect(page.getByTestId('puzzle-card')).toHaveCount(21, { timeout: 2000 });
	});
});
```

- [ ] **Step 2: Run E2E tests**

```bash
cd apps/web && bun run test:e2e
```

Expected: all 6 tests pass.

- [ ] **Step 3: Run full test suite one final time**

```bash
cd /path/to/repo && bun run test
```

Expected: all tests pass across web, api, and workflows.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/gallery.spec.ts
git commit -m "test: update gallery E2E for paginated shape and search/scroll tests"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement                                        | Task   |
| ------------------------------------------------------- | ------ |
| `PuzzleListResponse` gains `total/offset/limit`         | Task 1 |
| `listPuzzlesPage` — filter ready, q, category, paginate | Task 2 |
| Worker route parses params, calls `listPuzzlesPage`     | Task 3 |
| Invalid params fall back to defaults (not 400)          | Task 3 |
| Bun storage + route parity                              | Task 4 |
| `fetchPuzzles` updated signature                        | Task 5 |
| `SearchBar.svelte` component                            | Task 6 |
| Search above category filter                            | Task 7 |
| Search + category filter compose                        | Task 7 |
| Debounce (300 ms)                                       | Task 7 |
| AbortController for stale response prevention           | Task 7 |
| `IntersectionObserver` infinite scroll                  | Task 7 |
| `hasMore` guard on `loadNextPage`                       | Task 7 |
| "No results" state + clear filters button               | Task 7 |
| Load-more error retry prompt                            | Task 7 |
| E2E updated                                             | Task 8 |

All requirements covered. No gaps.
