# HPA-120 Bounded D1 Mirror Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all three best-effort puzzle-status D1 mirrors a small durable Cloudflare Workflow retry budget without allowing mirror failures to replay or overwrite authoritative `PuzzleMetadataDO` state.

**Architecture:** Keep `finalize` and the existing authoritative `mark-failed` retry loop as the canonical state transitions. Add one module-local best-effort D1 mirror wrapper around `step.do(..., retryConfig, callback)`. Make `mark-failed` return a serializable terminal outcome, then run `failed` or already-ready reconciliation in dedicated retryable mirror steps before rethrowing the original workflow error.

**Tech Stack:** Cloudflare Workflows, TypeScript, Drizzle/D1, Vitest, Bun.

## Global constraints

- Follow `docs/superpowers/specs/2026-08-16-hpa-120-bounded-d1-mirror-retries-design.md`.
- D1 remains a best-effort mirror; `PuzzleMetadataDO` remains authoritative.
- Use Cloudflare `step.do` retry config; do not add a custom D1 sleep/retry loop.
- Use three total attempts for each D1 mirror: `limit: 3`, `delay: '1 second'`, `backoff: 'exponential'`.
- Do not modify the existing manual retry behavior for the authoritative `mark-failed` DO write.
- A D1 failure must never trigger a `ready -> failed` canonical transition.
- A failure-path D1 retry must never re-run the canonical `mark-failed` transition.
- Preserve the original processing error as the error rethrown by the workflow failure path.
- Keep explicit terminal D1 logging outside the retrying step callback so only exhausted retries produce the application error log.
- No schema, migration, outbox, queue, reaper, new production module, or new dependency.
- Expected production diff: `apps/workflows/src/index.ts` only.
- Expected test diff: `apps/workflows/src/index.test.ts` only.

---

## Task 1: Add a retry-aware WorkflowStep test seam and pin ready-mirror behavior

**Files:**

- Modify: `apps/workflows/src/index.test.ts`

**Purpose:** Make tests model the platform behavior HPA-120 relies on without making every existing workflow test suddenly retry its callback.

- [ ] **Step 1: Add an opt-in retry-aware mock step**

Keep the existing `createMockStep()` behavior unchanged for unrelated tests. Add either an option to it or a nearby dedicated helper that understands the configured overload:

```ts
step.do(name, config, callback)
```

The retry-aware path should:

```text
attempts = config.retries?.limit ?? 1
for attempt in 1...attempts:
    run callback
    return on success
    remember error on failure
throw final error after attempts exhausted
```

Do not sleep in the mock. Cloudflare owns delay/backoff behavior; the unit test only needs to prove that a throwing callback remains visible to the step and that the configured bound is honored.

Cloudflare's current documentation defines `retries.limit` as the total number of attempts, so `limit: 3` should execute the callback at most three times.

Reference: <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>

- [ ] **Step 2: Replace/extend the existing ready best-effort test with a transient failure case**

Use the existing successful workflow fixture/setup. Configure the mocked `setPuzzleStatus` to reject once and then resolve for `ready`.

Assert:

```ts
expect(setPuzzleStatus).toHaveBeenCalledTimes(2);
expect(setPuzzleStatus).toHaveBeenNthCalledWith(1, expect.anything(), puzzleId, 'ready');
expect(setPuzzleStatus).toHaveBeenNthCalledWith(2, expect.anything(), puzzleId, 'ready');
```

Also assert:

- `run()` resolves;
- the authoritative metadata update reaches `ready`;
- no authoritative `failed` update occurs;
- `step.do` receives `mirror-ready-status-to-d1` with the expected retry config.

- [ ] **Step 3: Add a ready-mirror exhaustion test**

Make `setPuzzleStatus` reject on every D1 attempt.

Assert:

- exactly three D1 attempts occur;
- `run()` still resolves;
- canonical metadata stays `ready`;
- no canonical `failed` transition occurs;
- one explicit terminal application error is logged after exhaustion, not once per D1 attempt.

Use a message expectation that identifies the ready mirror and exhaustion, without overfitting the thrown D1 error prose.

- [ ] **Step 4: Run the focused tests and confirm red**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

Expected before production changes: the new retry/config expectations fail because the current callback catches D1 errors internally and returns success to Workflow.

---

## Task 2: Add the local D1 mirror runner and fix the success path

