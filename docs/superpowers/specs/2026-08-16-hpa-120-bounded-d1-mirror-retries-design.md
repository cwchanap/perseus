# HPA-120: Retry the D1 Puzzle-Status Mirror a Few Times — Design

**Linear:** HPA-120 — **Status:** Design for implementation
**Date:** 2026-08-16

## Context

HPA-120 is a small reliability fix: reduce the chance that a short D1 outage leaves a player's D1-backed puzzle status stale after authoritative puzzle metadata has already reached `ready` or `failed`.

Current `apps/workflows/src/index.ts` has three best-effort D1 mirror sites:

1. successful generation finalizes the authoritative DO to `ready`, then runs `step.do('mirror-ready-status-to-d1', ...)`;
2. a genuine processing failure establishes authoritative `failed` state inside `step.do('mark-failed', ...)`, then mirrors `failed` to D1;
3. the error path can discover that `finalize` already committed `ready`; it preserves that canonical state and reconciles D1 back to `ready`.

`setPuzzleStatus()` is already the correct write primitive. It performs an idempotent update of one puzzle row to the supplied terminal status, so retrying it needs no new token, schema, transaction protocol, or repository abstraction.

Cloudflare Workflows already provides the retry mechanism this ticket needs. `step.do` accepts per-step retry configuration, successful step outputs are persisted, and a step may return serializable primitive state. Current Workflows documentation defines `retries.limit` as the total number of attempts and uses a default retry policy of five attempts with a 10-second base delay and exponential backoff.

The load-bearing bug on the current success-path mirror is not the absence of an explicit retry config. The step already inherits Workflow retry behavior. Its inner `try/catch` swallows the D1 exception, making the step appear successful and preventing any retry. HPA-120 must remove that inner catch. The explicit three-attempt config then pins the intended policy instead of inheriting the platform default.

The two failure-path mirrors should not use a separate 100/200 ms in-process retry loop. `mark-failed` can return a small serializable terminal outcome after the canonical DO work is complete, then the caller can run the same durable D1 mirror helper used by the success path. This gives all three mirrors seconds-scale durable retries without replaying the canonical DO transition.

References:

- <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>
- <https://developers.cloudflare.com/workflows/get-started/guide/>
- <https://developers.cloudflare.com/workflows/build/workers-api/>

## Goals

1. Give all three D1 terminal-status mirrors the same explicit three-total-attempt Workflow retry policy.
2. Keep DO/KV authoritative; D1 remains a best-effort mirror.
3. Preserve the existing `finalize` and authoritative `mark-failed` DO semantics.
4. Prevent a D1 failure from causing or replaying a canonical `ready -> failed` transition.
5. Preserve the original processing error after failure-path reconciliation attempts finish.
6. Log one clear terminal application error when a D1 mirror exhausts its retry budget.
7. Distinguish success-ready, failed, and already-ready-reconciliation failures in Workflow history and application logs.
8. Keep the implementation local to `apps/workflows/src/index.ts` and `apps/workflows/src/index.test.ts`.

## Non-goals

- Exactly-once synchronization between DO/KV and D1.
- Guaranteed eventual convergence during a prolonged D1 outage.
- An outbox, queue, scheduled repair scan, DO alarm, reconciliation table, or new reaper path.
- Read-time cross-checking between D1 and authoritative metadata.
- D1 schema or migration changes.
- Changing `setPuzzleStatus()` or profile-read semantics.
- Replacing or redesigning the existing manual DO retry loop inside `mark-failed`.
- A generic retry package or callback/strategy framework.
- Error classification, jitter, circuit breakers, metrics infrastructure, or alerts.
- A Miniflare Workflow emulator solely to test Cloudflare's retry implementation.
- Backward-compatibility handling for pre-release Workflow instances.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Durable D1 retry | existing `mirror-ready-status-to-d1` `step.do` | Extend into one local mirror wrapper and reuse at all three sites |
| Canonical ready state | existing `finalize` step | Keep unchanged |
| Canonical failed state | existing `mark-failed` manual DO retry loop | Keep the loop, 409 handling, warning, and CRITICAL diagnostics unchanged |
| Failure-path handoff | `step.do` serializable return value | Return `failed | already-ready | unreconciled` from `mark-failed` |
| D1 write | `@perseus/shared` `setPuzzleStatus()` | Reuse unchanged |
| D1 connection | existing `getDb()` isolate cache | Reuse unchanged |
| Workflow mock | existing `createMockStep()` | Keep unchanged; it already executes `(name, config, callback)` and propagates callback errors |
| Existing tests | ready-mirror, failed-mirror, already-ready reconciliation tests | Extend assertions around step config, branch selection, logging, and original-error preservation |

