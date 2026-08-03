# HPA-532 Analytics Contract and Client Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define a strict, versioned, privacy-conscious analytics event contract and a provider-independent browser client that later tickets can connect to the Worker collector and puzzle/gallery emission points without changing phase-one semantics.

**Architecture:** Extract the existing completion/run primitives that analytics consumes into a focused shared module, then place the cross-runtime event envelope, bounded dimensions, deterministic run-event IDs, and runtime validators in `@perseus/types`. Put pure context projection, a bounded once-per-run ledger, transports, delivery queue, and the public client facade under `apps/web/src/lib/services/analytics/`. HPA-532 exports factories and interfaces only; it does not instantiate an application singleton, call analytics from routes, or enable production collection. HPA-533 owns the Worker collector/sink and HPA-534 owns runtime wiring and event emission.

**Tech Stack:** TypeScript 5.9, Bun, Turborepo, Vitest 4, Vitest browser mode with Playwright/Chromium, browser `localStorage`, `fetch`, `navigator.sendBeacon`, and the repository's existing handwritten runtime-validator conventions.

## References

- Linear: https://linear.app/cwchanap/issue/HPA-532/analytics-define-the-event-contract-and-client-adapters
- Parent: https://linear.app/cwchanap/issue/HPA-225/analytics-instrument-the-puzzle-solve-funnel-and-establish-a-baseline
- Session foundation: https://linear.app/cwchanap/issue/HPA-236/foundation-extract-puzzlesession-state-and-version-the-persisted
- Downstream collector: https://linear.app/cwchanap/issue/HPA-533/analytics-add-the-worker-collector-and-analytics-engine-sink
- Downstream instrumentation: https://linear.app/cwchanap/issue/HPA-534/analytics-instrument-the-phase-one-puzzle-solve-funnel

## Global Constraints

- Do not implement the Worker route, Analytics Engine sink, gallery/puzzle instrumentation, dashboard, or E2E analytics capture in this ticket.
- Product routes and components must eventually import only the public analytics facade; they must not import HTTP transports, queue/storage internals, or provider code.
- Add no analytics vendor SDK and no runtime-validation dependency.
- The contract contains no player ID, anonymous browser ID, puzzle ID, email, display name, filename, puzzle name, raw search text, image URL, secret URL, access/session token, user-agent string, precise location, or uncontrolled free text.
- `runId` is the only cross-event correlation value for puzzle events and must pass the existing HPA-236 `isPuzzleRunId` validator.
- Existing event meanings are immutable. Adding a field to an existing event, changing a bucket boundary, or changing an enum meaning requires a new event schema version.
- New events are strict typed union variants. Never add `properties: Record<string, unknown>` or another generic property bag.
- Event, context, data, batch, and persisted-ledger objects use exact-key validation. Extra fields are invalid.
- Once-per-run event IDs are deterministic: `analytics:1:<eventName>:<runId>`.
- `gallery_viewed` uses a fresh canonical lowercase UUID v4 event ID.
- The once-per-run ledger retains 90 days and at most 200 entries, newest first.
- A future-schema ledger is preserved and treated as read-only. Older code fails closed and suppresses once-per-run emission rather than overwriting or duplicating events.
- The delivery queue retains at most 100 events, sends batches of at most 20, and schedules a flush after 1,000 ms.
- Queue overflow drops the oldest event so recent completion and exit facts are retained.
- Browser delivery is best effort and at-most-once. A rejected batch is dropped and never retried automatically.
- A failed normal flush stops that flush; remaining unsent events stay queued for a later scheduled or manual flush.
- Page-hide delivery uses `sendOnPageHide`, never blocks navigation, and remains best effort.
- HPA-532 exports no automatically enabled network client. HPA-534 constructs the application client after HPA-533 provides the endpoint.
- Tabs for indentation, single quotes, no trailing commas, and 100-character line width.
- Every behavior change starts with a focused failing test and ends with an independently reviewable commit.

---

## File Structure

### Shared contract