**Files:**

- Modify: `apps/workflows/src/index.ts`
- Verify: `apps/workflows/src/index.test.ts`

- [ ] **Step 1: Add the shared local retry config**

Near the existing workflow-local constants, add:

```ts
const D1_MIRROR_STEP_CONFIG = {
	retries: {
		limit: 3,
		delay: '1 second',
		backoff: 'exponential'
	}
} as const;
```

Do not add dynamic delays, a timeout override, or D1 error classification.

- [ ] **Step 2: Add one module-local best-effort runner**

Use the existing `WorkflowStep` type already imported by `index.ts`:

```ts
async function runBestEffortD1Mirror(
	step: WorkflowStep,
	stepName: string,
	mirror: () => Promise<void>,
	terminalMessage: string
): Promise<void> {
	try {
		await step.do(stepName, D1_MIRROR_STEP_CONFIG, mirror);
	} catch (error) {
		console.error(terminalMessage, error);
	}
}
```

Keep it in `index.ts`. Extracting it to `helpers.ts` or `@perseus/shared` would create a broader API for three call sites that all live in this one orchestration class.

- [ ] **Step 3: Refactor `mirror-ready-status-to-d1`**

Replace:

```ts
await step.do('mirror-ready-status-to-d1', async () => {
	try {
		await setPuzzleStatus(..., 'ready');
	} catch (...) {
		...
	}
});
```

with the local best-effort runner:

```ts
await runBestEffortD1Mirror(
	step,
	'mirror-ready-status-to-d1',
	() => setPuzzleStatus(getDb(this.env), puzzleId, 'ready'),
	'Failed to mirror ready status to D1 after retries:'
);
```

The callback must not catch D1 errors. The outer helper catch is what converts retry exhaustion back into best-effort behavior.

Keep this mirror after the main generation `try/catch`. Do not move it beside `finalize`.

- [ ] **Step 4: Run the focused tests and confirm green for Task 1**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

The ready transient and exhaustion cases should now pass while existing workflow tests remain unchanged.

---

## Task 3: Split failure-path canonical outcome from D1 mirror retries

**Files:**

- Modify: `apps/workflows/src/index.test.ts`
- Modify: `apps/workflows/src/index.ts`

### Part A — write failure-path retry tests first

- [ ] **Step 1: Add a transient `failed` mirror test**

Start from the existing test that proves a genuine processing failure mirrors `failed` after the DO write succeeds.

Use the retry-aware mock step and make the D1 `failed` write reject once, then resolve.

Assert:

- the canonical DO reaches `failed` before the D1 path;
- `setPuzzleStatus(..., 'failed')` is attempted twice;
- the D1 retry happens under a dedicated `mirror-failed-status-to-d1` step;
- the canonical `mark-failed` transition is not repeated because of the D1 retry;
- `run()` still rejects with the original processing error.

Avoid asserting every `updateMetadata` call in the full workflow. Narrow the canonical assertion to the `status: 'failed'` writes so unrelated generation progress updates do not make the test brittle.

- [ ] **Step 2: Add a transient already-ready reconciliation test**

Extend the existing recognized-409 scenario:

- `finalize`/error ordering leads the DO to report the existing `already ready` 409 when the catch path tries `failed`;
- D1 `ready` rejects once, then succeeds.

Assert:

- `setPuzzleStatus(..., 'ready')` is attempted twice;
- no D1 `failed` write occurs;
- the D1 retries run under `reconcile-already-ready-status-to-d1`;
- the canonical mark-failed loop stops after the recognized 409 rather than being replayed by D1 failure;
- no `CRITICAL: Failed to mark puzzle ...` log occurs;
- `run()` preserves the existing behavior of rejecting with the original workflow error.

- [ ] **Step 3: Run focused tests and confirm red**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

Expected before the production refactor: failure-path D1 writes still happen inside `mark-failed`, so the new dedicated-step/retry assertions fail.

### Part B — refactor `mark-failed` without changing its DO algorithm

- [ ] **Step 4: Return a serializable `MarkFailedOutcome`**

Add a local closed type:

```ts
type MarkFailedOutcome = 'failed' | 'already-ready' | 'unreconciled';
```

Change the existing `mark-failed` step callback so it returns:

