# HPA-120: Bounded Retries for Best-Effort D1 Mirrors — Design

**Linear:** HPA-120  
**Status:** Design for implementation  
**Date:** 2026-08-16

## Context

HPA-120 is the next standalone actionable Perseus issue after the HPA-215 gameplay children were completed. The issue is intentionally narrow: D1 is a best-effort mirror of authoritative puzzle metadata, but the three status-mirror call sites currently catch D1 errors inside their Workflow callbacks. That makes the Workflow step itself look successful, so Cloudflare Workflows never gets a chance to apply durable retry semantics.

The affected paths are all in `apps/workflows/src/index.ts`:

1. successful generation finalizes the authoritative `PuzzleMetadataDO` to `ready`, then mirrors `ready` to D1;
2. a genuine processing failure writes authoritative `failed` metadata and then mirrors `failed` to D1;
3. the error path can discover that `finalize` already committed `ready`; it preserves that authoritative state and reconciles D1 back to `ready`.

The authoritative-store rule is already correct and must remain unchanged: a D1 failure cannot turn a successfully finalized puzzle into `failed`.

`setPuzzleStatus()` is already idempotent for these call sites: it performs an unconditional update of the puzzle row to the supplied status. Retrying the same terminal status therefore does not need a new token, transaction, schema, or compare-and-swap contract.

Cloudflare Workflows already supplies the primitive HPA-120 needs. `step.do(name, config, callback)` can apply a bounded retry policy to a throwing callback, persists successful step results, and resumes from completed steps rather than replaying them. Cloudflare also documents catching an exhausted `step.do` outside the step when failure is intentionally non-fatal:

- [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- [Build your first Workflow](https://developers.cloudflare.com/workflows/get-started/guide/)

The missing work is therefore step placement and error boundaries, not a new retry framework.

## Goals

1. Retry transient D1 `ready` mirror failures within a dedicated Workflow step.
2. Retry transient D1 `failed` mirror failures only after the authoritative DO write has succeeded.
3. Retry transient already-ready D1 reconciliation failures without re-running the DO transition attempt.
4. Bound all three mirrors to the same small retry policy.
5. Emit one clear application-level terminal error only after the mirror step exhausts its attempts.
6. Preserve current canonical-store behavior and the original workflow error.
7. Keep the implementation local to the existing workflow and its tests.

## Non-goals

- Exactly-once synchronization between the DO and D1.
- An outbox, queue, event log, repair service, or new reaper path.
- D1 schema or migration changes.
- Changing `setPuzzleStatus()` semantics.
- Replacing the existing manual retry loop for the authoritative `mark-failed` DO write.
- General-purpose retry utilities for unrelated Workers/API code.
- Dynamic retry delays, error classification, jitter, circuit breakers, metrics infrastructure, or alerting.
- Reworking workflow failure semantics: genuine processing failures still rethrow their original error.
- Backward-compatibility machinery for already-running pre-change workflow instances.

## Reuse survey

| Need | Existing seam | Decision |
| --- | --- | --- |
| Durable retries | Cloudflare `step.do` retry config | Reuse directly; no custom sleep loop for D1 |
| Authoritative ready state | existing `finalize` step | Keep unchanged |
| Authoritative failed state | existing `mark-failed` step | Keep its current DO retry loop and 409 handling |
| D1 status write | `@perseus/shared` `setPuzzleStatus()` | Reuse unchanged; writes are idempotent for a terminal status |
| D1 connection | existing `getDb()` isolate cache | Reuse unchanged |
| Ready mirror | `mirror-ready-status-to-d1` | Keep the step name and make its callback throw to Workflow |
| Failure-path outcome | existing `doSucceeded` / `alreadyReady` branches | Return a small serializable outcome from `mark-failed` |
| Unit coverage | `apps/workflows/src/index.test.ts` | Extend existing workflow tests and mock step; no new test file/framework |

No new production module is justified. The three mirrors live in one orchestration file and share behavior only inside that file.

## Options considered

### Option A — Dedicated retryable mirror steps with one local best-effort wrapper (selected)

Each D1 write runs in its own `step.do` whose callback is allowed to throw. A tiny local helper owns the shared retry config and catches only the final exhausted step error. The `mark-failed` step returns a serializable canonical outcome; the caller then chooses the appropriate D1 mirror step before rethrowing the original workflow error.

**Pros**

- uses Cloudflare's durable retry primitive rather than emulating it;
- a D1 retry cannot replay a DO transition;
- keeps canonical and mirror failure semantics explicit;
- three call sites share one policy and one terminal-log boundary;
- no new module, database contract, or infrastructure.

**Cons**

- adds two named Workflow steps on failure paths;
- `mark-failed` must return an outcome instead of performing the D1 side effect inline.

This is the smallest design that satisfies all four acceptance criteria without widening the ticket.

### Option B — Let D1 failure retry the whole `mark-failed` step

Keep the D1 write inside `mark-failed`, remove its local catch, and add retry config to that step.

**Rejected:** a transient mirror outage would replay the authoritative DO update and its manual retry loop. Cloudflare's own guidance is to split work into separate steps when a later failure should not re-run earlier external operations. HPA-120 specifically wants mirror retries without changing canonical metadata.

### Option C — Add a custom retry loop around `setPuzzleStatus()`

Call D1 multiple times inside the existing callback with manual sleeps/backoff.

**Rejected:** it duplicates a platform feature, makes retries less durable across workflow replay/resume, and leaves the exact step-boundary problem called out by HPA-120.

### Option D — Add an outbox/reconciliation subsystem

Persist desired mirror writes and drain them independently.

**Rejected:** this solves a larger consistency problem than the ticket asks for. D1 remains a best-effort mirror and existing repair/admin paths remain the fallback after bounded retry exhaustion.

## Selected retry policy

Use one explicit local config for all three D1 mirror steps:

```ts
const D1_MIRROR_STEP_CONFIG = {
	retries: {
		limit: 3,
		delay: '1 second',
		backoff: 'exponential'
	}
} as const;
```

Cloudflare's current Workflows documentation defines `retries.limit` as the total number of attempts for the step. `limit: 3` therefore gives one initial attempt plus up to two retries, with short waits suitable for a transient D1 failure.

Do not add a custom `timeout`; the mirror is one D1 update and the platform default is sufficient. Do not add a dynamic delay callback or classify D1 error strings in this ticket.

## Local best-effort mirror boundary

Add one module-local helper in `apps/workflows/src/index.ts`, conceptually:

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

The exact parameter names may change during implementation, but keep these semantics:

- the D1 callback contains no `try/catch`, so a transient error reaches `step.do` and triggers its retry policy;
- the catch is outside `step.do`, so only exhausted retries reach the application terminal logger;
- the helper never throws the mirror error back to canonical workflow logic;
- the helper is local to `index.ts`; do not move it into `helpers.ts` or `@perseus/shared` for three call sites in one class.

Cloudflare may record failed attempts in Workflow history. HPA-120's “one clear terminal error” requirement applies to explicit application logging: do not `console.error` on every D1 attempt from the callback.

## Success path: `ready`

Keep the authoritative `finalize` step exactly where it is:

```text
finalize DO -> ready
    |
    v
mirror-ready-status-to-d1 (3 attempts total, best effort)
```

Replace the current inner D1 `try/catch` with `runBestEffortD1Mirror(...)` around the existing `mirror-ready-status-to-d1` step name.

If all D1 attempts fail:

- log one terminal mirror error;
- return from the workflow normally;
- do not enter `mark-failed`;
- leave the DO at `ready`.

This preserves the existing reason the ready mirror sits after the main `try/catch`.

## Failure path: separate canonical outcome from mirror work

The current `mark-failed` step performs both authoritative DO work and the D1 mirror. Split only that ownership; do not rewrite its retry algorithm.

Have `mark-failed` return one of three small serializable outcomes:

```ts
type MarkFailedOutcome = 'failed' | 'already-ready' | 'unreconciled';
```

Meaning:

- `failed`: the authoritative DO accepted `status: 'failed'`;
- `already-ready`: the DO returned the existing recognized 409 guard, so canonical state is already `ready`;
- `unreconciled`: all existing DO mark-failed attempts failed, so canonical state was not established by this path.

The current warning/error/CRITICAL logging inside the DO loop stays intact.

After the `mark-failed` step completes:

```text
outcome = failed
    -> mirror-failed-status-to-d1
    -> rethrow originalError

outcome = already-ready
    -> reconcile-already-ready-status-to-d1 (writes ready)
    -> rethrow originalError

outcome = unreconciled
    -> no D1 mirror
    -> rethrow originalError
```

Both D1 branches use the same local best-effort helper and retry config. A D1 failure therefore cannot cause another `updateMetadata(... status: 'failed')` call.

The original workflow error remains the error that escapes the catch block. Never replace it with the mirror error.

## Step names

Use explicit stable names so Workflow history describes the recovery path:

- keep `mirror-ready-status-to-d1` for the success path;
- add `mirror-failed-status-to-d1` after a successful canonical failed transition;
- add `reconcile-already-ready-status-to-d1` after the recognized ready/failed conflict.

Do not collapse all three into one dynamically status-named step. They are mutually exclusive paths but represent different operational meanings, and explicit names make the terminal log/test expectations clearer at almost no cost.

## Test strategy

Keep coverage in `apps/workflows/src/index.test.ts`.

The existing mock `WorkflowStep.do()` executes a callback once and ignores retry config. Extend that test seam with an opt-in retry-aware mode (or a similarly small dedicated helper) that:

1. recognizes the `(name, config, callback)` overload;
2. runs the callback up to `config.retries.limit` total attempts when it rejects;
3. returns immediately on success;
4. rethrows the final error after exhaustion;
5. does not sleep in tests.

Keep ordinary existing tests on their current one-attempt behavior unless they specifically verify Workflow retries; avoid changing unrelated test timing/semantics globally.

Required cases:

### Ready mirror transient failure

- D1 rejects once, then succeeds.
- `setPuzzleStatus(..., 'ready')` is called twice.
- the workflow resolves successfully.
- the canonical DO stays `ready` and receives no `failed` transition.
- the mirror step receives the shared retry config.

### Ready mirror exhaustion

- D1 rejects for all configured attempts.
- attempts stop at the configured bound.
- exactly one application terminal mirror error is logged.
- the workflow still resolves and canonical DO remains `ready`.

### Failed mirror transient failure

- create a genuine processing error.
- the authoritative DO reaches `failed` first.
- D1 `failed` rejects once, then succeeds in `mirror-failed-status-to-d1`.
- D1 retry does not cause another canonical `mark-failed` transition.
- the original processing error still rejects the workflow.

### Already-ready reconciliation transient failure

- exercise the existing recognized 409 `already ready` path.
- D1 `ready` rejects once, then succeeds in `reconcile-already-ready-status-to-d1`.
- no D1 `failed` write occurs.
- no CRITICAL canonical-state log occurs.
- the original workflow error still rejects as it does today.

Keep the existing authoritative `mark-failed` retry-exhaustion tests. They protect a different retry loop and should not be rewritten to use the D1 helper.

## Files expected in the implementation PR

- Modify: `apps/workflows/src/index.ts`
- Modify: `apps/workflows/src/index.test.ts`

No other production file should be necessary. If implementation discovers a required third production seam, stop and explain it in the implementation PR rather than extracting infrastructure speculatively.

## Acceptance mapping

| HPA-120 criterion | Design coverage |
| --- | --- |
| `ready` mirror retries transient D1 failure within the workflow step | dedicated retryable `mirror-ready-status-to-d1` |
| `failed` mirror retries after DO succeeds | `mark-failed` returns `failed`, then dedicated mirror step |
| already-ready reconciliation retries | `mark-failed` returns `already-ready`, then dedicated reconcile step |
| exhausted retries log one terminal error and do not change canonical metadata | callback throws to `step.do`; outer helper catches only exhaustion; canonical work is in an earlier completed step |

## Deferred follow-up

None required for HPA-120. If production evidence later shows frequent exhausted mirrors, that would justify separately evaluating stronger reconciliation/outbox machinery. Do not pre-build it here.