| File | Responsibility |
| --- | --- |
| `packages/types/src/completion.ts` | Existing result-class, timing-quality, completion request, run-ID, and completion validators extracted from the root barrel to avoid circular imports |
| `packages/types/src/analytics.ts` | V1 inputs/envelopes, bounded dimensions, deterministic IDs, exact validators, and batch contract |
| `packages/types/src/analytics.test.ts` | Event matrix, strict-key/PII rejection, IDs, versions, batches, and compile-time negative tests |
| `packages/types/src/index.ts` | Re-export completion and analytics modules while preserving current package imports |
| `packages/types/src/index.test.ts` | Regression proof that the extraction does not change existing completion behavior |

### Web client

| File | Responsibility |
| --- | --- |
| `apps/web/src/lib/services/analytics/context.ts` | Pure bounded context projection and bucket classifiers |
| `apps/web/src/lib/services/analytics/context.test.ts` | Piece-count, aspect, viewport, progress, input, auth, and content-origin boundaries |
| `apps/web/src/lib/services/analytics/run-ledger.ts` | Versioned localStorage ledger and once-per-run mark/prune policy |
| `apps/web/src/lib/services/analytics/run-ledger.test.ts` | Reload idempotency, retention, cap, corruption, future schemas, and storage failures |
| `apps/web/src/lib/services/analytics/transport.ts` | Provider-independent transport interface |
| `apps/web/src/lib/services/analytics/transports/http.ts` | Same-origin JSON batch transport plus page-hide beacon/keepalive path |
| `apps/web/src/lib/services/analytics/transports/memory.ts` | Deterministic capture/reset/fail-next transport for tests |
| `apps/web/src/lib/services/analytics/transports/noop.ts` | Disabled transport with no network activity |
| `apps/web/src/lib/services/analytics/transport.test.ts` | HTTP shape/privacy, page-hide behavior, memory determinism, and no-op behavior |
| `apps/web/src/lib/services/analytics/queue.ts` | Bounded queue, timers, batching, concurrency, overflow, and failure isolation |
| `apps/web/src/lib/services/analytics/queue.test.ts` | Fake-timer batching, overflow, failure, concurrency, and page-hide coverage |
| `apps/web/src/lib/services/analytics/analytics.ts` | Event materialization, validation, ledger gating, queue orchestration, and public facade |
| `apps/web/src/lib/services/analytics/analytics.test.ts` | Sequencing, IDs/timestamps, duplicates, invalid input, and transport failures |
| `apps/web/src/lib/services/analytics/index.ts` | Stable public exports for later product code |

### Documentation

| File | Responsibility |
| --- | --- |
| `docs/analytics/event-catalog.md` | Exact event semantics, fields, dimensions, buckets, versioning, and extension rules |
| `docs/analytics/client-delivery.md` | Factory ownership, ledger, queue, transports, drop/failure policy, and HPA-533/HPA-534 handoff |
| `docs/analytics/privacy.md` | Data minimization, prohibited fields, local ledger behavior, and production privacy/consent gate |

No dependency or lockfile change is expected.

---

## Public Contract Locked by This Plan