- `'already-ready'` from the existing recognized 409 branch;
- `'failed'` when the current `doSucceeded` branch is reached;
- `'unreconciled'` after the existing DO retries are exhausted and the current CRITICAL diagnostics are logged.

Do not change:

- `maxRetries`;
- the authoritative retry loop;
- its exponential `setTimeout` backoff;
- recognized-409 matching;
- per-attempt canonical error logging;
- CRITICAL diagnostics.

Only remove the two inline `setPuzzleStatus()` calls from this step.

Conceptually:

```ts
const markFailedOutcome: MarkFailedOutcome = await step.do('mark-failed', async () => {
	// existing DO retry loop
	if (alreadyReady) return 'already-ready';
	if (doSucceeded) return 'failed';
	// existing CRITICAL logs
	return 'unreconciled';
});
```

- [ ] **Step 5: Mirror the returned outcome in a separate step**

Immediately after `mark-failed` and before `throw originalError`:

```ts
if (markFailedOutcome === 'failed') {
	await runBestEffortD1Mirror(
		step,
		'mirror-failed-status-to-d1',
		() => setPuzzleStatus(getDb(this.env), puzzleId, 'failed'),
		'Failed to mirror failed status to D1 after retries:'
	);
}

if (markFailedOutcome === 'already-ready') {
	await runBestEffortD1Mirror(
		step,
		'reconcile-already-ready-status-to-d1',
		() => setPuzzleStatus(getDb(this.env), puzzleId, 'ready'),
		'Failed to reconcile already-ready status in D1 after retries:'
	);
}

throw originalError;
```

For `'unreconciled'`, do not touch D1 because no authoritative terminal status was established by the failure path.

Do not use `finally` to perform a status write: the target D1 status depends on the canonical outcome, and an unconditional finally block would blur that distinction.

- [ ] **Step 6: Run focused tests and confirm green**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts
```

The new transient tests and all existing authoritative mark-failed retry/409 tests should pass.

---

## Task 4: Tighten regression assertions and run the workflows package gate

**Files:**

- Modify if needed: `apps/workflows/src/index.test.ts`
- No new production files.

- [ ] **Step 1: Re-read the existing HPA-120-adjacent tests**

Confirm the suite still explicitly protects all of these independent semantics:

- success-path D1 exhaustion cannot cause canonical `failed`;
- failed mirror happens only after authoritative `failed` succeeds;
- already-ready reconciliation never writes D1 `failed`;
- authoritative `mark-failed` retry exhaustion still produces existing CRITICAL diagnostics;
- original processing errors remain the workflow rejection on failure paths.

Prefer editing existing overlapping assertions rather than adding duplicate describe blocks.

- [ ] **Step 2: Run the full workflows unit suite**

```bash
cd apps/workflows
bun run test:unit
```

Expected: all workflows tests and configured coverage gates pass.

- [ ] **Step 3: Run static checks**

```bash
cd apps/workflows
bun run check
bun run lint
```

Expected: TypeScript, Prettier, and ESLint pass.

- [ ] **Step 4: Run the Worker dry-run build**

```bash
cd apps/workflows
bun run build
```

Expected: Wrangler dry-run build succeeds with the retry config accepted by the installed Worker types/runtime tooling.

- [ ] **Step 5: Inspect the final diff**

```bash
git diff --check
git diff -- apps/workflows/src/index.ts apps/workflows/src/index.test.ts
```

Expected implementation scope:

```text
apps/workflows/src/index.ts
apps/workflows/src/index.test.ts
```

If implementation needs a schema, migration, shared package change, queue, outbox, or retry library, stop: that is outside HPA-120 and should be justified as a separate follow-up instead of being slipped into this change.

## Completion checklist

- [ ] Ready mirror uses a throwing callback inside a retry-configured Workflow step.
- [ ] Failed mirror runs in its own retry-configured step after authoritative failed state succeeds.
- [ ] Already-ready reconciliation runs in its own retry-configured step after the recognized canonical outcome.
- [ ] All three mirrors use the same three-attempt policy.
- [ ] Exhausted mirror failures are swallowed only outside their `step.do` and log once at application level.
- [ ] No D1 retry replays `finalize` or `mark-failed` canonical writes.
- [ ] Original workflow failure errors are preserved.
- [ ] No new production module/schema/dependency is added.
- [ ] Focused tests, full workflows unit tests, typecheck, lint, and dry-run build pass.