No new production file is justified.

## Options considered

### Option A — One durable mirror wrapper + `mark-failed` outcome handoff (selected)

Use one private wrapper around `step.do(..., D1_MIRROR_STEP_CONFIG, ...)`. Keep the success-path ready mirror after the main generation `try/catch`. Change `mark-failed` only enough to return which canonical state it established, then invoke the same wrapper outside that step before rethrowing the original processing error.

**Pros**

- one retry mechanism for all three D1 mirrors;
- seconds-scale durable retry coverage at all three sites;
- removes the planned third hand-written retry loop;
- no fake-timer retry tests;
- no retry-simulating Workflow mock;
- canonical DO work is still isolated from D1 failure;
- revisiting failure-path reliability later does not require restructuring `mark-failed` again.

**Cons**

- `mark-failed` now returns a three-value outcome instead of `void`;
- failure-path workflow completion can wait through the D1 retry budget before rethrowing the original processing error.

That wait is acceptable for this ticket: Workflow retry waits are durable, and the authoritative state is already established before the mirror step starts.

### Option B — Manual 100/200 ms helper for the two failure-path mirrors

Keep those writes inside `mark-failed` and retry them with a local `setTimeout` loop.

**Rejected:** it duplicates existing retry-loop code and gives two of three mirrors only about 300 ms of protection. That is materially weaker than the ticket's goal of surviving a short D1 outage, while also requiring more custom test code.

### Option C — Persistent reconciliation infrastructure

**Rejected:** an outbox, queue, alarm, scheduled scan, or read-time repair path is disproportionate to a low-priority pre-release mirror.

## Retry policy

Use one explicit policy for every D1 mirror:

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

`limit: 3` means three total attempts. The explicit config intentionally lowers the current inherited default from five attempts to three and documents HPA-120's bounded policy.

The behavior-enabling change is that the D1 callback must be allowed to throw into `step.do`. Do not add an inner `try/catch` around `setPuzzleStatus()` in any mirror step.

## One private mirror wrapper

Keep orchestration local to `index.ts`:

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

The wrapper catches only *outside* `step.do`, after the Workflow retry budget is exhausted. It never rethrows the D1 failure.

Use distinct step names so the two `ready` paths remain diagnosable:

- `mirror-ready-status-to-d1` — normal successful generation;
- `mirror-failed-status-to-d1` — canonical processing failure;
- `reconcile-already-ready-status-to-d1` — finalize committed `ready` before the failure path tried to mark failed.

The step name is included in the final log, so a stale `ready` row from normal completion is distinguishable from an already-ready reconciliation failure.

## Success path

Keep the ready mirror after the main generation `try/catch`:

```ts
await mirrorPuzzleStatusToD1(
	step,
	this.env,
	puzzleId,
	'ready',
	'mirror-ready-status-to-d1'
);
```

This placement is load-bearing. A D1 throw must never enter the generation catch and invoke `mark-failed` after the authoritative DO has already become `ready`.

The existing inner catch inside `mirror-ready-status-to-d1` is deleted. That deletion is what enables Workflow retries; the explicit config merely pins the retry budget.

## Failure path

Introduce one small local result type:

```ts
type MarkFailedOutcome = 'failed' | 'already-ready' | 'unreconciled';
```

Keep the authoritative DO retry loop unchanged. Only replace the existing D1 blocks with serializable returns:

```ts
const markFailedOutcome = await step.do(
	'mark-failed',
	async (): Promise<MarkFailedOutcome> => {
		// existing maxRetries / doSucceeded / alreadyReady logic unchanged

		if (alreadyReady) {
			return 'already-ready';
		}

		if (doSucceeded) {
			return 'failed';
		}

		// existing CRITICAL logs unchanged
		return 'unreconciled';
	}
);
```

