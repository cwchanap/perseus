# Reaper & Idempotency Race Condition Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four race conditions in the puzzle creation/reaping lifecycle that can produce duplicate puzzles, destroy valid ready puzzles, run workflows against deleted input, and resurrect reaped puzzles in KV.

**Architecture:** Four independent fixes targeting the reaper (DO authoritative status check + tombstone) and the admin worker (post-create fencing via workflow termination + pre-cleanup liveness probing). The metadata DO (`PuzzleMetadataDO`) gains two new endpoints: `/status` (read-only authoritative status) and `/delete` (tombstone + clear storage). The admin worker's `WorkflowInstance` interface gains `terminate()`.

**Tech Stack:** Cloudflare Workers, Durable Objects, Workflows, Hono, Vitest, TypeScript

## Global Constraints

- Tabs for indentation, single quotes, no trailing commas, 100 char line width
- Code style: Prettier + ESLint (enforced by Husky pre-commit)
- Tests: Vitest, files matching `src/**/*.test.ts`; worker tests use `.worker.test.ts`
- DO storage transactions must stay fast and local (SQLite-only) — no external I/O (KV, R2, Workflow API) inside `storage.transaction()`
- The metadata DO is keyed by `idFromName(puzzleId)`, the reservation DO by `idFromName(idempotencyKey)` — they never share storage
- `getMetadata` (KV read) throws on corrupt data and returns null only for truly missing keys
- `RESERVATION_PENDING_TTL_MS` = 5 minutes (packages/shared/src/workflow-status.ts:31)
- `REAP_AFTER_MS` = 2 hours (apps/api/src/services/reaper.ts:45)

---

## File Structure

### Files Modified

| File                                      | Responsibility                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/workflows/src/index.ts`             | Add `/status` and `/delete` endpoints to `PuzzleMetadataDO`; add tombstone check in `/update` |
| `apps/api/src/services/storage.worker.ts` | Add `getAuthoritativeStatus()` and `deleteMetadataDO()` helpers                               |
| `apps/api/src/services/reaper.ts`         | Call DO status check before reaping; call DO delete after reaping                             |
| `apps/api/src/routes/admin.worker.ts`     | Terminate orphaned workflow on commit failure; probe liveness on create failure               |
| `apps/api/src/worker.ts`                  | Add `terminate()` to `WorkflowInstance` interface                                             |

### Test Files Modified

| File                                                             | Tests for                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/workflows/src/puzzle-metadata-do.test.ts`                  | `/status` endpoint, `/delete` tombstone, `/update` rejection after tombstone |
| `apps/api/src/services/__tests__/reaper.test.ts`                 | DO status check before reap, DO delete after reap                            |
| `apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts` | Workflow termination on commit failure, liveness probe on create failure     |

---

## Task 1: Reaper — Verify Authoritative DO Status Before Reaping (P1)

**Fixes review item 2:** When finalize committed 'ready' to the DO but the workflow later reports 'errored' (mark-failed got 409 "already ready"), a stale KV read showing 'processing' causes the reaper to destroy a valid puzzle. The reaper must check the authoritative DO status before reaping.

**Files:**

- Modify: `apps/workflows/src/index.ts` (add `/status` endpoint to `PuzzleMetadataDO`)
- Modify: `apps/api/src/services/storage.worker.ts` (add `getAuthoritativeStatus` helper)
- Modify: `apps/api/src/services/reaper.ts` (call DO status check before reaping)
- Test: `apps/workflows/src/puzzle-metadata-do.test.ts`
- Test: `apps/api/src/services/__tests__/reaper.test.ts`

**Interfaces:**

- Produces: `getAuthoritativeStatus(metadataDO: DurableObjectNamespace, puzzleId: string): Promise<PuzzleStatus | null>` in storage.worker.ts — returns the DO's authoritative status, or null if the DO has no metadata (truly orphaned)

- [ ] **Step 1: Write failing test for DO `/status` endpoint**

Add to `apps/workflows/src/puzzle-metadata-do.test.ts`, inside the existing `describe('PuzzleMetadataDO')` block:

```typescript
it('returns the authoritative status from DO storage via /status', async () => {
	const { do: dof, storage } = await createDO({
		metadata: { ...baseMetadata, status: 'ready' }
	});
	const res = await dof.fetch(
		new Request('https://puzzle-metadata/status', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ puzzleId: 'test-puzzle' })
		})
	);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.status).toBe('ready');
});

it('returns 404 from /status when DO storage has no metadata', async () => {
	const { do: dof } = await createDO({});
	const res = await dof.fetch(
		new Request('https://puzzle-metadata/status', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ puzzleId: 'test-puzzle' })
		})
	);
	expect(res.status).toBe(404);
});

it('returns 403 from /status when puzzleId does not match DO identity', async () => {
	const { do: dof } = await createDO({
		puzzleId: 'test-puzzle',
		metadata: baseMetadata
	});
	const res = await dof.fetch(
		new Request('https://puzzle-metadata/status', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ puzzleId: 'wrong-puzzle' })
		})
	);
	expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/workflows && bun run test -- --reporter=verbose puzzle-metadata-do.test.ts`
Expected: FAIL — `/status` route returns 404 (Not found, unhandled route)

- [ ] **Step 3: Implement `/status` endpoint in PuzzleMetadataDO**

In `apps/workflows/src/index.ts`, add the `/status` route in the `fetch` method of `PuzzleMetadataDO`, after the `/release` handler (around line 125) and before the `/update` check:

```typescript
if (url.pathname === '/status') {
	return this.handleStatus(request);
}
```

Add the `handleStatus` method to `PuzzleMetadataDO` (after `handleReservationTransition`, before `readReservation`):

