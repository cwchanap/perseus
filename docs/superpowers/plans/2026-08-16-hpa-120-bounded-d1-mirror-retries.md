# HPA-120 Bounded D1 Mirror Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry short transient D1 puzzle-status mirror failures a few times while keeping DO/KV authoritative and preserving current workflow success/failure behavior.

**Architecture:** Use Cloudflare `step.do` retry config for the success-path `mirror-ready-status-to-d1` step that already exists. Keep the two mirrors already inside `mark-failed` in that step and route them through one tiny local three-attempt helper with short delays. Do not restructure the canonical failure path or add persistent reconciliation machinery.

**Tech Stack:** Cloudflare Workflows, TypeScript, Drizzle/D1, Vitest, Bun.

## Global constraints

- Follow `docs/superpowers/specs/2026-08-16-hpa-120-bounded-d1-mirror-retries-design.md`.
- D1 remains a best-effort mirror; DO/KV remains authoritative.
- Cover all three D1 mirror sites.
- Success-path `ready`: use Workflow step retry config, not a hand-written loop.
- In-step `failed` + already-ready `ready`: use one small local manual helper; do not restructure `mark-failed` into more Workflow steps.
- Three total attempts for every D1 mirror.
- Reuse the current short 100 ms exponential-backoff shape: 100 ms then 200 ms before the final attempt.
- Do not change the existing authoritative `mark-failed` DO retry loop.
- Do not let an exhausted D1 mirror throw out of `mark-failed` or turn a successful `ready` workflow into failure.
- Log one clear final application error with puzzle ID and target status after the D1 retry budget is exhausted.
- No per-attempt D1 error logs.
- No schema, migration, outbox, queue, alarm, reaper, read-time reconciliation, new dependency, or shared retry framework.
- Expected implementation files only: `apps/workflows/src/index.ts` and `apps/workflows/src/index.test.ts`.

---

## Task 1: Pin the success-path Workflow retry behavior with tests

**Files:**

- Modify: `apps/workflows/src/index.test.ts`

**Purpose:** The current `createMockStep()` always invokes a callback once, so it cannot prove that a retry-configured `step.do` observes and retries a transient D1 throw.

- [ ] **Step 1: Add opt-in retry-config simulation to `createMockStep()`**

Keep existing tests on one-attempt behavior by default. Add an option such as:

```ts
createMockStep({ respectRetryConfig: true })
```

When enabled, the mock `do()` implementation should:

```text
if config.retries.limit exists:
    attempt callback up to that total count
    return immediately on success
    throw the final error after exhaustion
else:
    run once
```

Do not simulate delay/backoff. Cloudflare owns those timing semantics; these tests only need the retry count and error boundary.

Keep the `(name, callback)` overload working exactly as it does today.

- [ ] **Step 2: Add a transient ready-mirror test**

Extend `Workflow Execution - D1 ready mirror is best-effort` rather than creating a second describe block.

Setup:

```ts
vi.mocked(setPuzzleStatus)
	.mockRejectedValueOnce(new Error('D1 transient'))
	.mockResolvedValueOnce(undefined);
```

Run with the retry-aware mock step.

Assert:

- the workflow resolves;
- `setPuzzleStatus(..., puzzleId, 'ready')` is called twice;
- no D1 `failed` write occurs;
- the authoritative DO's final status remains `ready`;
- `mirror-ready-status-to-d1` receives a retry config with a three-attempt limit.

- [ ] **Step 3: Update the existing permanent ready failure test**

Instead of one rejection, make `setPuzzleStatus` reject every attempt and use the retry-aware mock step.

Assert:

- exactly three `ready` calls occur;
- the workflow still resolves;
- no `failed` mirror/canonical transition is introduced;
- final DO status is `ready`;
- exactly one explicit terminal D1 error log contains the puzzle ID and target status `ready`.

Do not assert one log per attempt; the production callback should not log transient failures.

- [ ] **Step 4: Run the focused suite and confirm red**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

Expected before production changes: transient ready does not retry because the current inner `try/catch` swallows the D1 error, and no retry config is passed to the step.

---

## Task 2: Enable built-in retry on `mirror-ready-status-to-d1`

**Files:**

