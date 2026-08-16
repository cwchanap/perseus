# HPA-120 Bounded D1 Mirror Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry short transient D1 puzzle-status mirror failures a few times while keeping DO/KV authoritative and preserving current workflow success/failure behavior.

**Architecture:** Use Cloudflare `step.do` retry config for the success-path `mirror-ready-status-to-d1` step that already exists. Keep the two mirrors already inside `mark-failed` in that step and route them through one tiny local three-attempt helper. The two mechanisms share the attempt count but intentionally use different delay scales: durable Workflow retries start at 10 seconds; the in-step helper waits only 100/200 ms.

**Tech Stack:** Cloudflare Workflows, TypeScript, Drizzle/D1, Vitest, Bun.

## Global constraints

- Follow `docs/superpowers/specs/2026-08-16-hpa-120-bounded-d1-mirror-retries-design.md`.
- D1 remains a best-effort mirror; DO/KV remains authoritative.
- Cover all three D1 mirror sites.
- Success-path `ready`: use Workflow step retry config, not a hand-written loop.
- In-step `failed` + already-ready `ready`: use one small local manual helper; do not restructure `mark-failed` into more Workflow steps.
- Three **total attempts** for every D1 mirror.
- Success-path Workflow retry timing: `delay: '10 seconds'`, `backoff: 'exponential'`.
- In-step helper timing only: 100 ms then 200 ms before the final attempt.
- Do not change the existing authoritative `mark-failed` DO retry loop.
- Do not let an exhausted D1 mirror throw out of `mark-failed` or turn a successful `ready` workflow into failure.
- Log one clear final application error with puzzle ID and target status after the D1 retry budget is exhausted.
- No per-attempt D1 application logs.
- No schema, migration, outbox, queue, alarm, reaper, read-time reconciliation, new dependency, or shared retry framework.
- Expected implementation files only: `apps/workflows/src/index.ts` and `apps/workflows/src/index.test.ts`.

---

## Task 1: Pin the success-path Workflow retry contract with tests

**Files:**

- Modify: `apps/workflows/src/index.test.ts`

**Purpose:** The current `createMockStep()` always invokes a callback once, so it cannot prove that a retry-configured `step.do` observes and retries a transient D1 throw.

### Interfaces

- Existing: `createMockStep(): WorkflowStep`
- Extend locally: `createMockStep(options?: { respectRetryConfig?: boolean }): WorkflowStep`
- Default remains one callback invocation.
- Opt-in retry mode models only documented retry count/error propagation, not elapsed time.

- [ ] **Step 1: Add opt-in retry-config simulation to `createMockStep()`**

Keep existing tests on one-attempt behavior by default. Add:

```ts
function createMockStep(options: { respectRetryConfig?: boolean } = {}): WorkflowStep {
	return {
		do: vi.fn(async (_name: string, configOrFn: unknown, maybeFn?: unknown) => {
			const hasConfig = typeof configOrFn !== 'function';
			const config = hasConfig
				? (configOrFn as { retries?: { limit?: number; delay?: string | number; backoff?: string } })
				: undefined;
			const fn = (hasConfig ? maybeFn : configOrFn) as () => Promise<unknown>;

			// Contract model only: Cloudflare documents retries.limit as the total
			// number of attempts. Delay/backoff are asserted separately but are not
			// slept here. The final error reaches the caller only after exhaustion.
			const attempts = options.respectRetryConfig ? (config?.retries?.limit ?? 1) : 1;
			let lastError: unknown;
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				try {
					return await fn();
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError;
		}),
		sleep: vi.fn(async () => undefined),
		sleepUntil: vi.fn(async () => undefined),
		waitForEvent: vi.fn(async () => ({
			payload: {},
			timestamp: new Date(),
			type: 'event'
		}))
	} as WorkflowStep;
}
```

Do not simulate the configured 10-second delay. That timing belongs to Cloudflare Workflows, not this mock.

- [ ] **Step 2: Add a transient ready-mirror sibling test**

Add a new `it()` beside the existing `Workflow Execution - D1 ready mirror is best-effort` coverage.

Setup:

```ts
vi.mocked(setPuzzleStatus)
	.mockRejectedValueOnce(new Error('D1 transient'))
	.mockResolvedValueOnce(undefined);
```

Run with:

```ts
const step = createMockStep({ respectRetryConfig: true });
await expect(workflow.run(event, step)).resolves.toBeUndefined();
```

Assert:

```ts
expect(setPuzzleStatus).toHaveBeenCalledTimes(2);
expect(setPuzzleStatus).toHaveBeenCalledWith(expect.anything(), puzzleId, 'ready');
expect(setPuzzleStatus).not.toHaveBeenCalledWith(expect.anything(), puzzleId, 'failed');

expect(step.do).toHaveBeenCalledWith(
	'mirror-ready-status-to-d1',
	{
		retries: {
			limit: 3,
			delay: '10 seconds',
			backoff: 'exponential'
		}
	},
	expect.any(Function)
);
```

The assertion pins the documented contract used by production: `limit: 3` means three total attempts. The mock retries before an exhausted error can reach the outer production catch; it does not emulate real delay.

- [ ] **Step 3: Update the existing permanent ready failure case for exhaustion**

Make `setPuzzleStatus` reject every ready attempt and use `createMockStep({ respectRetryConfig: true })`.

Assert:

- exactly three `ready` calls occur;
- the workflow still resolves because the outer catch keeps D1 best-effort;
- no D1 `failed` write occurs;
- final authoritative DO status is `ready`;
- exactly one explicit terminal D1 error log contains the puzzle ID and target status `ready`.

Do not assert or simulate elapsed retry delay in this test.

- [ ] **Step 4: Run the focused suite and confirm red**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

Expected before production changes: transient ready does not retry because the current inner `try/catch` swallows the D1 error, and no retry config is passed to the step.

---

## Task 2: Enable durable retry on `mirror-ready-status-to-d1`

**Files:**

- Modify: `apps/workflows/src/index.ts`
- Verify: `apps/workflows/src/index.test.ts`

### Interfaces

- Reuses existing `setPuzzleStatus(getDb(this.env), puzzleId, 'ready')`.
- Produces one explicit `WorkflowStepConfig` used only by the existing ready mirror step.

- [ ] **Step 1: Add the shared attempt count and mechanism-specific delay constants**

Place near the existing workflow-local constants:

```ts
const D1_MIRROR_MAX_ATTEMPTS = 3;
const D1_MIRROR_IN_STEP_BASE_DELAY_MS = 100;

const D1_MIRROR_STEP_CONFIG = {
	retries: {
		limit: D1_MIRROR_MAX_ATTEMPTS,
		delay: '10 seconds',
		backoff: 'exponential'
	}
} as const;
```

Cloudflare currently documents:

- `retries.limit` is the **total number of attempts**;
- default Workflow retry base delay is 10 seconds;
- waiting for a retry is a durable Workflow waiting state rather than an in-process `setTimeout`.

Reference: <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>

Do **not** reuse `D1_MIRROR_IN_STEP_BASE_DELAY_MS` inside `D1_MIRROR_STEP_CONFIG`.

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

Keep this entire mirror after the main generation `try/catch`; do not move it into `finalize`. That separation is load-bearing because a D1 throw must never enter canonical `mark-failed`.

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

### Interfaces

- Reuses existing `AppDb`, `getDb()`, and `setPuzzleStatus()`.
- Produces local `mirrorPuzzleStatusWithRetry(db, puzzleId, status): Promise<void>`.
- Helper never throws after retry exhaustion.

### Part A — write the in-step retry tests first

- [ ] **Step 1: Preserve the current one-shot failed-mirror success test, then add a transient sibling**

Leave the existing `mirrors the failed status into D1 on mark-failed (keeps stores in sync)` test as the baseline success case. Do **not** rewrite it into the transient case.

Add a new sibling `it()` using fake timers:

```ts
vi.useFakeTimers();
try {
	vi.mocked(setPuzzleStatus)
		.mockRejectedValueOnce(new Error('D1 transient'))
		.mockResolvedValueOnce(undefined);

	const assertionPromise = expect(workflow.run(event, createMockStep())).rejects.toThrow(
		expectedOriginalError
	);
	await vi.runAllTimersAsync();
	await assertionPromise;

	expect(setPuzzleStatus).toHaveBeenCalledTimes(2);
	expect(setPuzzleStatus).toHaveBeenCalledWith(expect.anything(), puzzleId, 'failed');
} finally {
	vi.useRealTimers();
}
```