```ts
export const ANALYTICS_EVENT_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_BATCH_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_MAX_BATCH_SIZE = 20;

export type AnalyticsAuthenticationClass = 'anonymous' | 'authenticated';
export type AnalyticsPuzzleSource = 'api' | 'local';
export type AnalyticsContentOrigin = 'system' | 'player_uploaded' | 'unknown';
export type AnalyticsPieceCountBucket =
	| '1-24'
	| '25-49'
	| '50-99'
	| '100-149'
	| '150-225'
	| '226+';
export type AnalyticsAspectBucket = 'square' | 'landscape' | 'portrait';
export type AnalyticsViewportClass = 'mobile' | 'tablet' | 'desktop';
export type AnalyticsPrimaryInput =
	| 'coarse_pointer'
	| 'fine_pointer'
	| 'keyboard'
	| 'unknown';
export type AnalyticsSessionMode = 'timed' | 'relaxed';
export type AnalyticsSessionOrigin = 'new' | 'resumed';
export type AnalyticsProgressBucket = '0' | '1-24' | '25-49' | '50-74' | '75-99' | '100';
export type AnalyticsAssistanceMode =
	| 'none'
	| 'hint'
	| 'reference_hold'
	| 'reference_toggle'
	| 'reference_ghost'
	| 'mixed';

export interface AnalyticsClientContextV1 {
	authentication: AnalyticsAuthenticationClass;
	viewportClass: AnalyticsViewportClass;
	primaryInput: AnalyticsPrimaryInput;
}

export interface AnalyticsPuzzleContextV1 extends AnalyticsClientContextV1 {
	puzzleSource: AnalyticsPuzzleSource;
	contentOrigin: AnalyticsContentOrigin;
	pieceCountBucket: AnalyticsPieceCountBucket;
	aspectBucket: AnalyticsAspectBucket;
	sessionMode: AnalyticsSessionMode;
	resultClass: ResultClass;
	sessionOrigin: AnalyticsSessionOrigin;
	rotationEnabled: boolean;
	progressBucket: AnalyticsProgressBucket;
	assistanceMode: AnalyticsAssistanceMode;
}
```

The V1 input union has these exact variants:

```ts
export type AnalyticsEventInputV1 =
	| {
			eventName: 'gallery_viewed';
			runId: null;
			context: AnalyticsClientContextV1;
			data: null;
	  }
	| {
			eventName: 'puzzle_opened';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: null;
	  }
	| {
			eventName: 'first_piece_placed';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: { openToPlacementMs: number };
	  }
	| {
			eventName: 'hint_used';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: null;
	  }
	| {
			eventName: 'reference_used';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: null;
	  }
	| {
			eventName: 'puzzle_completed';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: {
				elapsedActiveSeconds: number | null;
				hintsUsed: number;
				referenceActivations: number;
				placedPieceCount: number;
			};
	  }
	| {
			eventName: 'personal_best_beaten';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: { elapsedActiveSeconds: number };
	  }
	| {
			eventName: 'puzzle_exited_incomplete';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: { elapsedActiveSeconds: number | null; placedPieceCount: number };
	  };

type WithAnalyticsMetadata<T> = T extends AnalyticsEventInputV1
	? T & { schemaVersion: 1; eventId: string; occurredAt: number }
	: never;

export type AnalyticsEventV1 = WithAnalyticsMetadata<AnalyticsEventInputV1>;

export interface AnalyticsBatchV1 {
	schemaVersion: 1;
	events: AnalyticsEventV1[];
}
```

Once-per-run inputs are `puzzle_opened`, `first_piece_placed`, `hint_used`, `reference_used`, `puzzle_completed`, and `personal_best_beaten`. `gallery_viewed` uses `track`. `puzzle_exited_incomplete` uses only `flushForPageHide` and deliberately bypasses ledger gating while retaining a deterministic downstream event ID.

---

## Task 1: Extract Shared Completion Primitives and Add the V1 Contract

**Files:**

- Create: `packages/types/src/completion.ts`
- Create: `packages/types/src/analytics.ts`
- Create: `packages/types/src/analytics.test.ts`
- Modify: `packages/types/src/index.ts`
- Regression test: `packages/types/src/index.test.ts`

**Interfaces produced:**