```typescript
/**
 * Read-only endpoint that returns the authoritative metadata status from
 * DO storage. Used by the reaper to verify the DO's status before reaping
 * a puzzle whose workflow reports 'errored' but whose DO may have already
 * committed 'ready' (e.g. finalize succeeded but the step retry budget
 * exhausted, dropping into the mark-failed catch which gets a 409).
 *
 * Returns 200 with { status } when metadata exists, 404 when the DO has
 * no metadata (truly orphaned — safe to reap), 403 on puzzleId mismatch.
 */
async handleStatus(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		puzzleId?: string;
	} | null;
	if (!body || typeof body.puzzleId !== 'string' || !body.puzzleId.trim()) {
		return Response.json({ message: 'Invalid status payload' }, { status: 400 });
	}

	const { puzzleId } = body;

	let doPuzzleId = await this.ctx.storage.get<string>('puzzleId');
	if (!doPuzzleId) {
		doPuzzleId = puzzleId;
		await this.ctx.storage.put('puzzleId', doPuzzleId);
	} else if (doPuzzleId !== puzzleId) {
		return Response.json(
			{ message: 'Puzzle ID mismatch: request puzzleId does not match DO identity' },
			{ status: 403 }
		);
	}

	const stored = await this.ctx.storage.get<PuzzleMetadata>('metadata');
	if (!stored) {
		return Response.json(
			{ message: `Puzzle ${puzzleId} not found in DO storage` },
			{ status: 404 }
		);
	}
	return Response.json({ status: stored.status });
}
```

- [ ] **Step 4: Run DO test to verify it passes**

Run: `cd apps/workflows && bun run test -- --reporter=verbose puzzle-metadata-do.test.ts`
Expected: PASS — all three `/status` tests pass

- [ ] **Step 5: Write failing test for `getAuthoritativeStatus` helper**

Add to a new test block at the end of `apps/api/src/services/__tests__/reaper.test.ts` (or create a new test file `apps/api/src/services/__tests__/storage-worker-do.test.ts`):

```typescript
describe('getAuthoritativeStatus', () => {
	it('returns the status from the DO /status response', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const status = await getAuthoritativeStatus(doNs, 'puzzle-1');
		expect(status).toBe('ready');
		expect(doNs.idFromName).toHaveBeenCalledWith('puzzle-1');
	});

	it('returns null when DO has no metadata (404)', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('Not found', { status: 404 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const status = await getAuthoritativeStatus(doNs, 'puzzle-1');
		expect(status).toBeNull();
	});

	it('returns null on unexpected DO error (fail closed — do not reap)', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('Internal error', { status: 500 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		const status = await getAuthoritativeStatus(doNs, 'puzzle-1');
		expect(status).toBeNull();
	});
});
```

Note: The "fail closed" behavior for 500 needs a way to distinguish "no metadata" (404 → null, safe to reap) from "DO error" (500 → should not reap). See Step 6 for the return type design.

- [ ] **Step 6: Implement `getAuthoritativeStatus` helper in storage.worker.ts**

Add to `apps/api/src/services/storage.worker.ts`, after the `updatePuzzleMetadata` function (around line 109):

```typescript
/**
 * Read the authoritative puzzle status from the metadata DO's storage.
 * Used by the reaper to verify the DO's status before reaping — a stale KV
 * read showing 'processing' can mask a DO that already committed 'ready'
 * (finalize succeeded but the workflow later errored). Returns the status
 * string on success, null when the DO has no metadata (404 — truly
 * orphaned, safe to reap). Throws on DO errors (500, network) so the
 * caller can distinguish "no metadata" from "DO unreachable" and fail
 * closed (skip reaping) on the latter.
 */
export async function getAuthoritativeStatus(
	metadataDO: DurableObjectNamespace,
	puzzleId: string
): Promise<string | null> {
	const id = metadataDO.idFromName(puzzleId);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/status', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ puzzleId })
	});
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			payload?.message ??
				`Failed to read authoritative status for ${puzzleId} (HTTP ${response.status})`
		);
	}
	const result = (await response.json()) as { status?: string };
	if (typeof result.status !== 'string') {
		throw new Error(`Authoritative status response missing status field for ${puzzleId}`);
	}
	return result.status;
}
```

Update the test from Step 5: the "fail closed" test should expect a throw, not null:

```typescript
it('throws on unexpected DO error (caller fails closed — does not reap)', async () => {
	const stub = {
		fetch: vi.fn(async () => new Response('Internal error', { status: 500 }))
	};
	const doNs = {
		idFromName: vi.fn(() => 'id-1'),
		get: vi.fn(() => stub)
	} as any;
	await expect(getAuthoritativeStatus(doNs, 'puzzle-1')).rejects.toThrow();
});
```

- [ ] **Step 7: Run helper tests to verify they pass**

Run: `cd apps/api && bun run test -- --reporter=verbose storage-worker-do.test.ts`
Expected: PASS

- [ ] **Step 8: Write failing test for reaper DO status check**

Add to `apps/api/src/services/__tests__/reaper.test.ts`. The test must verify: when the workflow is 'errored' but the DO says 'ready', the reaper skips:

```typescript
it('skips reaping when DO authoritative status is ready (workflow errored but finalize committed)', async () => {
	(storage.listPuzzles as any).mockResolvedValue({
		puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
		invalidCount: 0
	});
	(storage.getPuzzle as any).mockResolvedValue({
		id: 'stuck-1',
		status: 'processing',
		name: 'Puzzle stuck-1',
		pieceCount: 100
	});
	const env = makeEnv({ 'stuck-1': 'errored' });
	// DO says 'ready' — finalize committed before the workflow errored
	env.PUZZLE_METADATA_DO = {
		idFromName: vi.fn(() => 'do-id-1'),
		get: vi.fn(() => ({
			fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
		}))
	} as any;
	const result = await reapStuckPuzzles(env, NOW);
	expect(result.candidates).toBe(1);
	expect(result.reaped).toBe(0);
	expect(storage.deletePuzzleAssets).not.toHaveBeenCalled();
	expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	expect(result.details.some((d) => d.action === 'skip-do-ready')).toBe(true);
});

it('still reaps when DO authoritative status is processing (genuinely stuck)', async () => {
	(storage.listPuzzles as any).mockResolvedValue({
		puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
		invalidCount: 0
	});
	(storage.getPuzzle as any).mockResolvedValue({
		id: 'stuck-1',
		status: 'processing',
		name: 'Puzzle stuck-1',
		pieceCount: 100
	});
	const env = makeEnv({ 'stuck-1': 'errored' });
	env.PUZZLE_METADATA_DO = {
		idFromName: vi.fn(() => 'do-id-1'),
		get: vi.fn(() => ({
			fetch: vi.fn(
				async () => new Response(JSON.stringify({ status: 'processing' }), { status: 200 })
			)
		}))
	} as any;
	const result = await reapStuckPuzzles(env, NOW);
	expect(result.reaped).toBe(1);
	expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'stuck-1');
});

it('still reaps when DO has no metadata (404 — truly orphaned)', async () => {
	(storage.listPuzzles as any).mockResolvedValue({
		puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
		invalidCount: 0
	});
	(storage.getPuzzle as any).mockResolvedValue({
		id: 'stuck-1',
		status: 'processing',
		name: 'Puzzle stuck-1',
		pieceCount: 100
	});
	const env = makeEnv({ 'stuck-1': 'errored' });
	env.PUZZLE_METADATA_DO = {
		idFromName: vi.fn(() => 'do-id-1'),
		get: vi.fn(() => ({
			fetch: vi.fn(async () => new Response('Not found', { status: 404 }))
		}))
	} as any;
	const result = await reapStuckPuzzles(env, NOW);
	expect(result.reaped).toBe(1);
});

it('skips reaping when DO status check throws (fail closed)', async () => {
	(storage.listPuzzles as any).mockResolvedValue({
		puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
		invalidCount: 0
	});
	(storage.getPuzzle as any).mockResolvedValue({
		id: 'stuck-1',
		status: 'processing',
		name: 'Puzzle stuck-1',
		pieceCount: 100
	});
	const env = makeEnv({ 'stuck-1': 'errored' });
	env.PUZZLE_METADATA_DO = {
		idFromName: vi.fn(() => 'do-id-1'),
		get: vi.fn(() => ({
			fetch: vi.fn(async () => new Response('Internal error', { status: 500 }))
		}))
	} as any;
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const result = await reapStuckPuzzles(env, NOW);
	expect(result.reaped).toBe(0);
	expect(result.errors).toBe(1);
	expect(result.details.some((d) => d.action === 'do-status-check-failed')).toBe(true);
});
```

Also update the mock at the top of the test file to include `getAuthoritativeStatus`:

```typescript
vi.mock('../storage.worker', () => ({
	deletePuzzleAssets: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	getAuthoritativeStatus: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	releaseIdempotencyKey: vi.fn()
}));
```

And add `getAuthoritativeStatus` to the `storage` object and imports:

```typescript
import {
	deletePuzzleAssets,
	deletePuzzleMetadata,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} from '../storage.worker';

const storage = {
	deletePuzzleAssets,
	deletePuzzleMetadata,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} as any;
```

For the DO-status-check tests, the mock for `getAuthoritativeStatus` from `storage.worker` needs to be bypassed so the real function is called (it calls the DO). Use `vi.spyOn` or direct `env.PUZZLE_METADATA_DO` mock with the real `getAuthoritativeStatus` imported. Alternatively, mock `getAuthoritativeStatus` directly in the storage mock:

```typescript
// For DO status check tests, mock getAuthoritativeStatus directly:
(storage.getAuthoritativeStatus as any).mockResolvedValue('ready'); // for skip test
(storage.getAuthoritativeStatus as any).mockResolvedValue('processing'); // for reap test
(storage.getAuthoritativeStatus as any).mockResolvedValue(null); // for orphan test
(storage.getAuthoritativeStatus as any).mockRejectedValue(new Error('DO down')); // for fail-closed test
```

This is simpler — the reaper calls `getAuthoritativeStatus(env.PUZZLE_METADATA_DO, puzzle.id)`, and the mock intercepts it.

- [ ] **Step 9: Run reaper test to verify it fails**

Run: `cd apps/api && bun run test -- --reporter=verbose reaper.test.ts`
Expected: FAIL — `getAuthoritativeStatus` is not called by the reaper yet

- [ ] **Step 10: Implement DO status check in reaper**

In `apps/api/src/services/reaper.ts`, add import:

```typescript
import {
	deletePuzzleAssets,
	deletePuzzleMetadata,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} from './storage.worker';
```

After the `isDeadWorkflowStatus` check (line 168) and before the R2 deletion (line 170), add:

```typescript
// Before reaping, verify the authoritative DO status. A workflow can
// report 'errored' after finalize already committed 'ready' to the DO
// (e.g. the mark-failed step's retry budget exhausted after a successful
// finalize DO write, or a post-finalize step threw). The DO is the source
// of truth — if it says 'ready', the puzzle is valid and must NOT be
// reaped. A stale KV read showing 'processing' is eventual-consistency
// lag, not an orphan.
try {
	const authoritativeStatus = await getAuthoritativeStatus(env.PUZZLE_METADATA_DO, puzzle.id);
	if (authoritativeStatus === 'ready') {
		console.warn(
			`Reaper: DO authoritative status is 'ready' for ${puzzle.id} but workflow is dead and KV shows processing; skipping (finalize committed before workflow errored)`
		);
		result.details.push({
			puzzleId: puzzle.id,
			action: 'skip-do-ready'
		});
		return;
	}
	// null = DO has no metadata (truly orphaned) → proceed with reaping.
	// Any other status (processing, failed) → proceed with reaping.
} catch (doErr) {
	// DO unreachable — fail closed. Reaping a valid puzzle is
	// irreversible (deletes R2 assets); skipping a dead one is
	// recoverable (next reaper run, or operator force-delete).
	console.error(`Reaper: DO status check failed for ${puzzle.id}, skipping (fail closed):`, doErr);
	result.errors++;
	result.details.push({
		puzzleId: puzzle.id,
		action: 'do-status-check-failed',
		error: String(doErr)
	});
	return;
}
```

- [ ] **Step 11: Run reaper tests to verify they pass**

Run: `cd apps/api && bun run test -- --reporter=verbose reaper.test.ts`
Expected: PASS — all existing tests still pass, new DO status check tests pass

- [ ] **Step 12: Run full test suite for affected apps**

Run: `cd apps/api && bun run test && cd ../workflows && bun run test`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add apps/workflows/src/index.ts apps/api/src/services/storage.worker.ts apps/api/src/services/reaper.ts apps/workflows/src/puzzle-metadata-do.test.ts apps/api/src/services/__tests__/reaper.test.ts
git commit -m "$(cat <<'EOF'
fix: verify authoritative DO status before reaping errored workflows