Then mirror only a canonical state that was actually established:

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

If all canonical DO retries fail, return `unreconciled`, keep the existing CRITICAL diagnostics, skip D1 mirroring, and rethrow the same original processing error.

The D1 step is outside `mark-failed`, so its retries cannot replay the authoritative DO transition. After the mirror succeeds or exhausts, the workflow rethrows `originalError` exactly as before.

## Logging

On exhausted D1 retries, log once with:

- the mirror step/site name;
- puzzle ID;
- target status;
- configured attempt count;
- final error object.

Do not add application-level per-attempt logs. Workflow history already owns the retry-attempt detail.

Update the existing ready-mirror test that currently asserts the literal `Failed to mirror ready status to D1:` string. The new site-aware final log intentionally replaces it.

Keep the existing already-ready warning and canonical mark-failed retry/CRITICAL logs unchanged.

## Test strategy

Keep `createMockStep()` unchanged. It already accepts both `step.do(name, callback)` and `step.do(name, config, callback)`, executes the callback once, and propagates callback errors. Unit tests should verify *our* behavior, not reimplement Cloudflare's retry loop.

Cloudflare's documented retry semantics are treated as the platform contract; Wrangler/type checks verify the configured shape is accepted by the installed toolchain.

### Ready mirror

Update the existing ready-mirror failure test to:

- use one rejecting `setPuzzleStatus()` attempt;
- assert the mirror step receives `D1_MIRROR_STEP_CONFIG`;
- assert the callback rejection reaches the outer wrapper catch by expecting the new final site-aware log;
- assert the workflow still resolves;
- assert no `failed` write occurs and the authoritative DO stays `ready`.

A separate attempt-count test is not useful because the unit mock does not implement platform retries.

### Canonical failed branch

Keep the existing successful failed-mirror behavior assertion, but retain the `step` instance and assert:

- `mark-failed` is followed by `mirror-failed-status-to-d1`;
- the mirror step receives the shared retry config;
- `setPuzzleStatus(..., 'failed')` still executes;
- the workflow still rejects with the original processing error.

Add one D1-rejection case for this branch. With the one-shot mock, the mirror wrapper logs once and swallows that mirror error; the workflow must still reject with the original processing error, not the D1 error.

### Already-ready branch

Keep the existing recognized-409 behavior and assert:

- `reconcile-already-ready-status-to-d1` is invoked with the shared retry config;
- D1 target status is `ready`;
- no D1 `failed` write occurs;
- the existing already-ready warning remains;
- no canonical CRITICAL log appears;
- the workflow still rejects with the original processing error.

No fake timers and no retry-aware mock are needed.

## Files expected in the implementation PR

- Modify: `apps/workflows/src/index.ts`
- Modify: `apps/workflows/src/index.test.ts`

No other production file should be necessary.

## Acceptance mapping

| HPA-120 criterion | Design coverage |
| --- | --- |
| transient D1 failure within retry budget updates profile status | every mirror is a retry-configured durable Workflow step |
| all three mirror sites covered | normal ready, canonical failed, already-ready reconciliation use one wrapper with distinct step names |
| exhausted retries log and do not change authoritative result | wrapper catches after `step.do`; canonical state is established before mirror |
| no persistent reconciliation system | explicitly excluded; two-file implementation |

## Review resolutions

1. **Failure-path durability — accepted.** Delete the planned 100/200 ms helper and hoist D1 work out of `mark-failed`; return a serializable outcome instead.
2. **Retry-aware test mock — accepted.** Do not teach `createMockStep()` to simulate Cloudflare retries. Assert config/error boundaries only.
3. **Helper placement — moot.** The manual retry helper is deleted, so no new export or `helpers.ts` test seam is needed.
4. **Logging — accepted.** Update the existing ready literal assertion and keep distinct mirror step names so already-ready reconciliation remains identifiable.
5. **Load-bearing change — accepted.** The design now states explicitly that deleting the inner D1 catch enables retries; the explicit config pins the budget and lowers the inherited default from five attempts to three.

## Deferred follow-up

None required. If production evidence later shows material drift even after durable retries, stronger reconciliation can be evaluated as a separate reliability ticket rather than pre-built into HPA-120.