```ts
// completion.ts, unchanged behavior
export { RESULT_CLASSES, TIMING_QUALITIES, MAX_COMPLETION_TIME_SECONDS };
export type { ResultClass, TimingQuality, RecordPuzzleCompletionV1 };
export function isPuzzleRunId(value: unknown): value is string;
export function isRecordPuzzleCompletionV1(
	value: unknown,
	maxElapsedActiveSeconds: number
): value is RecordPuzzleCompletionV1;

// analytics.ts
export type AnalyticsEventNameV1 = AnalyticsEventInputV1['eventName'];
export type AnalyticsRunEventNameV1 = Exclude<AnalyticsEventNameV1, 'gallery_viewed'>;
export type AnalyticsOncePerRunEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{
		eventName:
			| 'puzzle_opened'
			| 'first_piece_placed'
			| 'hint_used'
			| 'reference_used'
			| 'puzzle_completed'
			| 'personal_best_beaten';
	}
>;
export type AnalyticsTransientEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{ eventName: 'gallery_viewed' }
>;
export type PuzzleExitedIncompleteEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{ eventName: 'puzzle_exited_incomplete' }
>;
export function buildAnalyticsRunEventIdV1(
	eventName: AnalyticsRunEventNameV1,
	runId: string
): string;
export function isAnalyticsEventInputV1(value: unknown): value is AnalyticsEventInputV1;
export function isAnalyticsEventV1(value: unknown): value is AnalyticsEventV1;
export function isAnalyticsBatchV1(value: unknown): value is AnalyticsBatchV1;
```

- [ ] **Step 1: Write failing analytics contract tests**

Create table-driven valid fixtures for all eight events. Add rejection cases for unknown events, versions, missing/extra root/context/data keys, PII-like fields, invalid enums, bad run IDs, invalid numeric values, mismatched deterministic IDs, and batches outside `1..20`. Add `@ts-expect-error` cases for arbitrary events, free-form properties, and PII fields.

- [ ] **Step 2: Verify the focused test fails**

```bash
cd packages/types
bunx vitest run src/analytics.test.ts
```

Expected: FAIL because the analytics contract does not exist.

- [ ] **Step 3: Extract completion/run primitives without behavior changes**

Move the listed definitions and validators from `index.ts` into `completion.ts`. Re-export them from `index.ts`; do not alter regexes, elapsed-time validation, or public names.

```bash
cd packages/types
bunx vitest run src/index.test.ts
```

Expected: PASS.

- [ ] **Step 4: Implement constants, unions, deterministic IDs, and exact validators**

Use explicit exact-key helpers and an event-name switch. Require canonical lowercase UUID v4 for `gallery_viewed`. For every run event, require:

```ts
event.eventId === buildAnalyticsRunEventIdV1(event.eventName, event.runId)
```

- [ ] **Step 5: Re-export the new leaf modules**

Add `export * from './completion';` and `export * from './analytics';`; remove only the moved inline declarations.

- [ ] **Step 6: Run focused and package tests**

```bash
cd packages/types
bunx vitest run src/index.test.ts src/analytics.test.ts
bun run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/completion.ts packages/types/src/analytics.ts \
	packages/types/src/analytics.test.ts packages/types/src/index.ts
git commit -m 'feat(types): add analytics event contract'
```

---

## Task 2: Add Pure Context Projection and Bucket Rules

**Files:**

- Create: `apps/web/src/lib/services/analytics/context.ts`
- Create: `apps/web/src/lib/services/analytics/context.test.ts`

**Interfaces produced:**

```ts
export interface PrimaryInputSnapshot {
	lastInteraction: 'keyboard' | 'pointer' | null;
	pointerType?: 'mouse' | 'pen' | 'touch' | '';
	coarsePointer: boolean | null;
}

export function classifyPieceCountBucket(pieceCount: number): AnalyticsPieceCountBucket | null;
export function classifyAspectBucket(width: number, height: number): AnalyticsAspectBucket | null;
export function classifyViewportClass(width: number): AnalyticsViewportClass | null;
export function classifyProgressBucket(
	placedPieceCount: number,
	pieceCount: number
): AnalyticsProgressBucket | null;
export function classifyPrimaryInput(snapshot: PrimaryInputSnapshot): AnalyticsPrimaryInput;
export function resolveAuthenticationClass(
	status: 'loading' | 'authenticated' | 'anonymous'
): AnalyticsAuthenticationClass | null;
export function resolveContentOrigin(input: {
	puzzleSource: AnalyticsPuzzleSource;
	apiOrigin?: 'system' | 'player_uploaded';
}): AnalyticsContentOrigin;
export function buildAnalyticsClientContextV1(input: {
	authStatus: 'loading' | 'authenticated' | 'anonymous';
	viewportWidth: number;
	primaryInput: PrimaryInputSnapshot;
}): AnalyticsClientContextV1 | null;
export function buildAnalyticsPuzzleContextV1(input: {
	client: AnalyticsClientContextV1;
	puzzleSource: AnalyticsPuzzleSource;
	apiOrigin?: 'system' | 'player_uploaded';
	pieceCount: number;
	imageWidth: number;
	imageHeight: number;
	sessionMode: AnalyticsSessionMode;
	resultClass: ResultClass;
	sessionOrigin: AnalyticsSessionOrigin;
	rotationEnabled: boolean;
	placedPieceCount: number;
	assistanceMode: AnalyticsAssistanceMode;
}): AnalyticsPuzzleContextV1 | null;
```