The reaper trusted workflow status over the metadata DO's authoritative
status. When finalize committed 'ready' to the DO but the workflow later
errored (mark-failed got 409 "already ready"), a stale KV read showing
'processing' caused the reaper to destroy a valid puzzle's R2 assets and
KV metadata. Now the reaper queries the DO's /status endpoint before
reaping and skips if the DO says 'ready'. Fails closed (skip) on DO
errors to avoid irreversible destruction of valid puzzles.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Task 2: DO Tombstone — Prevent Stale Workflow Updates From Resurrecting Reaped Puzzles (P2)

**Fixes review item 4:** When the reaper deletes a dead puzzle's KV record and R2 assets, an in-flight or retried workflow update can still read the DO-stored metadata and write it back to KV, resurrecting a processing/failed record whose R2 assets were already deleted. The fix adds a tombstone to the DO that rejects all updates after reaping.

**Files:**

- Modify: `apps/workflows/src/index.ts` (add `/delete` endpoint, tombstone check in `/update`)
- Modify: `apps/api/src/services/storage.worker.ts` (add `deleteMetadataDO` helper)
- Modify: `apps/api/src/services/reaper.ts` (call DO delete after reaping)
- Test: `apps/workflows/src/puzzle-metadata-do.test.ts`
- Test: `apps/api/src/services/__tests__/reaper.test.ts`

**Interfaces:**

- Produces: `deleteMetadataDO(metadataDO: DurableObjectNamespace, puzzleId: string): Promise<void>` in storage.worker.ts — sets a tombstone in the DO and clears its metadata storage

- [ ] **Step 1: Write failing test for DO `/delete` endpoint**

Add to `apps/workflows/src/puzzle-metadata-do.test.ts`:

```typescript
it('sets a tombstone via /delete and rejects subsequent /update calls', async () => {
	const { do: dof, storage } = await createDO({
		metadata: { ...baseMetadata, status: 'processing' }
	});

	// Delete the puzzle's metadata in the DO
	const deleteRes = await dof.fetch(
		new Request('https://puzzle-metadata/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ puzzleId: 'test-puzzle' })
		})
	);
	expect(deleteRes.status).toBe(200);

	// Subsequent update should be rejected (tombstoned)
	const updateRes = await dof.fetch(
		new Request('https://puzzle-metadata/update', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				puzzleId: 'test-puzzle',
				updates: { status: 'ready' }
			})
		})
	);
	expect(updateRes.status).toBe(404);
	const updateBody = await updateRes.json();
	expect(updateBody.message).toContain('deleted');
});

it('rejects /delete when puzzleId does not match DO identity', async () => {
	const { do: dof } = await createDO({
		puzzleId: 'test-puzzle',
		metadata: baseMetadata
	});
	const res = await dof.fetch(
		new Request('https://puzzle-metadata/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ puzzleId: 'wrong-puzzle' })
		})
	);
	expect(res.status).toBe(403);
});

it('allows /delete when DO has no metadata (idempotent tombstone)', async () => {
	const { do: dof } = await createDO({});
	const res = await dof.fetch(
		new Request('https://puzzle-metadata/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ puzzleId: 'test-puzzle' })
		})
	);
	expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/workflows && bun run test -- --reporter=verbose puzzle-metadata-do.test.ts`
Expected: FAIL — `/delete` route returns 404 (Not found, unhandled route)

- [ ] **Step 3: Implement `/delete` endpoint and tombstone check in PuzzleMetadataDO**

In `apps/workflows/src/index.ts`, add the `/delete` route in the `fetch` method, after the `/status` handler added in Task 1:

```typescript
if (url.pathname === '/delete') {
	return this.handleDelete(request);
}
```

Add the `handleDelete` method to `PuzzleMetadataDO`:

```typescript
/**
 * Tombstone the DO's metadata and clear storage. Called by the reaper
 * after deleting KV and R2 assets to prevent in-flight workflow updates
 * from resurrecting the puzzle in KV via the DO's KV sync. After this,
 * /update returns 404 (tombstoned) so the workflow's updateMetadata
 * calls fail fast instead of writing stale data back to KV.
 *
 * The tombstone is a separate storage key ('deleted') that persists
 * even after the metadata key is cleared. This is idempotent — calling
 * /delete on an already-deleted DO is a no-op (200).
 */
async handleDelete(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		puzzleId?: string;
	} | null;
	if (!body || typeof body.puzzleId !== 'string' || !body.puzzleId.trim()) {
		return Response.json({ message: 'Invalid delete payload' }, { status: 400 });
	}

	const { puzzleId } = body;

	let doPuzzleId = await this.ctx.storage.get<string>('puzzleId');
	if (!doPuzzleId) {
		doPuzzleId = puzzleId;
		await this.ctx.storage.put('puzzleId', doPuzzleId);
	} else if (doPuzzleId !== puzzleId) {
		return Response.json(
			{ message: 'Puzzle ID mismatch: request puzzleId does not match DO identity' },
			{ status: 403 }
		);
	}

	// Atomically set the tombstone and clear the metadata inside a
	// transaction so a concurrent /update that reads metadata between
	// the tombstone set and the metadata clear cannot resurrect it.
	await this.ctx.storage.transaction(async () => {
		await this.ctx.storage.put('deleted', true);
		await this.ctx.storage.delete('metadata');
	});

	return Response.json({ success: true });
}
```

Now add the tombstone check in the `/update` handler. In the `fetch` method, inside the `/update` path (after the puzzleId identity check, around line 160, and before the `storedProbe` read at line 185), add:

```typescript
// Reject updates to a tombstoned (reaped) puzzle. The reaper calls
// /delete after cleaning up KV and R2 assets; without this check, an
// in-flight workflow update would read the DO-stored metadata (or KV
// fallback), merge the update, write back to DO storage, and sync to
// KV — resurrecting a puzzle whose R2 assets were already deleted.
const isDeleted = await this.ctx.storage.get<boolean>('deleted');
if (isDeleted) {
	return Response.json(
		{ message: `Puzzle ${puzzleId} has been deleted (tombstoned); refusing update` },
		{ status: 404 }
	);
}
```

- [ ] **Step 4: Run DO test to verify it passes**

