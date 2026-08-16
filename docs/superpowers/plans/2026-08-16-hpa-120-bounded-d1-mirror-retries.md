# HPA-120 Bounded D1 Mirror Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all three best-effort D1 puzzle-status mirrors the same bounded durable Workflow retry policy without replaying authoritative DO transitions or changing workflow result semantics.

**Architecture:** Keep `finalize` and the existing manual DO retry loop inside `mark-failed` as the canonical state transitions. Add one private `mirrorPuzzleStatusToD1()` wrapper around retry-configured `step.do`. Make `mark-failed` return `failed | already-ready | unreconciled`, mirror the established canonical state in a later durable step, then rethrow the original processing error unchanged.

**Tech Stack:** Cloudflare Workflows, TypeScript, Drizzle/D1, Vitest, Bun.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-16-hpa-120-bounded-d1-mirror-retries-design.md`.
- DO/KV remains authoritative; D1 remains best-effort.
- All three D1 mirror sites use the same Workflow retry config.
- `retries.limit` is three **total attempts**.
- Retry delay is `10 seconds` with `exponential` backoff.
- The success-path ready mirror remains after the main generation `try/catch`.
- The D1 callback must not catch `setPuzzleStatus()` errors inside `step.do`.
- `mark-failed` keeps its existing manual DO retry loop, 409 recognition, warning, and CRITICAL diagnostics.
- Failure-path D1 retries must not replay `mark-failed`.
- Failure-path completion must still rethrow the original processing error after D1 mirroring succeeds or exhausts.
- Distinguish normal ready, failed, and already-ready reconciliation in step/log names.
- Keep `createMockStep()` one-shot; do not reimplement Cloudflare retry behavior in tests.
- No fake-timer D1 retry tests.
- No schema, migration, outbox, queue, alarm, reaper, profile-read change, new dependency, or generic retry package.
- Expected implementation files only: `apps/workflows/src/index.ts` and `apps/workflows/src/index.test.ts`.

---

### Task 1: Pin the durable mirror boundary on the existing success path

**Files:**
- Modify: `apps/workflows/src/index.test.ts`
- Modify: `apps/workflows/src/index.ts`

**Interfaces:**
- Consumes: existing `WorkflowStep`, `Env`, `getDb()`, and `setPuzzleStatus()`.
- Produces: `D1_MIRROR_MAX_ATTEMPTS`, `D1_MIRROR_STEP_CONFIG`, and `mirrorPuzzleStatusToD1(step, env, puzzleId, status, stepName): Promise<void>`.

- [ ] **Step 1: Update the existing ready-mirror failure test to assert the new contract**

Keep the existing `Workflow Execution - D1 ready mirror is best-effort` fixture. Use one rejecting `setPuzzleStatus()` attempt; the existing `createMockStep()` should continue executing configured callbacks once and propagating callback rejection.

Capture the step so the test can inspect the call:

```ts
const step = createMockStep();
vi.mocked(setPuzzleStatus).mockReset();
vi.mocked(setPuzzleStatus).mockRejectedValueOnce(new Error('D1 down'));
const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

await expect(workflow.run(event, step)).resolves.toBeUndefined();
```

Replace the current literal log assertion:

```ts
expect(consoleSpy).toHaveBeenCalledWith(
	'Failed to mirror ready status to D1:',
	expect.any(Error)
);
```

with the site-aware contract:

```ts
expect(consoleSpy).toHaveBeenCalledWith(
	expect.stringContaining('D1 mirror mirror-ready-status-to-d1 failed'),
	expect.any(Error)
);
```

Also assert the config shape:

```ts
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

Retain the existing assertions that no D1 `failed` write occurs and that the last authoritative DO update is still `ready`.

Why this test is sufficient: the current one-shot mock already propagates callback rejection. If an implementation keeps the inner D1 catch, the wrapper's outer site-aware log never fires and this test remains red. The test does not pretend to verify Cloudflare's attempt count.

- [ ] **Step 2: Run the focused test and confirm red**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts -t "D1 ready mirror is best-effort"
```

Expected before production change: FAIL because the current ready mirror has no explicit config and logs from inside the callback with the old literal message.

- [ ] **Step 3: Add the shared retry config and private mirror wrapper**

Place near `getDb()` and other workflow-local constants in `apps/workflows/src/index.ts`:

```ts
const D1_MIRROR_MAX_ATTEMPTS = 3;