**Locked rules:** Piece-count buckets are `1–24`, `25–49`, `50–99`, `100–149`, `150–225`, and `226+`; viewport is `<768` mobile, `768–1023` tablet, and `>=1024` desktop; progress uses exact `0`/`100` plus four quarter buckets; equal dimensions are square; auth loading returns null; local content is `player_uploaded`; API origin defaults to `unknown`.

- [ ] Write boundary-focused failing tests.
- [ ] Run `bunx vitest --run --browser src/lib/services/analytics/context.test.ts` and verify failure.
- [ ] Implement pure classifiers and allowlisted context projection.
- [ ] Run the focused test and `bun run check`.
- [ ] Commit with `feat(web): add analytics context projection`.

---

## Task 3: Add the Versioned Once-Per-Run Ledger

**Files:**

- Create: `apps/web/src/lib/services/analytics/run-ledger.ts`
- Create: `apps/web/src/lib/services/analytics/run-ledger.test.ts`

**Interfaces produced:**

```ts
export const ANALYTICS_RUN_LEDGER_KEY = 'perseus-analytics-run-ledger';
export const ANALYTICS_RUN_LEDGER_SCHEMA_VERSION = 1;
export const ANALYTICS_RUN_LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const ANALYTICS_RUN_LEDGER_MAX_ENTRIES = 200;

export interface AnalyticsRunLedgerEntryV1 {
	eventSchemaVersion: 1;
	eventName: AnalyticsOncePerRunEventInputV1['eventName'];
	runId: string;
	recordedAt: number;
}

export interface AnalyticsRunLedgerV1 {
	schemaVersion: 1;
	entries: AnalyticsRunLedgerEntryV1[];
}

export type AnalyticsLedgerMarkResult =
	| 'recorded'
	| 'duplicate'
	| 'storage_unavailable'
	| 'incompatible_schema';

export interface AnalyticsRunLedger {
	markIfNew(input: AnalyticsRunLedgerEntryV1): AnalyticsLedgerMarkResult;
}

export function createAnalyticsRunLedger(options?: {
	storage?: Storage;
	onError?: (code: 'read_error' | 'write_error' | 'remove_error' | 'invalid_record') => void;
}): AnalyticsRunLedger;
```

- [ ] Write failing tests for first mark, reload duplicate, distinct events/runs, 90-day pruning, the 200-entry cap, exact validation, corrupt-record reset, future-schema preservation, and read/write exceptions.
- [ ] Run the focused browser test and verify failure.
- [ ] Implement latest-read marking, deterministic key comparison, pruning, and fail-closed behavior.
- [ ] Run focused tests.
- [ ] Commit with `feat(web): add analytics run ledger`.

The ledger remains synchronous. Cross-tab races are defensively deduplicated downstream through deterministic event IDs; this ticket does not introduce Web Locks into the tracking API.

---

## Task 4: Add Provider-Independent Transports

**Files:**

- Create: `apps/web/src/lib/services/analytics/transport.ts`
- Create: `apps/web/src/lib/services/analytics/transports/http.ts`
- Create: `apps/web/src/lib/services/analytics/transports/memory.ts`
- Create: `apps/web/src/lib/services/analytics/transports/noop.ts`
- Create: `apps/web/src/lib/services/analytics/transport.test.ts`

