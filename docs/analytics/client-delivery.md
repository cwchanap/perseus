# Analytics Client Delivery Contract

HPA-532 provides factories and interfaces only. It does not create a global analytics singleton,
select a production endpoint, or emit events from routes. HPA-533 owns the Worker collector and
sink. HPA-534 owns application construction, consent gating, context snapshots, and event emission.

## Public composition surface

Later application code imports the stable barrel at
`apps/web/src/lib/services/analytics/index.ts`. It exposes:

- the analytics client factory and facade types;
- pure context builders/classifiers;
- the run-ledger factory and bounded result/error types;
- the provider-independent transport interface;
- explicit HTTP, memory, and no-op transport factories.

The queue, scheduler implementation, ledger record layout, and storage key are internal. Routes and
components must not instantiate queue internals or call a provider SDK.

## Construction and enablement

`createAnalyticsClient` requires:

- an `AnalyticsTransport`;
- an `AnalyticsRunLedger`;
- explicit `strictValidation` selection;
- optional clock, UUID factory, scheduler, and bounded error callback.

There is no second `enabled` flag. HPA-534 chooses the transport:

- use `createNoopAnalyticsTransport()` in disabled or not-yet-approved environments;
- use `createHttpAnalyticsTransport()` only after the production privacy-policy/consent gate is
  satisfied;
- use `createMemoryAnalyticsTransport()` for deterministic tests.

Development/tests pass `strictValidation: true` so contract mistakes throw `TypeError`. Product
construction passes `false`, causing invalid analytics input to be reported and dropped without
interrupting gameplay or navigation. Storage, queue, and transport failures never throw through
product code.

## Event materialization

The facade accepts only typed V1 input variants. It creates final envelopes immediately before
queueing:

1. capture a safe integer `occurredAt` from the injected/default clock;
2. create the required event ID;
3. clamp completion counters to `10,000` and set `countersSaturated` when needed;
4. validate the complete exact-key envelope;
5. apply ledger gating for once-per-run events;
6. enqueue only an accepted event.

Occurrence events receive a fresh lowercase UUID v4. Once-per-run events use the deterministic
`analytics:1:<eventName>:<runId>` ID and never request a random UUID.

## Once-per-run ledger

The browser ledger is stored in `localStorage` as a strict versioned record. Its deduplication tuple
is exactly:

```text
(eventSchemaVersion, eventName, runId)
```

`eventSchemaVersion` is copied from the envelope `schemaVersion`; the ledger also has its own record
`schemaVersion`.

The ledger:

- groups marks by `runId`;
- retains marks for 90 days relative to the next successful mark;
- keeps at most 1,000 runs, newest first;
- keeps at most the six V1 once-per-run marks per run;
- validates exact persisted shapes;
- resets malformed current-schema storage with bounded diagnostics;
- preserves a future-schema record and returns `incompatible_schema` without overwriting it.

### Mark-before-enqueue semantics

The facade calls the atomic duplicate check-and-mark operation before enqueueing. Only `recorded`
continues to the queue. `duplicate` is silently suppressed. Storage and future-schema failures are
reported and suppress the event.

This is deliberately at-most-once client emission, not guaranteed delivery. A successfully marked
event may still be lost through queue overflow, transport rejection, or page termination. Moving
the mark after enqueue would split the atomic duplicate decision and could enqueue duplicates; it
would not turn queueing into a delivery acknowledgement.

## Delivery queue

The private queue uses these production constants:

| Policy                  | Value    |
| ----------------------- | -------- |
| Maximum retained events | 100      |
| Maximum batch size      | 20       |
| Scheduled flush delay   | 1,000 ms |

Behavior:

- The first queued event schedules one timer; further events do not create duplicate timers.
- Reaching 20 events starts a non-blocking flush immediately.
- Manual and scheduled flushes drain ordered batches up to 20 until empty.
- Concurrent `flush()` calls share one active promise.
- Events enqueued while a batch is in flight stay ordered behind it.
- Overflow drops the oldest queued event and keeps the new event, preserving recent completion and
  exit evidence.