Also assert the authoritative DO `failed` transition remains successful and the workflow rejects with the original processing error, not the transient D1 error.

Do not use `respectRetryConfig` here: these retries happen inside the local helper, not through Workflow step config.

- [ ] **Step 2: Add permanent `failed` mirror sibling coverage**

Make D1 reject every helper attempt.

Assert:

- exactly three `failed` writes are attempted;
- fake timers flush the 100 ms + 200 ms waits;
- one final D1 error log contains the puzzle ID and target status `failed`;
- the workflow still rejects with the original processing error;
- the existing canonical `mark-failed` success is not converted into CRITICAL failure solely because D1 stayed down.

This test pins helper exhaustion once; do not duplicate the same permanent-loop fixture for both statuses unless implementation behavior differs.

- [ ] **Step 3: Preserve the recognized-409 already-ready success test, then add a transient sibling**

Leave the existing `reconciles D1 to ready and skips CRITICAL when the DO refuses ready → failed (409)` test as the one-shot success baseline.

Add a sibling that arranges the same recognized DO 409, then makes D1 `ready` reject once and succeed on the second attempt.

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

Place it near `getDb()`/the local retry constants; do not export it. Follow the existing best-effort KV retry loop's semantics: three attempts, silent transient failures, 100/200 ms waits, one final log, and no throw.

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
					setTimeout(resolve, D1_MIRROR_IN_STEP_BASE_DELAY_MS * Math.pow(2, attempt))
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
- 100/200 ms timing belongs only to this helper;
- no callback/strategy injection or generic retry abstraction.

Do not copy the canonical `mark-failed` loop's per-attempt logging behavior. That loop changes authoritative state; this helper is best-effort mirroring.

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

Do not change the DO retry loop, `doSucceeded`, or CRITICAL path. Because this helper never throws, D1 exhaustion cannot trigger the enclosing Workflow step's default retries and replay the canonical DO transition.

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

- [ ] **Step 1: Re-read overlapping existing tests and the mock contract**

Confirm the final suite directly protects:

- transient ready step retry;
- permanent ready step exhaustion remains non-fatal;
- ready retry config uses `limit: 3`, `delay: '10 seconds'`, `backoff: 'exponential'`;
- `createMockStep({ respectRetryConfig: true })` treats `limit` as total attempts and retries before exposing final exhaustion to the caller;
- the retry-aware mock deliberately does **not** simulate Workflow delay;
- normal failed mirror success remains as its original one-shot test;
- transient/permanent failed helper behavior lives in sibling tests;
- recognized already-ready 409 one-shot success remains as its original test;
- transient already-ready helper behavior lives in a sibling test;
- existing authoritative `mark-failed` retry exhaustion/CRITICAL behavior remains unchanged;
- original processing error preservation remains pinned.

The unit mock is intentionally not a Miniflare Workflow emulator. Its contract is grounded in Cloudflare's documented `WorkflowStepConfig`; the dry-run build below verifies the installed type/toolchain accepts the config shape.

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

This verifies the installed Worker types/toolchain accept the `WorkflowStepConfig` overload and values. It does not prove runtime retry timing; the plan intentionally relies on Cloudflare's documented Workflows contract rather than adding a heavy local Workflow harness for this low-priority ticket.

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

- [ ] Success-path ready mirror passes a three-total-attempt retry config to its existing Workflow step.
- [ ] Success-path Workflow retry uses a 10-second base delay with exponential backoff, not the helper's 100 ms delay.
- [ ] Success-path D1 callback no longer catches transient errors internally.
- [ ] Outer ready-step catch keeps exhausted D1 retries non-fatal.
- [ ] Already-ready and failed mirrors share one local three-attempt helper.
- [ ] Local helper uses only 100/200 ms waits and never throws after exhaustion.
- [ ] Existing one-shot failed and already-ready success tests remain intact; retry cases are siblings.
- [ ] Retry-aware test mock pins total-attempt semantics and final-error propagation without simulating delay.
- [ ] Exhausted mirrors log once with puzzle ID and target status.
- [ ] Authoritative DO retry/state logic is unchanged.
- [ ] No persistent reconciliation machinery or new production module is added.
- [ ] Focused tests, full workflows unit suite, typecheck, lint, and dry-run build pass.