**Interfaces produced:**

```ts
export interface AnalyticsTransport {
	send(batch: AnalyticsBatchV1): Promise<void>;
	sendOnPageHide?(batch: AnalyticsBatchV1): boolean;
}

export function createHttpAnalyticsTransport(options?: {
	endpoint?: string;
	fetchFn?: typeof fetch;
	sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}): AnalyticsTransport;

export interface MemoryAnalyticsTransport extends AnalyticsTransport {
	getEvents(): readonly AnalyticsEventV1[];
	reset(): void;
	failNextSend(error?: Error): void;
}

export function createMemoryAnalyticsTransport(): MemoryAnalyticsTransport;
export function createNoopAnalyticsTransport(): AnalyticsTransport;
```

Normal HTTP sends use `POST`, JSON, `credentials: 'omit'`, and `cache: 'no-store'`. Non-2xx responses fail generically without parsing or logging response bodies. Page-hide uses an `application/json` beacon when available; the fallback starts `fetch(..., keepalive: true, credentials: 'omit')` and attaches `.catch(() => {})` so no rejection escapes teardown.

- [ ] Write failing tests for exact request shape, credentials, generic failure, beacon Blob, keepalive fallback, memory copy/reset/fail-next, and no-op silence.
- [ ] Run the focused test and verify failure.
- [ ] Implement the interface and adapters.
- [ ] Run focused tests.
- [ ] Commit with `feat(web): add analytics transports`.

---

## Task 5: Add the Bounded Delivery Queue

**Files:**

- Create: `apps/web/src/lib/services/analytics/queue.ts`
- Create: `apps/web/src/lib/services/analytics/queue.test.ts`

**Interfaces produced:**

```ts
export const ANALYTICS_QUEUE_MAX_EVENTS = 100;
export const ANALYTICS_QUEUE_FLUSH_INTERVAL_MS = 1_000;

export interface AnalyticsScheduler {
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface AnalyticsDeliveryQueue {
	enqueue(event: AnalyticsEventV1): void;
	flush(): Promise<void>;
	flushForPageHide(event: AnalyticsEventV1): boolean;
	dispose(): void;
	readonly size: number;
}

export function createAnalyticsDeliveryQueue(options: {
	transport: AnalyticsTransport;
	scheduler?: AnalyticsScheduler;
	maxEvents?: number;
	maxBatchSize?: number;
	flushIntervalMs?: number;
	onError?: (code: 'transport_error' | 'queue_overflow') => void;
}): AnalyticsDeliveryQueue;
```

- [ ] Write fake-timer tests for one scheduled timer, immediate size-20 flush, `20/20/5` draining, concurrent-flush deduplication, enqueue-during-send ordering, rejected-batch drop/stop behavior, oldest-event overflow, latest-20 page-hide behavior, and disposal.
- [ ] Run the focused test and verify failure.
- [ ] Implement queue state, batching, and bounded error reporting.
- [ ] Run focused tests.
- [ ] Commit with `feat(web): add bounded analytics queue`.

---

## Task 6: Add the Public Analytics Client Facade

**Files:**

- Create: `apps/web/src/lib/services/analytics/analytics.ts`
- Create: `apps/web/src/lib/services/analytics/analytics.test.ts`
- Create: `apps/web/src/lib/services/analytics/index.ts`

**Interfaces produced:**

```ts
export type AnalyticsClientErrorCode =
	| 'invalid_input'
	| 'invalid_event_id'
	| 'ledger_unavailable'
	| 'ledger_incompatible'
	| 'transport_error'
	| 'queue_overflow';

export interface AnalyticsClient {
	track(event: AnalyticsTransientEventInputV1): void;
	trackOncePerRun(event: AnalyticsOncePerRunEventInputV1): void;
	flushForPageHide(event: PuzzleExitedIncompleteEventInputV1): boolean;
	flush(): Promise<void>;
	dispose(): void;
}

export function createAnalyticsClient(options: {
	transport: AnalyticsTransport;
	ledger: AnalyticsRunLedger;
	now?: () => number;
	createEventId?: () => string;
	strictValidation?: boolean;
	scheduler?: AnalyticsScheduler;
	onError?: (code: AnalyticsClientErrorCode) => void;
}): AnalyticsClient;
```

