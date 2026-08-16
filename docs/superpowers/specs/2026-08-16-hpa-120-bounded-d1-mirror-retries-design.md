# HPA-120: Retry the D1 Puzzle-Status Mirror a Few Times — Design

**Linear:** HPA-120  
**Status:** Design for implementation  
**Date:** 2026-08-16

## Context

HPA-120 is the next standalone actionable Perseus issue after the HPA-215 gameplay children were completed. It is a low-priority pre-release reliability fix: reduce the chance that a short D1 outage leaves a player's D1-backed profile status stale after the authoritative puzzle status has already reached `ready` or `failed`.

There are three best-effort mirror sites in `apps/workflows/src/index.ts`:

1. the recognized `already ready` branch inside `step.do('mark-failed', ...)` reconciles D1 to `ready`;
2. the successful canonical `mark-failed` branch, in the same step, mirrors D1 to `failed`;
3. the success path runs `step.do('mirror-ready-status-to-d1', ...)` after the authoritative DO has finalized `ready`.

All three currently catch a single `setPuzzleStatus()` failure and stop. `setPuzzleStatus()` itself is already suitable for retry: it idempotently updates one puzzle row to the requested status, so retrying the same terminal value needs no new token, schema, or transaction protocol.

The key constraint is that the three sites do not have the same Workflow shape:

- the success-path `ready` mirror already owns its own `step.do`, so Cloudflare's built-in per-step retry is the smallest correct mechanism;
- the `failed` and already-ready mirrors execute *inside* the existing `mark-failed` step. A Workflow step cannot be nested there, and restructuring the entire failure path solely to give D1 a separate durable step would be more churn than this low-priority ticket needs. Those two sites use one tiny local bounded retry helper instead.

Cloudflare documents per-step retry config on `step.do`, including `limit`, `delay`, and `backoff`, and documents catching an exhausted step outside `step.do` when that step is allowed to fail without failing the Workflow:

- [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- [Build your first Workflow](https://developers.cloudflare.com/workflows/get-started/guide/)

This ticket improves short transient failure handling. It does not promise guaranteed convergence during a prolonged D1 outage or redesign cross-store consistency.

## Goals

1. Let the existing success-path `mirror-ready-status-to-d1` step retry a transient D1 failure using Cloudflare Workflow retry config.
2. Retry transient `failed` mirror writes inside `mark-failed` with one small shared helper.
3. Retry transient already-ready `ready` reconciliation writes through the same helper.
4. Bound every mirror to three total attempts with short delays.
5. Log one clear terminal application error with puzzle ID and target status after retries are exhausted.
6. Keep DO/KV authoritative and preserve current workflow success/failure semantics.
7. Keep the production change local to `apps/workflows/src/index.ts` and its existing tests.

## Non-goals

- Exactly-once synchronization between DO/KV and D1.
- Guaranteed eventual convergence after a prolonged D1 outage.
- An outbox, queue, scheduled repair scan, DO alarm, reconciliation table, or new reaper path.
- Read-time cross-checking between D1 and authoritative metadata.
- D1 schema or migration changes.
- Changing `setPuzzleStatus()` or profile-read semantics.
- Replacing the existing authoritative `mark-failed` DO retry loop.
- Splitting the two in-step mirrors into new Workflow steps.
- A general retry library for the monorepo.
- Dynamic retry-delay functions, error classification, jitter, circuit breakers, metrics infrastructure, or alerts.
- Backward-compatibility machinery for pre-release workflow instances.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Success-path durable retry | existing `mirror-ready-status-to-d1` `step.do` | Add retry config; let callback errors reach Workflow |
| In-step bounded retry | existing local retry-loop pattern in `mark-failed` | Reuse its simple 3-attempt / short-backoff shape for D1 via one helper |
| Authoritative ready state | existing `finalize` step | Keep unchanged |
| Authoritative failed state | existing `mark-failed` step and manual DO retry loop | Keep unchanged |
| D1 write | `@perseus/shared` `setPuzzleStatus()` | Reuse unchanged |
| D1 connection | existing `getDb()` isolate cache | Reuse unchanged |
| Fake timers | existing `mark-failed retry exhaustion` test | Reuse for manual D1 retry tests |
| Workflow mock | existing `createMockStep()` | Extend with opt-in retry-config simulation only where needed |
| Tests | `apps/workflows/src/index.test.ts` | Extend existing ready/failed/already-ready sections |

No new production module is justified.

## Options considered

### Option A — Built-in retry for the existing ready step + one local helper for the two in-step mirrors (selected)

Keep the current orchestration structure. The success-path step stops swallowing its callback error and gets an explicit Workflow retry config. The two D1 writes already inside `mark-failed` call one local helper that retries `setPuzzleStatus()` up to three times and swallows/logs only the final failure.

**Pros**

- matches the current Linear scope exactly;
- smallest production diff;
- does not restructure the failure path;
- uses the platform retry primitive where a dedicated step already exists;
- shares the manual retry implementation only where nesting a step is not available;
- preserves the current authoritative DO logic verbatim.

**Cons**

- two retry mechanisms exist in one file: Workflow-managed for one site, local loop for two sites.

That difference is intentional and follows the existing step boundaries rather than inventing a larger abstraction.

### Option B — Split `mark-failed` outcomes into new D1 Workflow steps

Have `mark-failed` return `failed | already-ready | unreconciled`, then run dedicated D1 steps outside it.

**Rejected for HPA-120:** this gives the two failure-path mirrors durable Workflow retries too, but it changes the control flow and adds new persisted step boundaries for a low-priority best-effort mirror. The current ticket explicitly prefers the smaller in-step helper. If production data later shows the helper is insufficient, stronger reconciliation can be evaluated separately.

### Option C — Hand-roll all three retries

Use the same local helper for the success-path ready mirror too.

**Rejected:** `mirror-ready-status-to-d1` already has a dedicated Workflow step. Catching inside that callback currently disables a retry facility the platform provides for free. Use Workflow retry config there instead of duplicating it.

### Option D — Add persistent reconciliation infrastructure

**Rejected:** out of scope and disproportionate to a pre-release best-effort mirror.

## Shared retry constants

Use one small policy for both mechanisms:

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

Cloudflare's current Workflows documentation defines `retries.limit` as the total number of attempts. `limit: 3` therefore matches the local helper's three-attempt bound.

Use the same short 100 ms base already present in the authoritative `mark-failed` local retry pattern. With three attempts, the local helper waits 100 ms then 200 ms before the final attempt. Do not add a timeout override or dynamic delay callback.

## In-step helper

Add one module-local helper in `apps/workflows/src/index.ts`, conceptually:

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

Exact naming may change, but preserve these semantics:

- at most three attempts;
- no log for an intermediate transient failure;
- short bounded delay between attempts;
- final failure is logged once with puzzle ID and target status;
- the helper does **not** throw after exhaustion, because doing so inside `mark-failed` could turn a best-effort D1 problem into failure/retry of the containing canonical step;
- keep it local to `index.ts`; do not export it or move it into `helpers.ts`/`@perseus/shared`.

This helper is only for the two mirrors already nested inside `mark-failed`.

## Success path: use Workflow retry

Keep the existing placement after the main generation `try/catch` so D1 can never trigger canonical `mark-failed` after the DO has become `ready`.

Change the current shape from:

```ts
await step.do('mirror-ready-status-to-d1', async () => {
	try {
		await setPuzzleStatus(..., 'ready');
	} catch (error) {
		console.error(...);
	}
});
```

to:

```ts
try {
	await step.do('mirror-ready-status-to-d1', D1_MIRROR_STEP_CONFIG, async () => {
		await setPuzzleStatus(getDb(this.env), puzzleId, 'ready');
	});
} catch (error) {
	console.error(
		`Failed to mirror puzzle ${puzzleId} status ready to D1 after ${D1_MIRROR_MAX_ATTEMPTS} attempts:`,
		error
	);
}
```

The important boundary is the catch *around* `step.do`, not inside its callback:

- transient callback throws are visible to Workflow and retried;
- after all attempts fail, the outer catch logs once and keeps the mirror non-fatal;
- the authoritative DO remains `ready`.

## Failure path: keep `mark-failed` structure

Do not change the current authoritative retry loop, `doSucceeded`, `alreadyReady`, 409 matching, warning, or CRITICAL diagnostics.

Only replace the two one-shot D1 blocks:

### Already-ready branch

Current:

```ts
try {
	await setPuzzleStatus(getDb(this.env), puzzleId, 'ready');
} catch (...) {
	...
}
```

Planned:

```ts
await mirrorPuzzleStatusWithRetry(getDb(this.env), puzzleId, 'ready');
return;
```

### Canonical failed branch

Planned:

```ts
await mirrorPuzzleStatusWithRetry(getDb(this.env), puzzleId, 'failed');
return;
```

Because the helper swallows only its final mirror failure, the enclosing `mark-failed` step still completes after the authoritative outcome is established. The catch block then rethrows the same original workflow error as today.

If all authoritative DO retries fail, keep the current behavior: log CRITICAL diagnostics and do not attempt a D1 terminal status that was not established canonically.

## Logging

For an exhausted mirror, emit one explicit application-level error containing:

- puzzle ID;
- target D1 status (`ready` or `failed`);
- the configured attempt count;
- the final error object.

Do not log each transient D1 attempt. Cloudflare may record step-attempt failures in Workflow history for the success-path step; HPA-120's “one clear final error” requirement applies to the explicit application log after the retry budget is exhausted.

Existing authoritative `mark-failed` per-attempt/CRITICAL logs remain unchanged because they cover a different, canonical failure path.

## Test strategy

Keep all coverage in `apps/workflows/src/index.test.ts` and extend the existing nearby tests rather than creating a new suite/file.

### Workflow-step retry test seam

The current `createMockStep()` ignores retry config and runs callbacks once. Add a small opt-in mode, for example `createMockStep({ respectRetryConfig: true })`, that:

1. recognizes the `(name, config, callback)` overload;
2. runs the callback up to `config.retries.limit` total attempts when it rejects;
3. returns on the first success;
4. rethrows the final error after exhaustion;
5. performs no real delay.

Default behavior stays one attempt so unrelated existing tests do not silently gain platform-retry simulation.

### Ready success-path cases

Extend `Workflow Execution - D1 ready mirror is best-effort`:

- normal success still calls `ready` once;
- transient failure then success calls `ready` twice and workflow resolves;
- permanent failure calls `ready` exactly three times, outer terminal log fires once, workflow still resolves, and the final DO status remains `ready` with no D1/canonical `failed` write.

The transient/permanent cases use the opt-in retry-aware mock step.

### Failed in-step mirror cases

Extend the existing failed-mirror test:

- normal success remains covered;
- transient D1 failure then success calls `failed` twice;
- permanent D1 failure calls `failed` exactly three times, logs once with puzzle ID/status, and still rejects with the original processing error rather than the D1 error.

Use `vi.useFakeTimers()` and `vi.runAllTimersAsync()` for the helper's 100/200 ms waits, following the existing authoritative retry-exhaustion test pattern. Restore real timers in `finally`.

### Already-ready reconciliation cases

Extend the existing recognized-409 test:

- transient D1 `ready` failure then success calls `ready` twice;
- no D1 `failed` write occurs;
- no canonical CRITICAL log occurs;
- the original workflow error remains the rejection.

A separate permanent already-ready test is optional if the helper's permanent-failure behavior is already pinned in the failed branch; the two branches call the same local helper. Do not duplicate a large workflow fixture solely to test the same loop twice.

## Files expected in the implementation PR

- Modify: `apps/workflows/src/index.ts`
- Modify: `apps/workflows/src/index.test.ts`

No other production file should be necessary.

## Acceptance mapping

| HPA-120 criterion | Design coverage |
| --- | --- |
| transient D1 failure within retry budget updates profile status | step-level ready retry + local helper transient tests |
| all three mirror sites covered | ready step uses Workflow retry; already-ready + failed use shared helper |
| exhausted retries log and do not alter authoritative result | outer ready catch + non-throwing in-step helper |
| no persistent reconciliation system | explicitly excluded; two-file implementation |

## Deferred follow-up

None required. If production evidence later shows repeated exhausted mirrors or material profile drift, stronger reconciliation can be considered as a separate reliability ticket. Do not pre-build it in HPA-120.