- Modify: `apps/workflows/src/index.ts`
- Verify: `apps/workflows/src/index.test.ts`

- [ ] **Step 1: Add shared D1 retry constants near the existing workflow-local constants**

```ts
const D1_MIRROR_MAX_ATTEMPTS = 3;
const D1_MIRROR_BASE_DELAY_MS = 100;

const D1_MIRROR_STEP_CONFIG = {
	retries: {
		limit: D1_MIRROR_MAX_ATTEMPTS,
		delay: D1_MIRROR_BASE_DELAY_MS,
		backoff: 'exponential'
	}
} as const;
```

Cloudflare currently documents `retries.limit` as total attempts. Keep the local helper in Task 3 on the same three-attempt bound.

Reference: <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>

- [ ] **Step 2: Move the success-path catch outside `step.do`**

Current shape:

```ts
await step.do('mirror-ready-status-to-d1', async () => {
	try {
		await setPuzzleStatus(getDb(this.env), puzzleId, 'ready');
	} catch (d1Error) {
		console.error(...);
	}
});
```

Change to:

```ts
try {
	await step.do('mirror-ready-status-to-d1', D1_MIRROR_STEP_CONFIG, async () => {
		await setPuzzleStatus(getDb(this.env), puzzleId, 'ready');
	});
} catch (d1Error) {
	console.error(
		`Failed to mirror puzzle ${puzzleId} status ready to D1 after ${D1_MIRROR_MAX_ATTEMPTS} attempts:`,
		d1Error
	);
}
```

The callback must throw on D1 failure so Workflow can retry it. The outer catch keeps exhausted retries non-fatal.

Keep this entire mirror after the main generation `try/catch`; do not move it into `finalize`.

- [ ] **Step 3: Run focused tests and confirm the ready cases are green**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

---

## Task 3: Add one bounded helper for the two mirrors inside `mark-failed`

**Files:**

- Modify: `apps/workflows/src/index.test.ts`
- Modify: `apps/workflows/src/index.ts`

### Part A — write the in-step retry tests first

- [ ] **Step 1: Add transient `failed` mirror coverage**

Extend the existing `mirrors the failed status into D1 on mark-failed` test.

Use fake timers because the production helper will wait 100 ms between attempts:

```ts
vi.useFakeTimers();
try {
	// arrange first D1 failure, second success
	const assertionPromise = expect(workflow.run(event, createMockStep())).rejects.toThrow(
		expectedOriginalError
	);
	await vi.runAllTimersAsync();
	await assertionPromise;
} finally {
	vi.useRealTimers();
}
```

Assert:

- `setPuzzleStatus(..., 'failed')` is called twice;
- the authoritative DO `failed` transition remains successful;
- the workflow still rejects with the original processing error, not the transient D1 error.

Do not use `respectRetryConfig` here: these retries happen inside the local helper, not through Workflow step config.

- [ ] **Step 2: Add permanent `failed` mirror coverage**

Make D1 reject every helper attempt.

Assert:

- exactly three `failed` writes are attempted;
- fake timers flush the 100 ms + 200 ms waits;
- one final D1 error log contains the puzzle ID and target status `failed`;
- the workflow still rejects with the original processing error;
- the existing canonical `mark-failed` success is not converted into CRITICAL failure solely because D1 stayed down.

This test pins helper exhaustion once; do not duplicate the same permanent-loop fixture for both statuses unless implementation behavior differs.

- [ ] **Step 3: Add transient already-ready reconciliation coverage**

Extend `Workflow Execution - mark-failed already-ready reconciliation`.

Arrange the existing recognized DO 409, then make D1 `ready` reject once and succeed on the second attempt.

Assert:

- D1 `ready` is attempted twice;
- no D1 `failed` write occurs;
- no canonical CRITICAL log occurs;
- the existing `already ready` warning still occurs;
- the workflow preserves its original processing-error rejection.

Use fake timers and restore them in `finally`.

- [ ] **Step 4: Run focused tests and confirm red**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

Expected before implementation: both in-step D1 sites still attempt only once.

### Part B — implement the small helper

- [ ] **Step 5: Add `mirrorPuzzleStatusWithRetry()` locally in `index.ts`**

