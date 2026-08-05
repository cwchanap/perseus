# HPA-532 Third-Pass Contract Amendments

> **Status:** Normative addendum to
> `docs/superpowers/plans/2026-08-02-hpa-532-analytics-contract-client-adapters.md`.
> This file supersedes any conflicting contract, task, test, or documentation language in the
> base plan. Non-conflicting sections of the base plan remain authoritative.

## Why this addendum exists

The third design review identified two V1 correctness gaps that the existing session state cannot
support safely:

1. cumulative reference-mode history is not persisted across reloads; and
2. auth starts in `loading`, so treating it as unclassifiable would drop `puzzle_opened` and corrupt
   the funnel denominator.

It also identified several cheap contract locks that prevent ambiguous implementation and bad
analytics data. These changes require no PuzzleSession persistence migration.

---

## 1. Cumulative assistance uses persisted facts and counters only

Replace the base-plan cumulative `AnalyticsAssistanceMode` union with:

```ts
export type AnalyticsAssistanceMode = 'none' | 'hint' | 'reference' | 'ghost_reference' | 'mixed';
```

Replace `AssistanceUsageSnapshot.referenceModesUsed` with:

```ts
export interface AssistanceUsageSnapshot {
	hintUsed: boolean;
	ghostReferenceUsed: boolean;
	referenceActivations: number;
}
```

The exact derivation is:

- `none`: `hintUsed === false`, `ghostReferenceUsed === false`, and
  `referenceActivations === 0`.
- `hint`: `hintUsed === true` and `referenceActivations === 0`.
- `reference`: `hintUsed === false`, `ghostReferenceUsed === false`, and
  `referenceActivations > 0`.
- `ghost_reference`: `hintUsed === false` and `ghostReferenceUsed === true`.
- `mixed`: `hintUsed === true` and `referenceActivations > 0`.

V1 deliberately does not claim whether a resumed run used hold, toggle, or both. The once-per-run
`reference_used.data.referenceMode` still records the first counted transition when it occurs:

```ts
data: {
	referenceMode: 'hold' | 'toggle' | 'ghost';
}
```

That event-local field is not used to reconstruct cumulative assistance after reload.

Required invariants:

- positive `referenceActivations` never maps to `none`;
- completion validation enforces
  `data.referenceActivations > 0 -> context.assistanceMode !== 'none'`;
- on timed runs, `hint`, `ghost_reference`, and `mixed` require `assisted_timed`;
- on timed runs, `assisted_timed` requires `hint`, `ghost_reference`, or `mixed`;
- `reference` alone remains compatible with `standard_timed` or `rotation_timed`.

Task 2 tests must include resumed-run fixtures whose persisted reference counter is positive while
no runtime reference mode is active.

---

## 2. Authentication has an explicit `unknown` class

Replace:

```ts
export type AnalyticsAuthenticationClass = 'anonymous' | 'authenticated';
```

with:

```ts
export type AnalyticsAuthenticationClass = 'anonymous' | 'authenticated' | 'unknown';
```

`resolveAuthenticationClass('loading')` returns `unknown`, never `null`:

```ts
export function resolveAuthenticationClass(
	status: 'loading' | 'authenticated' | 'anonymous'
): AnalyticsAuthenticationClass;
```

Rules:

- cold-load `puzzle_opened` emits immediately with `authentication: 'unknown'` when auth is still
  loading;
- later events in the same run may use `anonymous` or `authenticated` after the store resolves;
- a refresh that temporarily re-enters `loading` also maps to `unknown`;
- dashboards keep `unknown` separate and never fold it into anonymous.

Task 2 and facade tests must prove auth loading cannot drop an otherwise valid event.

---

## 3. Scheduler and queue ownership are explicit

Task 5 must define:

```ts
export interface AnalyticsScheduler {
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(handle: unknown): void;
}
```

`createAnalyticsClient` constructs one private delivery queue from the supplied transport,
scheduler, and locked queue constants. Queue tests cover batching, overflow, concurrency, and
timers directly. Facade tests inject a fake scheduler plus the memory transport to verify wiring.
The queue remains private and is not exported through the product-facing barrel.

---

## 4. First-placement latency is mount-scoped

Rename the data field:

```ts
data: {
	mountToFirstPlacementMs: number;
}
```

and rename the limit:

```ts
export const ANALYTICS_MAX_MOUNT_TO_FIRST_PLACEMENT_MS = MAX_COMPLETION_TIME_SECONDS * 1000;
```

The anchor is a monotonic timestamp captured when the current puzzle-route mount finishes
constructing the session.

- A fresh run measures from its first mount.
- A resumed run with zero persisted successful placements measures from the resumed mount.
- A run whose persisted successful-placement counter is already nonzero does not emit the event
  again.

The catalog and HPA-534 must not describe this value as total wall time since the original run
began.

---

## 5. Mark-before-enqueue remains intentional

The proposed switch to mark-after-enqueue is not accepted.

The synchronous ledger performs one atomic duplicate check-and-mark operation before enqueue.
Splitting this into a pre-enqueue lookup and post-enqueue mark can enqueue duplicates. Enqueue keeps
the newest event and only evicts an older entry on overflow, so moving the mark does not protect the
new event from the later transport/page-termination losses that motivated the suggestion.