- A rejected normal batch is dropped and never retried automatically. That flush stops, reports
  `transport_error`, and leaves the unsent tail queued for a later scheduled or manual flush.
- `dispose()` clears the timer and pending queue; later tracking calls have no effect.

HPA-534 should call `void analytics.flush()` after `puzzle_completed` and after a successfully
persisted `personal_best_beaten`. This starts delivery promptly but never delays gameplay,
completion effects, storage, or navigation.

## HTTP transport

The HTTP adapter sends the exact JSON `AnalyticsBatchV1` with:

```text
POST <configured endpoint>
Content-Type: application/json
credentials: omit
cache: no-store
```

A non-2xx response rejects with the bounded generic error `analytics_transport_failed`; the adapter
does not read or propagate a response body into analytics errors.

HPA-534 reuses the existing API-base convention:

```text
${PUBLIC_API_BASE || ''}/api/analytics/events
```

Production normally resolves to same-origin `/api/analytics/events`. Local development may use a
cross-origin API base and relies on the existing CORS configuration. No analytics-specific base URL
is introduced.

## Page-hide delivery

`flushForPageHide` materializes a fresh `puzzle_exited_incomplete` occurrence for each qualifying
callback. It is not ledger-gated.

The queue sends the newest queued tail plus the exit event, capped at 20 total events. Older queued
events remain in memory and may be lost if the page terminates. When the transport accepts the
page-hide batch, only the included queued tail is removed.

The HTTP adapter:

1. starts a swallowed `fetch` with `keepalive: true` and the same
   credentials/cache policy as normal delivery (`credentials: 'omit'`);
2. never waits for the fetch to settle during navigation.

`navigator.sendBeacon` is intentionally avoided because it cannot be configured
with `credentials: 'omit'` and would send cookies on same-origin requests,
violating the analytics privacy contract. Beacon should only be reconsidered if
the endpoint becomes explicitly cookieless and the privacy contract is updated.

Production page-hide reliability is designed primarily for same-origin delivery. Local
cross-origin beacon/keepalive behavior is diagnostic and best effort.

## Other transports

- **Memory:** captures defensive copies, exposes deterministic `getEvents`/`reset`, supports
  page-hide capture, and can fail exactly the next normal send for tests.
- **No-op:** accepts normal and page-hide delivery without network, storage, or callbacks. It is the
  mandatory transport before analytics collection is approved.

## Bounded client errors

The public facade reports only this closed union:

- `invalid_input`;
- `invalid_event_id`;
- `ledger_storage_unavailable`;
- `ledger_incompatible_schema`;
- `transport_failed`;
- `queue_overflow`.

These codes contain no user-provided text, URLs, tokens, response bodies, or stack traces.

## HPA-533 collector handoff

The collector/sink must:

- validate the exact V1 batch and event contracts again at the trust boundary;
- preserve `eventId` losslessly in every sink mapping;
- derive trusted environment, release, and server `receivedAt`; clients do not send them;
- preserve client `occurredAt` for ordering/skew diagnostics;
- keep production and non-production data separate;
- avoid adding IP address, user-agent, precise location, or other hidden enrichment.

Duplicate sink rows may exist despite the client ledger. HPA-535 queries must deduplicate by
`eventId`, for example with `COUNT(DISTINCT eventId)`. Primary time windows and baseline calendar
buckets use trusted `receivedAt`, not client `occurredAt`.

## HPA-534 instrumentation handoff

HPA-534 must:

- construct the client only at the application composition boundary;
- select no-op versus HTTP according to the approved privacy/consent state;
- reuse `PUBLIC_API_BASE`;
- use the public barrel rather than queue/storage internals;
- snapshot context at every emission;
- call prompt non-blocking flushes for completion and successfully persisted personal best;
- use the existing E2E fixture `localStorage.clear()` lifecycle rather than adding analytics-only
  cleanup.