Validate the raw input before metadata. Generate UUID only for gallery events and deterministic IDs for run events. Use `now()` for non-negative safe-integer timestamps. Construct a fresh allowlisted event and validate the final envelope again. Strict mode throws `TypeError`; production mode reports a bounded code and drops. Only ledger result `recorded` queues a once-per-run event.

- [ ] Write failing facade and compile-time-negative tests.
- [ ] Run the focused test and verify failure.
- [ ] Implement event materialization, ledger gating, and queue orchestration.
- [ ] Add a public barrel exporting only the client, context builders, ledger factory, transport interface, and the three transport factories. Keep queue/parser internals private.
- [ ] Run the focused test, `bun run check`, `bun run lint`, and the full web unit suite.
- [ ] Commit with `feat(web): add analytics client facade`.

---

## Task 7: Document Semantics, Privacy, and Downstream Handoff

**Files:**

- Create: `docs/analytics/event-catalog.md`
- Create: `docs/analytics/client-delivery.md`
- Create: `docs/analytics/privacy.md`

- [ ] Document every V1 event's owner, intended emission point, once/transient/page-hide classification, exact fields, ID rule, null-time rule, and prohibited interpretations.
- [ ] Document exact bucket boundaries and versioning rules: changing fields, boundaries, or enum meanings requires V2; feature events are new strict union variants; no property bag.
- [ ] Document factory ownership, the absence of an enabled singleton, ledger/queue constants, overflow/drop/failure behavior, transport usage, and the HPA-533/HPA-534 handoff.
- [ ] Record data minimization, prohibited fields, random run-ID meaning, local-ledger retention, and the production privacy-policy/consent gate. State that the engineering record is not legal advice.
- [ ] Run formatting and full verification:

```bash
bunx prettier --check packages/types/src/completion.ts \
	packages/types/src/analytics.ts packages/types/src/analytics.test.ts \
	apps/web/src/lib/services/analytics docs/analytics
bun run --cwd packages/types test:unit
bun run --cwd apps/web check
bun run --cwd apps/web lint
bun run --cwd apps/web test:unit
bun run check
bun run lint
```

HPA-532 requires no E2E run because it changes no route or application runtime wiring.

- [ ] Commit with `docs: define analytics semantics and privacy gate`.

---

## Final Self-Review Gate

- [ ] Every HPA-532 acceptance criterion maps to a task above.
- [ ] `completion.ts` and `analytics.ts` are leaf modules; neither imports the root barrel.
- [ ] Existing `@perseus/types` completion imports remain source-compatible.
- [ ] `@perseus/types` is the only source of event and dimension truth.
- [ ] No event includes puzzle/player identity or uncontrolled text.
- [ ] Runtime validators reject extra keys at every nesting level.
- [ ] Once-per-run event IDs and ledger keys are deterministic and versioned.
- [ ] Future ledger versions are preserved and never overwritten.
- [ ] Storage and transport failures cannot escape into gameplay code.
- [ ] No route or component imports analytics yet, and no request is sent automatically.
- [ ] HPA-533 can consume `AnalyticsBatchV1` and `isAnalyticsBatchV1` without importing web code.
- [ ] HPA-534 can construct one client, build contexts, and emit events without importing queue, storage, or transport internals.
- [ ] Documentation contains no `TBD` or `TODO` placeholders and no conflicting bucket definitions.

## Recommended Implementation PR Scope

Implement HPA-532 as one PR with seven commits matching the tasks above. Keep it limited to the shared contract, browser client foundation, tests, and documentation. Do not add the Worker endpoint or route instrumentation; those remain independently reviewable in HPA-533 and HPA-534.
