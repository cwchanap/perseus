# Analytics Event Catalog V1

This catalog is the normative engineering definition of the HPA-532 browser event contract. The
shared TypeScript union and runtime validators in `@perseus/types` remain the executable source of
truth. HPA-534 owns application emission; HPA-533 owns collection and server-side mapping; HPA-535
owns reporting.

## Envelope and batch

Every event has exactly these keys:

| Field | V1 rule |
| --- | --- |
| `eventName` | One of the eight event names in this catalog. |
| `runId` | `null` for `gallery_viewed`; otherwise an accepted puzzle run ID. |
| `context` | An exact `AnalyticsClientContextV1` or `AnalyticsPuzzleContextV1` snapshot. |
| `data` | The exact event-specific object or `null`. No generic property bag is permitted. |
| `schemaVersion` | Exactly `1`. |
| `eventId` | Deterministic for six once-per-run events; fresh lowercase UUID v4 for occurrence events. |
| `occurredAt` | Client wall-clock timestamp in integer milliseconds, `0..Number.MAX_SAFE_INTEGER`. |

Objects are exact-key validated at the event, context, data, batch, and persisted-ledger levels.
Unknown or additional fields invalidate the object.

An `AnalyticsBatchV1` has exactly `schemaVersion: 1` and `events`. A valid batch contains 1–20 valid
V1 events.

## Correlation and event IDs

A puzzle `runId` is either:

- a canonical lowercase UUID v4; or
- `legacy-<64 lowercase hexadecimal characters>`, derived from the canonical migrated legacy
  payload.

Both forms are scoped to one puzzle run. A fresh restart/new play receives a fresh run ID; a resumed
run keeps the same ID. A run ID is not a player ID, browser ID, or cross-run identity.

The six once-per-run events use this deterministic event ID:

```text
analytics:1:<eventName>:<runId>
```

The occurrence events `gallery_viewed` and `puzzle_exited_incomplete` use a fresh canonical
lowercase UUID v4 for each occurrence.

## Context snapshot

Context is captured at emission time. It is not frozen at `puzzle_opened`, so later events in the
same run may legitimately have different authentication, viewport, input, progress, timing,
result, rotation, or assistance values.

### Client context

| Field | Values and derivation |
| --- | --- |
| `authentication` | `unknown` while auth is loading, otherwise `anonymous` or `authenticated`. `unknown` must remain a separate reporting cohort. |
| `viewportClass` | `mobile` for width `< 768`, `tablet` for `768..1023.999…`, `desktop` for width `>= 1024`. Width must be finite and non-negative. |
| `primaryInput` | Last keyboard interaction wins; touch maps to `coarse_pointer`; mouse/pen map to `fine_pointer`; media-query fallback may choose coarse/fine; otherwise `unknown`. |

### Puzzle context

| Field | Values and derivation |
| --- | --- |
| `puzzleSource` | `api` or `local`. |
| `contentOrigin` | Local/Quick content is `player_uploaded`. API content defaults to `unknown` until a trusted ownership signal is available; an explicit bounded API origin may be `system` or `player_uploaded`. |
| `pieceCountBucket` | `1-24`, `25-49`, `50-99`, `100-149`, `150-225`, or `226+`; piece count must be an integer in `1..250`. |
| `aspectBucket` | `square`, `landscape`, or `portrait`. A declared aspect takes precedence; positive finite pixel dimensions are only the fallback. |
| `sessionMode` | `timed` or `relaxed`. |
| `resultClass` | `standard_timed`, `rotation_timed`, `assisted_timed`, or `relaxed`. |
| `timingQuality` | `known` or `legacy_unknown`. |
| `sessionOrigin` | `new` or `resumed`. |
| `rotationUsed` | Monotonic run fact: whether rotation was used at any time before this event, not the current toggle state. |
| `progressBucket` | `0`, `1-24`, `25-49`, `50-74`, `75-99`, or `100`. Percentage is `Math.floor(placedPieceCount / pieceCount * 100)`; only exact completion returns `100`. |
| `assistanceMode` | Cumulative interpretation from persisted facts/counters: `none`, `hint`, `reference`, `ghost_reference`, or `mixed`. |

Assistance derivation is:

- `none`: no hint, no ghost-reference fact, and zero reference activations;
- `hint`: hint used and zero reference activations;
- `reference`: no hint, no ghost-reference fact, and one or more reference activations;
- `ghost_reference`: no hint and the ghost-reference fact is true;
- `mixed`: hint used and one or more reference activations.

The once-per-run `reference_used.data.referenceMode` records the first counted transition as
`hold`, `toggle`, or `ghost`. It is event-local evidence and must not be used to reconstruct the
full cumulative reference-mode mix after a reload.

### Cross-field invariants

- Relaxed mode requires `resultClass: 'relaxed'` and `timingQuality: 'known'`.
- Timed mode forbids `resultClass: 'relaxed'`.
- `rotation_timed` requires `rotationUsed: true`.
- A timed run with `rotationUsed: true` cannot remain `standard_timed`; it may be
  `rotation_timed` or, when qualifying assistance has precedence, `assisted_timed`.
- On timed runs, `hint`, `ghost_reference`, and `mixed` require `assisted_timed`.
- On timed runs, `assisted_timed` requires `hint`, `ghost_reference`, or `mixed`.
- `reference` alone is compatible with `standard_timed` or `rotation_timed`.
- `legacy_unknown` timing is not valid for relaxed results.

## Event definitions

### `gallery_viewed`