Run: `cd apps/workflows && bun run test -- --reporter=verbose puzzle-metadata-do.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for `deleteMetadataDO` helper**

Add to `apps/api/src/services/__tests__/storage-worker-do.test.ts` (or the reaper test file):

```typescript
describe('deleteMetadataDO', () => {
	it('calls the DO /delete endpoint', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await deleteMetadataDO(doNs, 'puzzle-1');
		expect(doNs.idFromName).toHaveBeenCalledWith('puzzle-1');
		expect(stub.fetch).toHaveBeenCalledWith(
			'https://puzzle-metadata/delete',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('throws on DO error', async () => {
		const stub = {
			fetch: vi.fn(async () => new Response('Internal error', { status: 500 }))
		};
		const doNs = {
			idFromName: vi.fn(() => 'id-1'),
			get: vi.fn(() => stub)
		} as any;
		await expect(deleteMetadataDO(doNs, 'puzzle-1')).rejects.toThrow();
	});
});
```

- [ ] **Step 6: Implement `deleteMetadataDO` helper in storage.worker.ts**

Add to `apps/api/src/services/storage.worker.ts`, after `getAuthoritativeStatus`:

```typescript
/**
 * Tombstone the metadata DO for a puzzle. Called by the reaper after
 * deleting KV and R2 assets to prevent in-flight workflow updates from
 * resurrecting the puzzle in KV via the DO's KV sync. After this call,
 * the DO's /update endpoint returns 404 (tombstoned).
 */
export async function deleteMetadataDO(
	metadataDO: DurableObjectNamespace,
	puzzleId: string
): Promise<void> {
	const id = metadataDO.idFromName(puzzleId);
	const stub = metadataDO.get(id);
	const response = await stub.fetch('https://puzzle-metadata/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ puzzleId })
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			payload?.message ?? `Failed to delete metadata DO for ${puzzleId} (HTTP ${response.status})`
		);
	}
}
```

- [ ] **Step 7: Run helper tests to verify they pass**

Run: `cd apps/api && bun run test -- --reporter=verbose storage-worker-do.test.ts`
Expected: PASS

- [ ] **Step 8: Write failing test for reaper calling DO delete**

Add to `apps/api/src/services/__tests__/reaper.test.ts`:

```typescript
it('calls deleteMetadataDO after reaping to tombstone the DO', async () => {
	(storage.listPuzzles as any).mockResolvedValue({
		puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
		invalidCount: 0
	});
	(storage.getPuzzle as any).mockResolvedValue({
		id: 'stuck-1',
		status: 'processing',
		name: 'Puzzle stuck-1',
		pieceCount: 100
	});
	(storage.getAuthoritativeStatus as any).mockResolvedValue('processing');
	(storage.deleteMetadataDO as any).mockResolvedValue(undefined);
	const env = makeEnv({ 'stuck-1': 'errored' });
	const result = await reapStuckPuzzles(env, NOW);
	expect(result.reaped).toBe(1);
	expect(storage.deleteMetadataDO).toHaveBeenCalledWith(env.PUZZLE_METADATA_DO, 'stuck-1');
});

it('still counts as reaped when DO tombstone fails (best-effort)', async () => {
	(storage.listPuzzles as any).mockResolvedValue({
		puzzles: [puzzleSummary('stuck-1', 'processing', OLD_PROCESSING)],
		invalidCount: 0
	});
	(storage.getPuzzle as any).mockResolvedValue({
		id: 'stuck-1',
		status: 'processing',
		name: 'Puzzle stuck-1',
		pieceCount: 100
	});
	(storage.getAuthoritativeStatus as any).mockResolvedValue('processing');
	(storage.deleteMetadataDO as any).mockRejectedValue(new Error('DO unavailable'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const env = makeEnv({ 'stuck-1': 'errored' });
	const result = await reapStuckPuzzles(env, NOW);
	expect(result.reaped).toBe(1);
	expect(result.details.some((d) => d.action === 'do-tombstone-failed')).toBe(true);
});
```

Update the mock at the top of the test file to include `deleteMetadataDO`:

```typescript
vi.mock('../storage.worker', () => ({
	deletePuzzleAssets: vi.fn(),
	deleteMetadataDO: vi.fn(),
	deletePuzzleMetadata: vi.fn(),
	getAuthoritativeStatus: vi.fn(),
	getPuzzle: vi.fn(),
	listPuzzles: vi.fn(),
	releaseIdempotencyKey: vi.fn()
}));
```

And add to imports and `storage` object:

```typescript
import {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} from '../storage.worker';

const storage = {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} as any;
```

- [ ] **Step 9: Run reaper test to verify it fails**

Run: `cd apps/api && bun run test -- --reporter=verbose reaper.test.ts`
Expected: FAIL — `deleteMetadataDO` is not called by the reaper

- [ ] **Step 10: Implement DO tombstone call in reaper**

In `apps/api/src/services/reaper.ts`, add `deleteMetadataDO` to the import from `./storage.worker`:

```typescript
import {
	deletePuzzleAssets,
	deleteMetadataDO,
	deletePuzzleMetadata,
	getAuthoritativeStatus,
	getPuzzle,
	listPuzzles,
	releaseIdempotencyKey
} from './storage.worker';
```

After the KV delete success block (after line 243, after the `releaseIdempotencyKey` block), add the DO tombstone call:

```typescript
// Best-effort DO tombstone. Without this, an in-flight workflow
// update can read the DO-stored metadata (which the reaper did not
// clear) and write it back to KV via the DO's KV sync, resurrecting
// a puzzle whose R2 assets were already deleted. The tombstone makes
// the DO's /update return 404 so the workflow's updateMetadata calls
// fail fast. Best-effort: a DO failure is logged, not fatal — the
// workflow's update will still fail because R2 assets are gone, but
// a KV resurrection is possible if the DO is unreachable. The next
// reaper run will retry the tombstone.
try {
	await deleteMetadataDO(env.PUZZLE_METADATA_DO, puzzle.id);
} catch (doErr) {
	console.error(`Reaper: failed to tombstone metadata DO for ${puzzle.id}:`, doErr);
	result.details.push({
		puzzleId: puzzle.id,
		action: 'do-tombstone-failed',
		error: String(doErr)
	});
}
```

- [ ] **Step 11: Run reaper tests to verify they pass**

Run: `cd apps/api && bun run test -- --reporter=verbose reaper.test.ts`
Expected: PASS

- [ ] **Step 12: Run full test suite for affected apps**

Run: `cd apps/api && bun run test && cd ../workflows && bun run test`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add apps/workflows/src/index.ts apps/api/src/services/storage.worker.ts apps/api/src/services/reaper.ts apps/workflows/src/puzzle-metadata-do.test.ts apps/api/src/services/__tests__/reaper.test.ts
git commit -m "$(cat <<'EOF'
fix: tombstone metadata DO after reaping to prevent KV resurrection

The reaper deleted KV and R2 assets but not the metadata DO's storage.
An in-flight workflow update could read the DO-stored metadata and
write it back to KV via the DO's KV sync, resurrecting a puzzle whose
R2 assets were already deleted. Now the reaper calls the DO's /delete
endpoint after reaping, which sets a tombstone and clears DO storage.
The DO's /update handler checks the tombstone and returns 404, so
workflow updates fail fast instead of resurrecting stale data.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Task 3: Admin Worker — Fence Stale-Pending Reclaims by Terminating Orphaned Workflows (P1)

**Fixes review item 1:** When the original upload is paused after writing metadata but before `PUZZLE_WORKFLOW.create`, a retry after `RESERVATION_PENDING_TTL_MS` marks the reservation failed and mints a new puzzleId. The original can subsequently start its workflow with the old ID, producing two puzzles from one Idempotency-Key. The fix: after `PUZZLE_WORKFLOW.create` succeeds, if the reservation commit fails (meaning a retry reclaimed the key), terminate the orphaned workflow and clean up its metadata/image.

**Files:**

- Modify: `apps/api/src/worker.ts` (add `terminate()` to `WorkflowInstance` interface)
- Modify: `apps/api/src/routes/admin.worker.ts` (terminate workflow + cleanup on commit failure)
- Test: `apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts`

**Interfaces:**

- Consumes: `WorkflowInstance.terminate()` from Cloudflare Workflows API
- Produces: Modified commit-failure path in POST /puzzles that terminates the workflow and cleans up

- [ ] **Step 1: Add `terminate()` to `WorkflowInstance` interface**

In `apps/api/src/worker.ts`, update the interface:

```typescript
export interface WorkflowInstance {
	id: string;
	status(): Promise<{ status: string }>;
	terminate(options?: { rollback?: boolean }): Promise<void>;
}
```

- [ ] **Step 2: Write failing test for workflow termination on commit failure**

Add to `apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts`:

```typescript
it('terminates the orphaned workflow and cleans up when commit fails because the reservation was reclaimed', async () => {
	// Simulate: original create succeeds, but a retry reclaimed the
	// reservation while the original was creating the workflow. The
	// commit fails with 409 ("Cannot commit reservation in status
	// failed" or "Reservation owned by another puzzle").
	(storage.reserveIdempotencyKey as any).mockResolvedValue({
		existing: false,
		puzzleId: 'puzzle-1'
	});
	(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
	(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

	const terminateFn = vi.fn().mockResolvedValue(undefined);
	const workflow = {
		create: vi.fn().mockResolvedValue(undefined),
		get: vi.fn(async () => ({
			status: vi.fn().mockResolvedValue({ status: 'running' }),
			terminate: terminateFn
		}))
	};
	const env = createEnv(workflow as any);

	// Commit fails on all 3 attempts with 409
	(storage.commitIdempotencyKey as any).mockRejectedValue(
		new Error('Cannot commit reservation in status failed')
	);
	(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
	(storage.deleteOriginalImage as any).mockResolvedValue({ success: true });

	const response = await admin.fetch(createRequest('fence-key-1'), env as any);

	// Should return 500 (client retries, gets the retry's puzzle)
	expect(response.status).toBe(500);
	// Workflow must be terminated
	expect(terminateFn).toHaveBeenCalled();
	// Metadata and image must be cleaned up
	expect(storage.deletePuzzleMetadata).toHaveBeenCalledWith(env.PUZZLE_METADATA, 'puzzle-1');
	expect(storage.deleteOriginalImage).toHaveBeenCalledWith(env.PUZZLES_BUCKET, 'puzzle-1');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && bun run test -- --reporter=verbose admin-idempotency.worker.test.ts`
Expected: FAIL — `terminateFn` is not called (current code just returns 500 without terminating)

- [ ] **Step 4: Implement workflow termination on commit failure**

In `apps/api/src/routes/admin.worker.ts`, modify the commit-failure path (around line 1193). Replace the current `if (!committed)` block:

```typescript
if (!committed) {
	// The puzzle and workflow already exist, but the reservation is
	// still pending. Returning 201 would let the pending TTL expire
	// into a reclaimable state, allowing a duplicate workflow.
	// Return 500 instead so the client retries the POST — the retry
	// hits the existing-puzzle branch and returns the original
	// puzzle (200) once KV propagates, and best-effort commits the
```

...with:

```typescript
if (!committed) {
	// The commit failed, which means the reservation was reclaimed
	// by a retry (stale-pending reclaim marked it failed, then a
	// retry minted a new puzzleId). The workflow we just created is
	// orphaned — it's running against puzzleId A while the retry is
	// building puzzleId B under the same Idempotency-Key. Terminate
	// the orphaned workflow and clean up its metadata/image so only
	// the retry's puzzle survives. Return 500 so the client retries
	// and gets the retry's puzzle.
	console.error(
		`Commit failed for puzzle ${id} — reservation was reclaimed by a retry. Terminating orphaned workflow.`
	);
	try {
		const instance = await c.env.PUZZLE_WORKFLOW.get(id);
		await instance.terminate();
	} catch (termErr) {
		console.error(`Failed to terminate orphaned workflow ${id}:`, termErr);
	}
	// Clean up the orphaned puzzle's metadata and image
	const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
	if (!metadataCleanup.success) {
		console.error(
			'Failed to cleanup orphaned puzzle metadata after commit failure:',
			metadataCleanup.error
		);
	}
	const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
	if (!imageCleanup.success) {
		console.error(
			'Failed to cleanup orphaned puzzle image after commit failure:',
			imageCleanup.error
		);
	}
	await withDbBestEffort(
		c.env,
		'Failed to cleanup ownership after commit failure:',
		`Failed to init DB for ownership cleanup of puzzle ${id}:`,
		(db) => deletePuzzleOwnership(db, id)
	);
	return c.json(
		{
			error: 'internal_error',
			message: 'Idempotency reservation was reclaimed by a retry; puzzle cleaned up'
		},
		500
	);
}
```

Note: `deletePuzzleOwnership` is already imported from `@perseus/shared` at the top of the file. `withDbBestEffort` is already defined. `deletePuzzleMetadata` and `deleteOriginalImage` are already imported from `../services/storage.worker`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && bun run test -- --reporter=verbose admin-idempotency.worker.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `cd apps/api && bun run test`
Expected: PASS — no regressions in existing idempotency tests

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/worker.ts apps/api/src/routes/admin.worker.ts apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts
git commit -m "$(cat <<'EOF'
fix: terminate orphaned workflow when idempotency commit fails

When the original create paused after writing metadata but before
PUZZLE_WORKFLOW.create, a retry after the pending TTL could mark the
reservation failed and mint a new puzzleId. The original would then
start its workflow with the old ID, producing two puzzles from one
Idempotency-Key. Now, when the commit fails (meaning the reservation
was reclaimed), the orphaned workflow is terminated and its metadata
and image are cleaned up, so only the retry's puzzle survives.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Task 4: Admin Worker — Treat Workflow Creation Failures as Ambiguous (P2)

**Fixes review item 3:** If `PUZZLE_WORKFLOW.create` commits the instance on Cloudflare's side but the response times out, the catch deletes metadata/image and releases the idempotency reservation. The workflow can still run against deleted input, while a retry mints a second puzzle. The fix: on create failure, probe the workflow liveness before cleaning up. If alive, retain metadata/reservation and return 500. If dead, cleanup and release as before.

**Files:**

- Modify: `apps/api/src/routes/admin.worker.ts` (probe liveness in create-failure catch)
- Test: `apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts`

**Interfaces:**

- Consumes: `probeWorkflowLiveness` (already defined in admin.worker.ts at line 248)

- [ ] **Step 1: Write failing test for liveness probe on create failure**

Add to `apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts`:

```typescript
it('retains metadata and reservation when workflow create fails but workflow is alive (ambiguous failure)', async () => {
	(storage.reserveIdempotencyKey as any).mockResolvedValue({
		existing: false,
		puzzleId: 'puzzle-1'
	});
	(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
	(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

	// create() throws (timeout), but the workflow was actually created
	// — get().status() returns 'running'
	const workflow = {
		create: vi.fn().mockRejectedValue(new Error('RPC timeout')),
		get: vi.fn(async () => ({
			status: vi.fn().mockResolvedValue({ status: 'running' }),
			terminate: vi.fn()
		}))
	};
	const env = createEnv(workflow as any);

	// Commit should be called (workflow is alive, so we retain + commit)
	(storage.commitIdempotencyKey as any).mockResolvedValue(undefined);

	const response = await admin.fetch(createRequest('ambiguous-key-1'), env as any);

	// Should return 500 (client retries, hits existing-puzzle branch)
	expect(response.status).toBe(500);
	// Must NOT delete metadata or image — workflow is alive
	expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	expect(storage.deleteOriginalImage).not.toHaveBeenCalled();
	// Must NOT release the reservation — commit it instead
	expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
	expect(storage.commitIdempotencyKey).toHaveBeenCalledWith(
		env.PUZZLE_METADATA_DO,
		'ambiguous-key-1',
		'puzzle-1'
	);
});

it('cleans up and releases when workflow create fails and workflow is dead', async () => {
	(storage.reserveIdempotencyKey as any).mockResolvedValue({
		existing: false,
		puzzleId: 'puzzle-1'
	});
	(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
	(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

	// create() throws, and the workflow was NOT created — get() throws not_found
	const notFoundError = new Error('instance.not_found');
	(notFoundError as any).code = 'instance.not_found';
	const workflow = {
		create: vi.fn().mockRejectedValue(new Error('create failed')),
		get: vi.fn(async () => {
			throw notFoundError;
		})
	};
	const env = createEnv(workflow as any);

	(storage.deletePuzzleMetadata as any).mockResolvedValue({ success: true });
	(storage.deleteOriginalImage as any).mockResolvedValue({ success: true });
	(storage.releaseIdempotencyKey as any).mockResolvedValue(undefined);

	const response = await admin.fetch(createRequest('dead-key-1'), env as any);

	expect(response.status).toBe(500);
	// Should clean up (workflow was not created)
	expect(storage.deletePuzzleMetadata).toHaveBeenCalled();
	expect(storage.deleteOriginalImage).toHaveBeenCalled();
	expect(storage.releaseIdempotencyKey).toHaveBeenCalled();
});

it('retains metadata and returns 500 when workflow create fails and liveness is unknown', async () => {
	(storage.reserveIdempotencyKey as any).mockResolvedValue({
		existing: false,
		puzzleId: 'puzzle-1'
	});
	(storage.uploadOriginalImage as any).mockResolvedValue(undefined);
	(storage.createPuzzleMetadata as any).mockResolvedValue(undefined);

	// create() throws, and the workflow API is unreachable (not not_found)
	const workflow = {
		create: vi.fn().mockRejectedValue(new Error('RPC timeout')),
		get: vi.fn(async () => {
			throw new Error('workflow API down');
		})
	};
	const env = createEnv(workflow as any);

	const response = await admin.fetch(createRequest('unknown-key-1'), env as any);

	expect(response.status).toBe(500);
	// Must NOT clean up — liveness unknown, fail closed
	expect(storage.deletePuzzleMetadata).not.toHaveBeenCalled();
	expect(storage.deleteOriginalImage).not.toHaveBeenCalled();
	expect(storage.releaseIdempotencyKey).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun run test -- --reporter=verbose admin-idempotency.worker.test.ts`
Expected: FAIL — current code always cleans up on create failure regardless of liveness

- [ ] **Step 3: Implement liveness probe in create-failure catch**

In `apps/api/src/routes/admin.worker.ts`, modify the catch block at line 1117. Replace the entire catch block (lines 1117-1170) with:

```typescript
} catch (error) {
	console.error('Failed to trigger workflow:', error);

	// PUZZLE_WORKFLOW.create failure is ambiguous: the RPC may have
	// committed the instance on Cloudflare's side even though the
	// response was lost (timeout, network error). Cleaning up
	// unconditionally would delete the metadata/image the workflow
	// needs, and releasing the reservation would let a retry mint a
	// second puzzle. Probe the workflow liveness first:
	//   - alive: the workflow was created — retain metadata, commit
	//     the reservation, return 500 so the client retries and hits
	//     the existing-puzzle branch.
	//   - dead: the workflow was not created — clean up and release
	//     as before.
	//   - unknown: workflow API unreachable — fail closed (retain
	//     everything, return 500) to avoid minting a duplicate or
	//     destroying a live workflow's input.
	const liveness = await probeWorkflowLiveness(c.env.PUZZLE_WORKFLOW, id);

	if (liveness === 'alive') {
		// Workflow was created despite the create() error. Commit the
		// reservation so a retry hits the existing-puzzle branch.
		if (reservedIdempotencyKey) {
			try {
				await commitIdempotencyKey(
					c.env.PUZZLE_METADATA_DO,
					reservedIdempotencyKey,
					id
				);
				reservedIdempotencyKey = undefined;
			} catch (commitErr) {
				console.error(
					'Failed to commit reservation after ambiguous workflow create (alive):',
					commitErr
				);
				// Don't clean up — the workflow is running. Return 500
				// so the client retries and the existing-puzzle branch
				// handles it.
			}
		}
		return c.json(
			{
				error: 'internal_error',
				message: 'Workflow creation was ambiguous (workflow is alive); retry to retrieve puzzle'
			},
			500
		);
	}

	if (liveness === 'unknown') {
		// Workflow API unreachable — fail closed. Don't clean up or
		// release. The client retries; if the workflow was created,
		// the retry hits the existing-puzzle branch. If not, the
		// pending reservation TTL eventually makes it reclaimable.
		return c.json(
			{
				error: 'internal_error',
				message: 'Workflow creation failed and liveness could not be verified; retry'
			},
			500
		);
	}

	// liveness === 'dead' — workflow was not created. Clean up and
	// release as before.
	const metadataCleanup = await deletePuzzleMetadata(c.env.PUZZLE_METADATA, id);
	if (!metadataCleanup.success) {
		console.error(
			'Failed to cleanup puzzle metadata after workflow trigger failure:',
			metadataCleanup.error
		);
		await failReservation();
		return c.json(
			{
				error: 'internal_error',
				message:
					'Puzzle may be stuck in processing; metadata cleanup failed after workflow trigger failure'
			},
			500
		);
	}
	const imageCleanup = await deleteOriginalImage(c.env.PUZZLES_BUCKET, id);
	if (!imageCleanup.success) {
		console.error(
			'Failed to cleanup original image after workflow trigger failure:',
			imageCleanup.error
		);
		await failReservation();
		return c.json(
			{
				error: 'internal_error',
				message:
					'Puzzle may be stuck in processing; image cleanup failed after workflow trigger failure'
			},
			500
		);
	}
	await withDbBestEffort(
		c.env,
		'Failed to cleanup ownership after workflow trigger failure:',
		`Failed to init DB for ownership cleanup of puzzle ${id}:`,
		(db) => deletePuzzleOwnership(db, id)
	);
	await releaseReservation();
	return c.json({ error: 'internal_error', message: 'Failed to start puzzle processing' }, 500);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun run test -- --reporter=verbose admin-idempotency.worker.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd apps/api && bun run test`
Expected: PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin.worker.ts apps/api/src/routes/__tests__/admin-idempotency.worker.test.ts
git commit -m "$(cat <<'EOF'
fix: probe workflow liveness before cleanup on create failure

PUZZLE_WORKFLOW.create failure is ambiguous — the RPC may have committed
the instance on Cloudflare's side even though the response was lost.
Previously the catch unconditionally deleted metadata/image and released
the reservation, which could destroy a live workflow's input or let a
retry mint a duplicate. Now the catch probes the workflow liveness:
alive → retain + commit + 500; dead → cleanup + release (as before);
unknown → fail closed (retain everything + 500).

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Self-Review

### Spec Coverage

| Review Item                                           | Task   | Status                                                  |
| ----------------------------------------------------- | ------ | ------------------------------------------------------- |
| [P1] Fence stale-pending reclaims                     | Task 3 | Covered — terminate orphaned workflow on commit failure |
| [P1] Verify authoritative status before reaping       | Task 1 | Covered — DO /status check before reaping               |
| [P2] Treat workflow creation failures as ambiguous    | Task 4 | Covered — liveness probe before cleanup                 |
| [P2] Prevent stale workflow updates from resurrecting | Task 2 | Covered — DO tombstone via /delete endpoint             |

### Placeholder Scan

No placeholders. All steps contain actual code, exact file paths, and specific test assertions.

### Type Consistency

- `getAuthoritativeStatus` returns `string | null` (storage.worker.ts) — reaper checks `=== 'ready'` and catches throws ✓
- `deleteMetadataDO` returns `Promise<void>` (storage.worker.ts) — reaper wraps in try/catch ✓
- `WorkflowInstance.terminate(options?: { rollback?: boolean }): Promise<void>` (worker.ts) — admin worker calls `instance.terminate()` ✓
- `probeWorkflowLiveness` returns `'alive' | 'dead' | 'unknown'` (admin.worker.ts:251) — Task 4 checks all three branches ✓
- DO `/status` returns `{ status: string }` with 200, 404, or 403 — `getAuthoritativeStatus` handles 200 (parse), 404 (null), else (throw) ✓
- DO `/delete` returns `{ success: true }` with 200, 400, or 403 — `deleteMetadataDO` handles 200 (ok), else (throw) ✓

### Interaction Between Tasks

- Tasks 1 and 2 both modify the reaper and the DO. Task 1 adds `/status`, Task 2 adds `/delete`. They are independent endpoints — no conflict.
- Tasks 3 and 4 both modify the admin worker's workflow create path. Task 3 modifies the commit-failure path (after create succeeds), Task 4 modifies the create-failure catch (before commit). They are in different code sections — no conflict.
- Task 3 adds `terminate()` to the `WorkflowInstance` interface. Task 4's liveness probe uses `workflow.get()` which returns `WorkflowInstance` — the interface change is compatible.