The existing at-most-once caveat remains: marking is not a delivery acknowledgement. Completion and
successfully persisted personal-best events start a prompt non-blocking `void analytics.flush()`
to reduce, not eliminate, loss.

---

## 6. Counters clamp and report saturation

Raw `hintsUsed` and `referenceActivations` must be non-negative integers. Event builders clamp them
to `ANALYTICS_MAX_COUNTER` instead of rejecting the completion event.

Update completion data to:

```ts
data: {
	elapsedActiveSeconds: number | null;
	hintsUsed: number;
	referenceActivations: number;
	countersSaturated: boolean;
}
```

`countersSaturated` is true when either raw counter exceeded the cap. Validators accept only
bounded emitted values and a boolean saturation flag. Tests cover one and both counters exceeding
the cap without losing `puzzle_completed`.

HPA-533 must preserve the saturation flag in its mapping, and HPA-535 must treat capped counters as
lower bounds rather than exact values.

---

## 7. Personal-best preconditions are validator-enforced

A `personal_best_beaten` envelope is valid only when all are true:

- `sessionMode === 'timed'`;
- `resultClass === 'standard_timed'`;
- `timingQuality === 'known'`;
- `rotationUsed === false`;
- `elapsedActiveSeconds` is a positive bounded integer.

The HPA-534 emitter still additionally requires the active-run result from `recordLocalCompletion`
to be `status: 'recorded'` with `isNewStandardBest: true`.

---

## 8. Gallery emission is once per route mount

`gallery_viewed` emits exactly once per gallery route-component mount after the initial gallery
request settles successfully, including a legitimate empty result.

Search changes, category changes, pagination, infinite scroll, reactive reruns, and subsequent
successful requests in the same mount never emit another event.

HPA-534 route tests must exercise reactive search/category/pagination updates and assert one event.

---

## 9. HPA-533 derives trusted server receive time

`receivedAt` is server-derived and is not part of the client envelope. HPA-533 must preserve:

- client `occurredAt` for ordering/skew diagnostics;
- trusted server `receivedAt` for calendar bucketing and operational timelines.

HPA-535 queries use `receivedAt` for day/hour windows and baseline-period boundaries. They must not
bucket primary metrics by client `occurredAt`.

---

## 10. Progress rounding is locked

Progress percentage uses:

```ts
Math.floor((placedPieceCount / pieceCount) * 100);
```

Only `placedPieceCount === pieceCount` returns `100`. For example, `249 / 250` maps to `75-99`.
Task 2 tests include 1-piece, 249/250, and exact-completion boundaries.

---

## 11. Run-ID privacy covers both accepted forms

The privacy document must state that a run ID may be:

- a fresh canonical UUID v4; or
- `legacy-<sha256-of-canonical-legacy-payload>` for a migrated legacy session.

Both forms remain run-scoped and are not cross-run user identifiers. Deterministic analytics event
IDs may embed either accepted form.

---

## 12. Version naming is one system

Event envelopes use `schemaVersion`. Persisted ledger marks use `eventSchemaVersion` because the
ledger record itself also has its own `schemaVersion`.

`eventSchemaVersion` is an exact copy of the event envelope `schemaVersion`; it is not a separate
version line. The dedup tuple remains:

```text
(eventSchemaVersion, eventName, runId)
```

---

## 13. Endpoint configuration reuses `PUBLIC_API_BASE`

HPA-534 follows the existing `PUBLIC_API_BASE || ''` convention used by
`apps/web/src/lib/services/api.ts` and must not introduce a second analytics-specific base URL.

The endpoint is `${PUBLIC_API_BASE || ''}/api/analytics/events`.

Production page-hide delivery is designed primarily for same-origin use. Local cross-origin beacon
or keepalive delivery remains best effort and diagnostic.

---

## 14. Existing E2E cleanup is sufficient

The deterministic gameplay fixture already calls `localStorage.clear()` during teardown. The
analytics ledger key therefore requires no bespoke E2E cleanup API. HPA-534 tests must use the
existing fixture lifecycle rather than adding a second cleanup mechanism.

---

## Updated self-review additions

Before implementation begins, verify all of the following:

- [ ] cumulative assistance is derivable after reload using only persisted facts/counters;
- [ ] positive reference activation counts cannot coexist with assistance `none`;
- [ ] auth loading produces `unknown` and never drops `puzzle_opened`;
- [ ] `AnalyticsScheduler` is defined and client-to-private-queue wiring is testable;
- [ ] first-placement latency is explicitly current-mount scoped;
- [ ] counter overflow clamps and sets `countersSaturated` instead of dropping completion;
- [ ] personal-best preconditions are enforced by the final-envelope validator;
- [ ] gallery reactive updates cannot emit more than once per route mount;
- [ ] HPA-533 derives trusted `receivedAt` and HPA-535 buckets time with it;
- [ ] progress uses floor rounding and exact completion for `100`;
- [ ] privacy documents UUID and legacy run-ID forms;
- [ ] `schemaVersion` and `eventSchemaVersion` are documented as one event-version value;
- [ ] HPA-534 reuses `PUBLIC_API_BASE` and the existing E2E localStorage teardown.