Place it near `getDb()`/the local retry constants; do not export it.

Use the already imported `AppDb` and `setPuzzleStatus`:

```ts
async function mirrorPuzzleStatusWithRetry(
	db: AppDb,
	puzzleId: string,
	status: 'ready' | 'failed'
): Promise<void> {
	let lastError: unknown;

	for (let attempt = 0; attempt < D1_MIRROR_MAX_ATTEMPTS; attempt++) {
		try {
			await setPuzzleStatus(db, puzzleId, status);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < D1_MIRROR_MAX_ATTEMPTS - 1) {
				await new Promise((resolve) =>
					setTimeout(resolve, D1_MIRROR_BASE_DELAY_MS * Math.pow(2, attempt))
				);
			}
		}
	}

	console.error(
		`Failed to mirror puzzle ${puzzleId} status ${status} to D1 after ${D1_MIRROR_MAX_ATTEMPTS} attempts:`,
		lastError
	);
}
```

Important behavior:

- intermediate D1 failures are silent;
- exhaustion logs once;
- exhaustion does **not** throw;
- no callback/strategy injection or generic retry abstraction.

- [ ] **Step 6: Replace the already-ready one-shot D1 block**

Inside the existing `if (alreadyReady)` branch:

```ts
await mirrorPuzzleStatusWithRetry(getDb(this.env), puzzleId, 'ready');
return;
```

Keep the existing already-ready warning and canonical branch logic unchanged.

- [ ] **Step 7: Replace the successful failed-status one-shot D1 block**

Inside the existing `if (doSucceeded)` branch:

```ts
await mirrorPuzzleStatusWithRetry(getDb(this.env), puzzleId, 'failed');
return;
```

Do not change the DO retry loop, `doSucceeded`, or CRITICAL path.

- [ ] **Step 8: Run focused tests and confirm green**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

---

## Task 4: Run the workflows package gate and inspect scope

**Files:**

- Modify if needed: `apps/workflows/src/index.test.ts`
- No new production files.

- [ ] **Step 1: Re-read overlapping existing tests**

Confirm the final suite still directly protects:

- normal ready mirror success;
- transient ready step retry;
- permanent ready step exhaustion remains non-fatal;
- normal failed mirror success;
- transient/permanent failed helper behavior;
- transient already-ready helper behavior;
- existing authoritative `mark-failed` retry exhaustion/CRITICAL behavior;
- recognized already-ready 409 behavior;
- original processing error preservation.

Prefer updating existing assertions over adding duplicate workflow fixtures.

- [ ] **Step 2: Run full workflows unit tests**

```bash
cd apps/workflows
bun run test:unit
```

Expected: all tests and configured coverage gates pass.

- [ ] **Step 3: Run static checks**

```bash
cd apps/workflows
bun run check
bun run lint
```

- [ ] **Step 4: Run Wrangler dry-run build**

```bash
cd apps/workflows
bun run build
```

This confirms the installed Worker types/toolchain accept the step retry config.

- [ ] **Step 5: Inspect the final implementation diff**

```bash
git diff --check
git diff -- apps/workflows/src/index.ts apps/workflows/src/index.test.ts
```

Expected production/test scope:

```text
apps/workflows/src/index.ts
apps/workflows/src/index.test.ts
```

If the implementation starts adding a schema, migration, queue, outbox, alarm, reaper, profile-read changes, or a general retry package, stop and split that work into a separate follow-up rather than expanding HPA-120.

## Completion checklist

- [ ] Success-path ready mirror passes a three-attempt retry config to its existing Workflow step.
- [ ] Success-path D1 callback no longer catches transient errors internally.
- [ ] Outer ready-step catch keeps exhausted D1 retries non-fatal.
- [ ] Already-ready and failed mirrors share one local three-attempt helper.
- [ ] Local helper uses short bounded 100/200 ms waits and never throws after exhaustion.
- [ ] Exhausted mirrors log once with puzzle ID and target status.
- [ ] Authoritative DO retry/state logic is unchanged.
- [ ] No persistent reconciliation machinery or new production module is added.
- [ ] Focused tests, full workflows unit suite, typecheck, lint, and dry-run build pass.