- **Emitter owner:** HPA-534 gallery route.
- **Classification:** occurrence event; not ledger-gated.
- **Emission intent:** exactly once per gallery route-component mount after the initial gallery
  request settles successfully, including a legitimate empty result.
- **Run:** `runId: null`.
- **Data:** `null`.
- **Event ID:** fresh lowercase UUID v4.
- **Do not interpret as:** a search, category, pagination, infinite-scroll, or impression event.
  Reactive updates and subsequent requests in the same mount do not create additional events.

### `puzzle_opened`

- **Emitter owner:** HPA-534 puzzle route.
- **Classification:** once per run.
- **Emission intent:** the current puzzle-route mount has constructed the active session and is
  ready to accept gameplay input. Auth may still be `unknown`.
- **Data:** `null`.
- **Event ID:** `analytics:1:puzzle_opened:<runId>`.
- **Do not interpret as:** a unique player, a successful load of every image asset, or proof that a
  piece was placed.

### `first_piece_placed`

- **Emitter owner:** HPA-534 accepted-placement session event.
- **Classification:** once per run.
- **Emission intent:** the first accepted piece placement for a run whose persisted successful
  placement count was previously zero.
- **Data:** `{ mountToFirstPlacementMs }`.
- **Unit and range:** integer milliseconds in `0..86,400,000`.
- **Context rule:** `progressBucket` must not be `0`.
- **Event ID:** `analytics:1:first_piece_placed:<runId>`.
- **Do not interpret as:** total wall time since the original run began. The anchor is the current
  puzzle-route mount after session construction; a resumed zero-placement run measures from its
  resumed mount.

### `hint_used`

- **Emitter owner:** HPA-534 successful hint-target transition.
- **Classification:** once per run.
- **Emission intent:** at least one hint has been successfully used in the run.
- **Data:** `null`.
- **Context rule:** assistance is `hint` or `mixed`.
- **Event ID:** `analytics:1:hint_used:<runId>`.
- **Do not interpret as:** number of hint requests or taps. Completion counters carry bounded
  cumulative usage.

### `reference_used`

- **Emitter owner:** HPA-534 first counted reference transition.
- **Classification:** once per run.
- **Emission intent:** the first counted reference activation in the run.
- **Data:** `{ referenceMode: 'hold' | 'toggle' | 'ghost' }`.
- **Context rule:** `ghost` requires `ghost_reference` or `mixed`; `hold`/`toggle` require
  `reference` or `mixed`.
- **Event ID:** `analytics:1:reference_used:<runId>`.
- **Do not interpret as:** the complete run-level distribution of reference modes or total
  activation count.

### `puzzle_completed`

- **Emitter owner:** HPA-534 sealed-completion session event.
- **Classification:** once per run.
- **Emission intent:** the session engine sealed a completion for the active run.
- **Context rule:** `progressBucket: '100'`; mode/result/timing/rotation/assistance invariants must
  hold.
- **Data:**
  - `elapsedActiveSeconds`: whole seconds. Known timed results require `1..86,400`; relaxed results
    and `legacy_unknown` timed results use `null`.
  - `hintsUsed`: integer `0..10,000`.
  - `referenceActivations`: integer `0..10,000`.
  - `countersSaturated`: boolean. It is true when a raw counter exceeded the cap; a true emitted
    value requires at least one emitted counter to equal `10,000`.
- **Counter/context rule:** positive reference activations require a reference-bearing assistance
  mode; positive hint count requires `hint` or `mixed`; zero counters cannot contradict the
  assistance mode.
- **Event ID:** `analytics:1:puzzle_completed:<runId>`.
- **Do not interpret as:** proof that analytics delivery succeeded. Counter values marked saturated
  are lower bounds, not exact totals. The event intentionally does not carry `placedPieceCount`.

### `personal_best_beaten`

- **Emitter owner:** HPA-534 local completion-statistics effect.
- **Classification:** once per run.
- **Emission intent:** `recordLocalCompletion` successfully persisted a new device-local standard
  best for the active run.
- **Context requirements:** timed, `standard_timed`, known timing, no rotation, progress `100`, and
  assistance `none`.
- **Data:** `{ elapsedActiveSeconds }`, integer seconds in `1..86,400`.
- **Event ID:** `analytics:1:personal_best_beaten:<runId>`.
- **Do not interpret as:** a profile/server/global best, a failed or replayed write, or a best from
  a stale run.

### `puzzle_exited_incomplete`

- **Emitter owner:** HPA-534 qualifying puzzle `pagehide` handler.
- **Classification:** occurrence event; not ledger-gated. Multiple exits from one resumed run are
  valid.
- **Emission intent:** supporting evidence that an active, incomplete run was present when the page
  hid.
- **Data:**
  - `elapsedActiveSeconds`: `null` or integer seconds in `0..86,400`;
  - `placedPieceCount`: integer `0..250`; the context builder additionally rejects a count above
    the actual puzzle piece count.
- **Event ID:** fresh lowercase UUID v4 for every qualifying callback.
- **Do not interpret as:** a definitive abandonment event or a unique exit per run. Funnel queries
  must reduce supporting exits to distinct runs and derive abandonment with an explicit inactivity
  rule.

## Versioning and extension rules

V1 semantics are immutable. Any change to an existing field, unit, numeric limit, bucket boundary,
enum meaning, cross-field invariant, or event interpretation requires a new event schema version.
New event names may be added as new strict union variants, but never through free-form properties.

The event envelope field is `schemaVersion`. A ledger mark stores the same value as
`eventSchemaVersion` because the ledger itself also has a separate `schemaVersion`; it is not a
second event-version line.