const D1_MIRROR_STEP_CONFIG = {
	retries: {
		limit: D1_MIRROR_MAX_ATTEMPTS,
		delay: '10 seconds',
		backoff: 'exponential'
	}
} as const;
```

Add the private wrapper:

```ts
async function mirrorPuzzleStatusToD1(
	step: WorkflowStep,
	env: Env,
	puzzleId: string,
	status: 'ready' | 'failed',
	stepName: string
): Promise<void> {
	try {
		await step.do(stepName, D1_MIRROR_STEP_CONFIG, async () => {
			await setPuzzleStatus(getDb(env), puzzleId, status);
		});
	} catch (error) {
		console.error(
			`D1 mirror ${stepName} failed for puzzle ${puzzleId} status ${status} after ${D1_MIRROR_MAX_ATTEMPTS} attempts:`,
			error
		);
	}
}
```

The wrapper intentionally catches only around `step.do`. Do not catch `setPuzzleStatus()` inside the callback.

- [ ] **Step 4: Replace the success-path ready mirror with the wrapper**

Keep the call after the main generation `try/catch`:

```ts
await mirrorPuzzleStatusToD1(
	step,
	this.env,
	puzzleId,
	'ready',
	'mirror-ready-status-to-d1'
);
```

Delete the old inner `try/catch` completely.

This deletion is the behavior-enabling change: without it the Workflow step is considered successful and cannot retry. The explicit config separately pins the intended three-attempt policy instead of inheriting the current default of five attempts.

- [ ] **Step 5: Run the focused test and confirm green**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts -t "D1 ready mirror is best-effort"
```

Expected: PASS.

- [ ] **Step 6: Commit the durable mirror seam**

```bash
git add apps/workflows/src/index.ts apps/workflows/src/index.test.ts
git commit -m "fix(workflows): retry ready D1 mirror durably"
```

---

### Task 2: Hoist failure-path mirrors out of `mark-failed`

**Files:**
- Modify: `apps/workflows/src/index.test.ts`
- Modify: `apps/workflows/src/index.ts`

**Interfaces:**
- Consumes: `mirrorPuzzleStatusToD1()` from Task 1.
- Produces: local `MarkFailedOutcome = 'failed' | 'already-ready' | 'unreconciled'` returned by `step.do('mark-failed', ...)`.

- [ ] **Step 1: Strengthen the existing canonical failed-mirror success test**

Do not replace its existing behavior assertions. Capture `step` instead of constructing it inline:

```ts
const step = createMockStep();

await expect(workflow.run(event, step)).rejects.toThrow(
	`Original image not found for puzzle ${puzzleId}`
);

expect(setPuzzleStatus).toHaveBeenCalledWith(expect.anything(), puzzleId, 'failed');
expect(step.do).toHaveBeenCalledWith(
	'mirror-failed-status-to-d1',
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

This should fail before the production change because the `failed` D1 write still runs inside `mark-failed` and no separate mirror step exists.

- [ ] **Step 2: Strengthen the existing already-ready reconciliation test**

Retain the current recognized-409 setup, `already ready` warning assertion, no-CRITICAL assertion, and no-D1-`failed` assertion. Capture `step` and add:

```ts
expect(step.do).toHaveBeenCalledWith(
	'reconcile-already-ready-status-to-d1',
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

Expected before production change: FAIL because reconciliation still happens inside `mark-failed`.

- [ ] **Step 3: Add one failure-path D1 rejection test**

Use the normal canonical failed branch. Let the authoritative DO update succeed but make the one-shot test double's D1 write reject:

```ts
const step = createMockStep();
vi.mocked(setPuzzleStatus).mockReset();
vi.mocked(setPuzzleStatus).mockRejectedValueOnce(new Error('D1 down'));
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

await expect(workflow.run(event, step)).rejects.toThrow(
	`Original image not found for puzzle ${puzzleId}`
);
```

Assert the mirror failure is swallowed and the original processing error remains authoritative:

```ts
expect(errorSpy).toHaveBeenCalledWith(
	expect.stringContaining('D1 mirror mirror-failed-status-to-d1 failed'),
	expect.any(Error)
);
expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
```

Do not assert three D1 calls. The test double intentionally models one callback execution; the retry count is a Cloudflare platform contract pinned by the config assertion.

- [ ] **Step 4: Run the three focused cases and confirm red**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts -t "mirrors the failed status|already-ready reconciliation|D1 down"
```

Expected before production change: the new mirror-step assertions fail.

- [ ] **Step 5: Add the serializable mark-failed outcome type**

Near the local workflow types in `apps/workflows/src/index.ts`:

```ts
type MarkFailedOutcome = 'failed' | 'already-ready' | 'unreconciled';
```

- [ ] **Step 6: Make `mark-failed` return the canonical outcome**

Change only the D1 branches and the final CRITICAL fallthrough. Preserve the current `maxRetries`, `lastError`, `doSucceeded`, `alreadyReady`, 409 matching, warning, retry delays, per-attempt canonical logs, and CRITICAL diagnostics.

```ts
const markFailedOutcome = await step.do(
	'mark-failed',
	async (): Promise<MarkFailedOutcome> => {
		const maxRetries = 3;
		let lastError: unknown;
		let doSucceeded = false;
		let alreadyReady = false;

		// existing authoritative retry loop unchanged

		if (alreadyReady) {
			return 'already-ready';
		}

		if (doSucceeded) {
			return 'failed';
		}

		console.error(
			`CRITICAL: Failed to mark puzzle ${puzzleId} as failed after ${maxRetries} retries`
		);
		console.error('Last error:', lastError);
		console.error('Original workflow error:', originalError);
		return 'unreconciled';
	}
);
```

Delete both `setPuzzleStatus()` calls from inside `mark-failed`.

- [ ] **Step 7: Mirror the persisted outcome in its own durable step**

Immediately after `mark-failed` returns, still inside the outer processing-error catch:

```ts
if (markFailedOutcome === 'already-ready') {
	await mirrorPuzzleStatusToD1(
		step,
		this.env,
		puzzleId,
		'ready',
		'reconcile-already-ready-status-to-d1'
	);
} else if (markFailedOutcome === 'failed') {
	await mirrorPuzzleStatusToD1(
		step,
		this.env,
		puzzleId,
		'failed',
		'mirror-failed-status-to-d1'
	);
}

throw originalError;
```

Do not mirror when the outcome is `unreconciled`; no canonical terminal status was established.

The D1 step is now outside `mark-failed`, so D1 retry/exhaustion cannot replay the canonical DO write.

- [ ] **Step 8: Run the focused cases and confirm green**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts -t "mirrors the failed status|already-ready reconciliation|D1 down"
```

Expected: PASS.

- [ ] **Step 9: Run the existing canonical retry-exhaustion test unchanged**

```bash
cd apps/workflows
bunx vitest run src/index.test.ts -t "mark-failed retry exhaustion"
```

Expected: PASS. This is the regression fence that the authoritative DO retry loop/CRITICAL path was not altered by the D1 restructuring.

- [ ] **Step 10: Commit the failure-path handoff**

```bash
git add apps/workflows/src/index.ts apps/workflows/src/index.test.ts
git commit -m "fix(workflows): retry terminal D1 mirrors durably"
```

---

### Task 3: Run package gates and inspect scope

**Files:**
- Modify if needed: `apps/workflows/src/index.test.ts`
- No new production files.

**Interfaces:**
- Consumes: final Task 1/2 implementation.
- Produces: verified two-file implementation ready for PR review.

- [ ] **Step 1: Re-read the final test contract**

Confirm the suite protects all of the following without simulating Cloudflare retries:

- success-ready mirror uses `mirror-ready-status-to-d1` with the explicit retry config;
- one rejecting ready callback reaches the wrapper's outer catch and leaves the workflow successful/DO ready;
- canonical failed branch invokes `mirror-failed-status-to-d1` after `mark-failed`;
- already-ready branch invokes `reconcile-already-ready-status-to-d1` after `mark-failed`;
- the two `ready` sites remain distinguishable in logs/step names;
- a failure-path D1 rejection is swallowed and the original processing error is rethrown;
- `unreconciled` does not mirror a terminal D1 status;
- existing mark-failed retry-exhaustion/CRITICAL behavior remains unchanged.

- [ ] **Step 2: Run the full workflows unit/coverage gate**

```bash
cd apps/workflows
bun run test:unit
```

Expected: all tests and configured coverage gates pass.

- [ ] **Step 3: Run TypeScript and lint checks**

```bash
cd apps/workflows
bun run check
bun run lint
```

Expected: clean.

- [ ] **Step 4: Run the Wrangler dry-run build**

```bash
cd apps/workflows
bun run build
```

Expected: the installed Worker types/toolchain accept the `step.do(name, config, callback)` overload, three-value serializable `mark-failed` return, and config values.

This does not prove Cloudflare's retry timing locally. The implementation intentionally relies on the current Workflows platform contract rather than adding a local Workflow emulator for this small ticket.

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

There should be no manual D1 retry loop, fake-timer D1 retry tests, retry-aware `createMockStep`, schema/migration changes, queue/outbox/alarm/reaper work, or new shared module.

## Completion Checklist

- [ ] `D1_MIRROR_STEP_CONFIG` pins three total attempts, 10-second delay, exponential backoff.
- [ ] The ready mirror's inner D1 catch is deleted; this is explicitly recognized as the change that enables platform retries.
- [ ] One private durable mirror wrapper is used by all three D1 sites.
- [ ] Normal ready retains the existing `mirror-ready-status-to-d1` step name.
- [ ] Canonical failed uses `mirror-failed-status-to-d1`.
- [ ] Already-ready reconciliation uses `reconcile-already-ready-status-to-d1`.
- [ ] `mark-failed` returns `failed | already-ready | unreconciled` and no longer performs D1 writes.
- [ ] Existing authoritative DO retry loop, 409 recognition, warning, and CRITICAL diagnostics remain unchanged.
- [ ] D1 retry/exhaustion cannot replay `mark-failed`.
- [ ] Failure path always rethrows the original processing error after D1 mirror completion/exhaustion.
- [ ] Unit tests assert config/error boundaries but do not simulate Cloudflare retry attempt counts.
- [ ] Existing ready literal log assertion is updated to the site-aware final message.
- [ ] No fake-timer D1 retry tests remain in the plan.
- [ ] No new production module or persistent reconciliation infrastructure is added.
- [ ] Full workflows unit suite, typecheck, lint, dry-run build, and diff checks pass.
