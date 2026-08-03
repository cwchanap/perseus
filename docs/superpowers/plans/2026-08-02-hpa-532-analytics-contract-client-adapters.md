# HPA-532 Analytics Contract and Client Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define a strict, versioned, privacy-conscious analytics event contract and a
provider-independent browser client that later tickets can connect to the Worker collector and
gallery/puzzle emission points without changing phase-one semantics.

**Architecture:** Extract the existing completion/run primitives that analytics consumes into a
focused shared module, then place the cross-runtime event envelope, bounded dimensions,
deterministic once-per-run IDs, and runtime validators in `@perseus/types`. Put pure context
projection, a bounded once-per-run ledger, configurable transports, a delivery queue, and the
public client facade under `apps/web/src/lib/services/analytics/`. HPA-532 exports factories and
interfaces only; it does not instantiate an application singleton, call analytics from routes, or
enable production collection. HPA-533 owns the Worker collector/sink and HPA-534 owns runtime
wiring and event emission.

**Tech Stack:** TypeScript 5.9, Bun, Turborepo, Vitest 4, Vitest browser mode with
Playwright/Chromium, browser `localStorage`, `fetch`, `navigator.sendBeacon`, and the repository's
existing handwritten runtime-validator conventions.

## References

- Linear: https://linear.app/cwchanap/issue/HPA-532/analytics-define-the-event-contract-and-client-adapters
- Parent: https://linear.app/cwchanap/issue/HPA-225/analytics-instrument-the-puzzle-solve-funnel-and-establish-a-baseline
- Session foundation: https://linear.app/cwchanap/issue/HPA-236/foundation-extract-puzzlesession-state-and-version-the-persisted
- Downstream collector: https://linear.app/cwchanap/issue/HPA-533/analytics-add-the-worker-collector-and-analytics-engine-sink
- Downstream instrumentation: https://linear.app/cwchanap/issue/HPA-534/analytics-instrument-the-phase-one-puzzle-solve-funnel

## Locked Contract Decisions

- Do not implement the Worker route, Analytics Engine sink, gallery/puzzle instrumentation,
  dashboard, or E2E analytics capture in this ticket.
- Product routes and components eventually import only the public analytics facade; they do not
  import HTTP transports, queue/storage internals, or provider code.
- Add no analytics vendor SDK and no runtime-validation dependency.
- The contract contains no player ID, anonymous browser ID, puzzle ID, email, display name,
  filename, puzzle name, raw search text, image URL, secret URL, access/session token, user-agent
  string, precise location, or uncontrolled free text.
- `runId` is the only cross-event correlation value for puzzle events and must pass the existing
  HPA-236 `isPuzzleRunId` validator.
- A run ID is run-scoped: it is fresh after restart/new play, stable only while resuming that same
  run, and is not a user identifier or a cross-run identity.
- Existing event meanings are immutable. Adding a field to an existing event, changing a bucket
  boundary, or changing an enum meaning requires a new event schema version.
- New events are strict typed-union variants. Never add
  `properties: Record<string, unknown>` or another generic property bag.
- Event, context, data, batch, and persisted-ledger objects use exact-key validation. Extra fields
  are invalid.
- The six once-per-run events use deterministic IDs:
  `analytics:1:<eventName>:<runId>`.
- `gallery_viewed` and `puzzle_exited_incomplete` are occurrence events and use fresh canonical
  lowercase UUID v4 event IDs.
- `puzzle_exited_incomplete` is emitted once for each browser `pagehide` callback while an active
  run qualifies. It is not ledger-gated. Multiple exits from one resumed run are allowed and are
  correlated by `runId`; dashboards treat it only as supporting evidence and reduce to distinct
  runs when needed.
- The once-per-run ledger dedup key is exactly
  `(eventSchemaVersion, eventName, runId)`.
- The ledger groups marks by `runId`, retains 90 days, and stores at most 1,000 run records,
  newest first. Each run record holds at most the six V1 once-per-run event marks. This keeps the
  retention window meaningful without a flat per-event cap expiring after only a few active days.
- A future-schema ledger is preserved and treated as read-only. Older code fails closed and
  suppresses once-per-run emission rather than overwriting or duplicating events.
- The ledger is marked before enqueue. This provides at-most-once client emission, not guaranteed
  delivery: an event may be marked and later lost through queue overflow, page termination, or
  transport failure.
- The delivery queue retains at most 100 events, sends batches of at most 20, and schedules a flush
  after 1,000 ms.
- Queue overflow drops the oldest event so recent completion and exit facts are retained.
- Browser delivery is best effort and at-most-once. A rejected batch is dropped and never retried
  automatically.
- A failed normal flush stops that flush; remaining unsent events stay queued for a later scheduled
  or manual flush.
- Completion and successfully persisted personal-best emission trigger `void analytics.flush()` so
  delivery begins immediately without delaying gameplay or navigation. Page-hide delivery sends
  the newest batch (including the exit occurrence), never blocks navigation, and remains a
  best-effort tail flush; older queued events may still be lost if the page terminates.
- Context is a snapshot captured at each event's emission time. It is not frozen at
  `puzzle_opened`; viewport, input, progress, result class, monotonic rotation use, timing quality,
  and assistance may legitimately differ between events in the same run.
- Assistance mode means:
  - `none`: no hint or reference has been used before the event.
  - `hint`: at least one hint, no reference use.
  - `reference_hold`, `reference_toggle`, or `reference_ghost`: no hint and every counted reference
    activation used exactly that one mode.
  - `mixed`: hint plus any reference, or more than one reference mode.
- The current experience can produce only `none`, `hint`, `reference_hold`, and `mixed`; HPA-222 may
  activate the toggle/ghost variants without redefining them.
- Cross-field validation follows the session engine rather than treating every reference as
  competitive assistance:
  - `sessionMode: 'relaxed'` requires `resultClass: 'relaxed'`.
  - `sessionMode: 'timed'` forbids `resultClass: 'relaxed'`.
  - On timed runs, `assistanceMode: 'hint'` or `reference_ghost` requires
    `resultClass: 'assisted_timed'`.
  - On timed runs, `resultClass: 'assisted_timed'` requires `hint`, `reference_ghost`, or `mixed`.
  - `mixed` alone does not determine result class because it may mean hold+toggle or qualifying
    hint/ghost assistance combined with another reference mode.
- API puzzle content origin defaults to `unknown` because the current web puzzle contract does not
  expose system-versus-player-uploaded ownership. Local/Quick puzzles resolve to
  `player_uploaded`. HPA-532 does not add an API ownership field.
- `personal_best_beaten` means the device-local standard best maintained by
  `apps/web/src/lib/services/stats.ts`. It may fire for anonymous or authenticated players only
  when the active run is `standard_timed`, timing quality is `known`, elapsed time is non-null, and
  `recordLocalCompletion` returns `status: 'recorded'` with `isNewStandardBest: true`. It never uses
  a server/profile best, never fires for replayed or failed writes, and never fires for a stale run.
- `first_piece_placed.openToPlacementMs` uses integer milliseconds in
  `0..MAX_COMPLETION_TIME_SECONDS * 1000`. Completion/personal-best active time uses whole seconds;
  completion time is validated against `timingQuality` using the existing completion contract.
  Incomplete-exit active time is `null` or an integer in `0..MAX_COMPLETION_TIME_SECONDS`.
  `hintsUsed` and `referenceActivations` are integers in `0..10_000`; incomplete-exit
  `placedPieceCount` is an integer in `0..MAX_PIECES`, and the context builder also requires it not
  to exceed the actual puzzle piece count. The catalog must call out all units and limits.
- `puzzle_completed` does not carry `placedPieceCount`; successful completion already guarantees a
  full board and its validator requires context `progressBucket: '100'`.
- Analytics context uses monotonic `rotationUsed`, not the current rotation toggle. A timed
  `rotation_timed` result requires `rotationUsed: true`; `rotationUsed: false` forbids
  `rotation_timed`. `rotationUsed: true` may coexist with `assisted_timed` because qualifying
  assistance has result-class precedence.
- `reference_used.data.referenceMode` records the first counted activation mode (`hold`, `toggle`,
  or `ghost`). Completion/exit `assistanceMode` remains the cumulative run-level interpretation;
  dashboards do not infer full mode-mix rates from `reference_used` alone.
- HTTP endpoint selection is configurable. Production normally uses same-origin
  `/api/analytics/events`; local development may use a cross-origin API base and therefore relies
  on the existing CORS configuration. Beacon reliability is treated as production same-origin
  first; local cross-origin page-hide delivery is diagnostic and best effort.
- Declared puzzle aspect (`square`/`landscape`/`portrait`) takes precedence when present; pixel
  width/height classification is the fallback.
- Environment and release are trusted server-derived fields owned by HPA-533; clients must not add
  user-agent, environment, release, or deployment strings to events.
- `strictValidation` is required when constructing the client. Tests/development pass `true`;
  production passes `false` so invalid analytics input is dropped without affecting product
  behavior.
- HPA-532 exports no automatically enabled network client. HPA-534 constructs the application
  client after HPA-533 provides the endpoint. Until the privacy-policy/consent gate is satisfied,
  HPA-534 must select the no-op transport; HTTP transport construction is explicit opt-in.
- HPA-533 must preserve `eventId` losslessly in the sink mapping and mapping tests. Duplicate rows
  may exist; HPA-535 queries must deduplicate by `eventId` (for example `COUNT(DISTINCT eventId)`).
- Tabs for indentation, single quotes, no trailing commas, and 100-character line width.
- Every behavior change starts with a focused failing test and ends with an independently
  reviewable commit.

---

## File Structure

### Shared contract

| File | Responsibility |
| --- | --- |
| `packages/types/src/completion.ts` | Existing result-class, timing-quality, completion request, run-ID, and completion validators extracted from the root barrel to avoid circular imports |
| `packages/types/src/puzzle-limits.ts` | Existing `MAX_PIECES` leaf export used by analytics validation without importing the root barrel |
| `packages/types/src/analytics.ts` | V1 inputs/envelopes, numeric/cross-field invariants, bounded dimensions, ID rules, exact validators, and batch contract |
| `packages/types/src/analytics.test.ts` | Event matrix, strict-key/PII rejection, IDs, versions, batches, and compile-time negative tests |
| `packages/types/src/index.ts` | Re-export completion and analytics modules while preserving current package imports |
| `packages/types/src/index.test.ts` | Unchanged regression suite proving the extraction preserves existing completion behavior |

### Web client

| File | Responsibility |
| --- | --- |
| `apps/web/src/lib/services/analytics/context.ts` | Pure bounded context projection and bucket classifiers |
| `apps/web/src/lib/services/analytics/context.test.ts` | Piece-count, declared/pixel aspect, viewport, progress, input, auth, content-origin, rotation, timing, and assistance boundaries |
| `apps/web/src/lib/services/analytics/run-ledger.ts` | Versioned grouped-by-run localStorage ledger and once-per-run mark/prune policy |
| `apps/web/src/lib/services/analytics/run-ledger.test.ts` | Reload idempotency, grouped-run capacity, key tuple, retention, corruption, future schemas, and storage failures |
| `apps/web/src/lib/services/analytics/transport.ts` | Provider-independent transport interface |
| `apps/web/src/lib/services/analytics/transports/http.ts` | Configurable JSON batch transport plus page-hide beacon/keepalive path |
| `apps/web/src/lib/services/analytics/transports/memory.ts` | Deterministic capture/reset/fail-next transport for tests |
| `apps/web/src/lib/services/analytics/transports/noop.ts` | Disabled transport with no network activity |
| `apps/web/src/lib/services/analytics/transport.test.ts` | HTTP shape/privacy, endpoint override, page-hide, memory, and no-op behavior |
| `apps/web/src/lib/services/analytics/queue.ts` | Bounded queue, timers, batching, concurrency, overflow, and failure isolation |
| `apps/web/src/lib/services/analytics/queue.test.ts` | Fake-timer batching, overflow, failure, concurrency, and page-hide coverage |
| `apps/web/src/lib/services/analytics/analytics.ts` | Event materialization, validation, ledger gating, queue orchestration, and public facade |
| `apps/web/src/lib/services/analytics/analytics.test.ts` | Sequencing, IDs/timestamps, duplicate suppression, occurrence events, invalid input, and transport failures |
| `apps/web/src/lib/services/analytics/index.ts` | Stable public exports for later product code |

### Documentation

| File | Responsibility |
| --- | --- |
| `docs/analytics/event-catalog.md` | Exact event semantics, fields, units, dimensions, buckets, versioning, and extension rules |
| `docs/analytics/client-delivery.md` | Factory ownership, ledger mark-versus-delivery semantics, queue, transports, and HPA-533/HPA-534 handoff |
| `docs/analytics/privacy.md` | Data minimization, prohibited fields, run-ID scope, local ledger, and the production privacy/consent gate |

No package dependency or lockfile change is expected.

---

## Public Contract

```ts
export const ANALYTICS_EVENT_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_BATCH_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_MAX_BATCH_SIZE = 20;
export const ANALYTICS_MAX_OPEN_TO_PLACEMENT_MS = MAX_COMPLETION_TIME_SECONDS * 1000;
export const ANALYTICS_MAX_COUNTER = 10_000;

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
	timingQuality: TimingQuality;
	sessionOrigin: AnalyticsSessionOrigin;
	rotationUsed: boolean;
	progressBucket: AnalyticsProgressBucket;
	assistanceMode: AnalyticsAssistanceMode;
}
```

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
			data: { referenceMode: 'hold' | 'toggle' | 'ghost' };
	  }
	| {
			eventName: 'puzzle_completed';
			runId: string;
			context: AnalyticsPuzzleContextV1;
			data: {
				elapsedActiveSeconds: number | null;
				hintsUsed: number;
				referenceActivations: number;
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
			data: {
				elapsedActiveSeconds: number | null;
				placedPieceCount: number;
			};
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

Event classes:

```ts
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

export type AnalyticsTrackedOccurrenceEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{ eventName: 'gallery_viewed' }
>;

export type PuzzleExitedIncompleteEventInputV1 = Extract<
	AnalyticsEventInputV1,
	{ eventName: 'puzzle_exited_incomplete' }
>;
```

ID rules:

```ts
export type AnalyticsDeterministicRunEventNameV1 =
	AnalyticsOncePerRunEventInputV1['eventName'];

export function buildAnalyticsRunEventIdV1(
	eventName: AnalyticsDeterministicRunEventNameV1,
	runId: string
): string;
```

Validators require a canonical UUID v4 ID for `gallery_viewed` and
`puzzle_exited_incomplete`, and require the deterministic ID for each once-per-run event.

---

### Task 1: Extract Shared Completion Primitives and Add the V1 Analytics Contract

**Files:**

- Create: `packages/types/src/completion.ts`
- Create: `packages/types/src/puzzle-limits.ts`
- Create: `packages/types/src/analytics.ts`
- Create: `packages/types/src/analytics.test.ts`
- Modify: `packages/types/src/index.ts`
- Run unchanged regression suite: `packages/types/src/index.test.ts`

**Interfaces produced:**

```ts
export {
	RESULT_CLASSES,
	TIMING_QUALITIES,
	MAX_COMPLETION_TIME_SECONDS,
	MAX_PIECES,
	isPuzzleRunId,
	isRecordPuzzleCompletionV1
};
export type {
	ResultClass,
	TimingQuality,
	RecordPuzzleCompletionV1
};
```

```ts
export function buildAnalyticsRunEventIdV1(
	eventName: AnalyticsDeterministicRunEventNameV1,
	runId: string
): string;
export function isAnalyticsEventInputV1(value: unknown): value is AnalyticsEventInputV1;
export function isAnalyticsEventV1(value: unknown): value is AnalyticsEventV1;
export function isAnalyticsBatchV1(value: unknown): value is AnalyticsBatchV1;
```

- [ ] **Step 1: Write failing analytics contract tests**

Create valid fixtures for all eight events. Add rejection cases for unknown events, versions,
missing/extra root/context/data keys, prohibited identity/text fields, invalid enums, bad run IDs,
invalid numeric ranges, mode/result/timing/assistance/rotation cross-field mismatches,
deterministic-ID mismatches, non-canonical UUIDs, missing `referenceMode`, completion
`placedPieceCount`, completion progress other than `100`, and batches outside `1..20`. Add `@ts-expect-error` cases for arbitrary events,
free-form properties, and PII fields.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
cd packages/types
bunx vitest run src/analytics.test.ts
```

Expected: FAIL because the analytics contract does not exist.

- [ ] **Step 3: Extract completion/run primitives without behavior changes**

Move the existing completion symbols from `index.ts` into `completion.ts` and `MAX_PIECES` into
`puzzle-limits.ts`. Re-export them from `index.ts`. Do not alter regexes, result eligibility,
elapsed-time validation, puzzle limits, or exported names.

```bash
cd packages/types
bunx vitest run src/index.test.ts
```

Expected: PASS.

- [ ] **Step 4: Implement constants, unions, ID rules, and exact validators**

Use explicit exact-key helpers and an event-name switch. Import completion primitives from
`./completion` and `MAX_PIECES` from `./puzzle-limits`, never from the root barrel. UUID occurrence
events validate canonical lowercase UUID v4 IDs. Once-per-run events validate:

```ts
event.eventId === buildAnalyticsRunEventIdV1(event.eventName, event.runId)
```

- [ ] **Step 5: Run focused and package tests**

```bash
cd packages/types
bunx vitest run src/index.test.ts src/analytics.test.ts
bun run test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/completion.ts packages/types/src/puzzle-limits.ts \
	packages/types/src/analytics.ts packages/types/src/analytics.test.ts packages/types/src/index.ts
git commit -m 'feat(types): add analytics event contract'
```

`index.test.ts` is intentionally not staged unless implementation changes it.

---

### Task 2: Add Pure Context Projection and Bucket Rules

**Files:**

- Create: `apps/web/src/lib/services/analytics/context.ts`
- Create: `apps/web/src/lib/services/analytics/context.test.ts`

**Interfaces:**

```ts
export interface PrimaryInputSnapshot {
	lastInteraction: 'keyboard' | 'pointer' | null;
	pointerType?: 'mouse' | 'pen' | 'touch' | '';
	coarsePointer: boolean | null;
}

export interface AssistanceUsageSnapshot {
	hintUsed: boolean;
	referenceModesUsed: readonly ('hold' | 'toggle' | 'ghost')[];
}

export function classifyPieceCountBucket(pieceCount: number): AnalyticsPieceCountBucket | null;
export function classifyAspectBucket(input: {
	declaredAspect?: AnalyticsAspectBucket;
	width: number;
	height: number;
}): AnalyticsAspectBucket | null;
export function classifyViewportClass(width: number): AnalyticsViewportClass | null;
export function classifyProgressBucket(
	placedPieceCount: number,
	pieceCount: number
): AnalyticsProgressBucket | null;
export function classifyPrimaryInput(snapshot: PrimaryInputSnapshot): AnalyticsPrimaryInput;
export function classifyAssistanceMode(
	snapshot: AssistanceUsageSnapshot
): AnalyticsAssistanceMode;
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
	declaredAspect?: AnalyticsAspectBucket;
	pieceCount: number;
	imageWidth: number;
	imageHeight: number;
	sessionMode: AnalyticsSessionMode;
	resultClass: ResultClass;
	timingQuality: TimingQuality;
	sessionOrigin: AnalyticsSessionOrigin;
	rotationUsed: boolean;
	placedPieceCount: number;
	assistance: AssistanceUsageSnapshot;
}): AnalyticsPuzzleContextV1 | null;
```

**Rules:**

- Piece count: `1–24`, `25–49`, `50–99`, `100–149`, `150–225`, `226+`.
- Viewport: `<768` mobile, `768–1023` tablet, `>=1024` desktop.
- Progress: exact `0`/`100` plus four quarter buckets.
- A valid declared aspect is authoritative; otherwise equal image dimensions are square and
  positive width/height determine landscape/portrait.
- Auth loading returns null.
- Local content is player-uploaded.
- API content is unknown unless an explicit bounded origin is supplied.
- Context builders snapshot values at call time, use monotonic `rotationUsed`, carry bounded
  `timingQuality`, and reject placed counts above the actual piece count.
- Assistance follows the locked `none`/`hint`/single-reference/`mixed` rules.

- [ ] **Step 1: Write boundary-focused failing tests**
- [ ] **Step 2: Run the focused browser test and verify failure**
- [ ] **Step 3: Implement pure classifiers and allowlisted projections**
- [ ] **Step 4: Run the focused test and `bun run check`**
- [ ] **Step 5: Commit with `feat(web): add analytics context projection`**

---

### Task 3: Add the Versioned Once-Per-Run Ledger

**Files:**

- Create: `apps/web/src/lib/services/analytics/run-ledger.ts`
- Create: `apps/web/src/lib/services/analytics/run-ledger.test.ts`

**Interfaces:**

```ts
export const ANALYTICS_RUN_LEDGER_KEY = 'perseus-analytics-run-ledger';
export const ANALYTICS_RUN_LEDGER_SCHEMA_VERSION = 1;
export const ANALYTICS_RUN_LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const ANALYTICS_RUN_LEDGER_MAX_RUNS = 1_000;
export const ANALYTICS_RUN_LEDGER_MAX_EVENTS_PER_RUN = 6;

export interface AnalyticsRunLedgerEventV1 {
	eventSchemaVersion: 1;
	eventName: AnalyticsOncePerRunEventInputV1['eventName'];
	recordedAt: number;
}

export interface AnalyticsRunLedgerRecordV1 {
	runId: string;
	lastRecordedAt: number;
	events: AnalyticsRunLedgerEventV1[];
}

export interface AnalyticsRunLedgerV1 {
	schemaVersion: 1;
	runs: AnalyticsRunLedgerRecordV1[];
}

export interface AnalyticsRunLedgerMarkInputV1 {
	eventSchemaVersion: 1;
	eventName: AnalyticsOncePerRunEventInputV1['eventName'];
	runId: string;
	recordedAt: number;
}

export type AnalyticsLedgerMarkResult =
	| 'recorded'
	| 'duplicate'
	| 'storage_unavailable'
	| 'incompatible_schema';

export interface AnalyticsRunLedger {
	markIfNew(input: AnalyticsRunLedgerMarkInputV1): AnalyticsLedgerMarkResult;
}
```

- [ ] **Step 1: Write failing tests**

Cover first mark, reload duplicate, all three key components, different events/runs, grouped
records with all six V1 marks, 90-day pruning, 1,000-run cap, per-run six-event cap, exact
validation, corrupt reset, future-schema preservation, and read/write exceptions.

- [ ] **Step 2: Run the focused browser test and verify failure**
- [ ] **Step 3: Implement latest-read grouped-run marking, tuple comparison, pruning, and
fail-closed behavior**
- [ ] **Step 4: Run focused tests**
- [ ] **Step 5: Commit with `feat(web): add analytics run ledger`**

The ledger is synchronous and marks before enqueue. Grouping by run keeps up to 6,000 V1 marks
within 1,000 bounded records. Cross-tab races and cap/prune re-emission remain defensively
deduplicable downstream through deterministic once-per-run event IDs; HPA-533 must preserve those
IDs and HPA-535 must deduplicate them in queries.

---

### Task 4: Add Provider-Independent HTTP, Memory, and No-Op Transports

**Files:**

- Create: `apps/web/src/lib/services/analytics/transport.ts`
- Create: `apps/web/src/lib/services/analytics/transports/http.ts`
- Create: `apps/web/src/lib/services/analytics/transports/memory.ts`
- Create: `apps/web/src/lib/services/analytics/transports/noop.ts`
- Create: `apps/web/src/lib/services/analytics/transport.test.ts`

**Interfaces:**

```ts
export interface AnalyticsTransport {
	send(batch: AnalyticsBatchV1): Promise<void>;
	sendOnPageHide?(batch: AnalyticsBatchV1): boolean;
}

export function createHttpAnalyticsTransport(options: {
	endpoint: string;
	fetchFn?: typeof fetch;
	sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}): AnalyticsTransport;
```

Normal HTTP sends use `POST`, JSON, `credentials: 'omit'`, and `cache: 'no-store'`. Non-2xx
responses fail generically without parsing/logging bodies. Page-hide uses an `application/json`
beacon when available; fallback starts `fetch(..., keepalive: true, credentials: 'omit')` and
attaches `.catch(() => {})`. The no-op transport is the required default until HPA-534's
privacy-policy/consent gate explicitly permits HTTP transport construction.

- [ ] **Step 1: Write failing tests**

Cover endpoint overrides, same-origin and cross-origin URLs, exact request shape, omitted
credentials, non-2xx failure, beacon Blob, keepalive fallback, memory copy/reset/fail-next, and
no-op silence, and production-same-origin versus local-cross-origin page-hide behavior.

- [ ] **Step 2: Run the focused test and verify failure**
- [ ] **Step 3: Implement the interface and adapters**
- [ ] **Step 4: Run focused tests**
- [ ] **Step 5: Commit with `feat(web): add analytics transports`**

---

### Task 5: Add the Bounded Delivery Queue

**Files:**

- Create: `apps/web/src/lib/services/analytics/queue.ts`
- Create: `apps/web/src/lib/services/analytics/queue.test.ts`

**Interfaces:**

```ts
export const ANALYTICS_QUEUE_MAX_EVENTS = 100;
export const ANALYTICS_QUEUE_FLUSH_INTERVAL_MS = 1_000;

export interface AnalyticsDeliveryQueue {
	enqueue(event: AnalyticsEventV1): void;
	flush(): Promise<void>;
	flushForPageHide(event: AnalyticsEventV1): boolean;
	dispose(): void;
	readonly size: number;
}
```

- [ ] **Step 1: Write fake-timer tests**

Cover one scheduled timer, immediate size-20 flush, `20/20/5` draining, concurrent flush
deduplication, enqueue-during-send ordering, rejected-batch drop/stop behavior, oldest-event
overflow, latest-20 page-hide behavior, completion/PB-triggered non-blocking normal flush, and
disposal.

- [ ] **Step 2: Run the focused test and verify failure**
- [ ] **Step 3: Implement queue state, batching, and bounded error reporting**
- [ ] **Step 4: Run focused tests**
- [ ] **Step 5: Commit with `feat(web): add bounded analytics queue`**

---

### Task 6: Add the Public Analytics Client Facade

**Files:**

- Create: `apps/web/src/lib/services/analytics/analytics.ts`
- Create: `apps/web/src/lib/services/analytics/analytics.test.ts`
- Create: `apps/web/src/lib/services/analytics/index.ts`

**Interfaces:**

```ts
export type AnalyticsClientErrorCode =
	| 'invalid_input'
	| 'invalid_event_id'
	| 'ledger_storage_unavailable'
	| 'ledger_incompatible_schema'
	| 'transport_failed'
	| 'queue_overflow';

export interface AnalyticsClient {
	track(event: AnalyticsTrackedOccurrenceEventInputV1): void;
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
	strictValidation: boolean;
	scheduler?: AnalyticsScheduler;
	onError?: (code: AnalyticsClientErrorCode) => void;
}): AnalyticsClient;
```

Behavior:

- Validate raw input before adding metadata.
- Generate fresh UUIDs for gallery and exit occurrence events.
- Generate deterministic IDs only for once-per-run events.
- Use `now()` for non-negative safe-integer timestamps.
- Construct a fresh allowlisted envelope and validate it again.
- Strict mode throws `TypeError`; non-strict mode reports a bounded error and drops.
- Only ledger result `recorded` queues a once-per-run event.
- Ledger marking is not a delivery acknowledgment.
- `flushForPageHide` creates one occurrence event per method call; HPA-534 calls it once from each
  pagehide handler invocation.
- After `puzzle_completed` and a successfully persisted `personal_best_beaten` are tracked,
  HPA-534 immediately starts `void analytics.flush()`; it never awaits analytics before updating
  UI, recording completion, or navigating.
- Disabled/unapproved environments construct the client with the no-op transport. The facade does
  not carry a second `enabled` flag.

- [ ] **Step 1: Write failing facade and compile-time-negative tests, including the closed error
  code union and occurrence/once-per-run ID rules**
- [ ] **Step 2: Run the focused test and verify failure**
- [ ] **Step 3: Implement event materialization, ledger gating, and queue orchestration**
- [ ] **Step 4: Add a public barrel with client/context/ledger/transport factories only**
- [ ] **Step 5: Run focused tests, check, lint, and full web unit tests**
- [ ] **Step 6: Commit with `feat(web): add analytics client facade`**

---

### Task 7: Document Semantics, Privacy, and Downstream Handoff

**Files:**

- Create: `docs/analytics/event-catalog.md`
- Create: `docs/analytics/client-delivery.md`
- Create: `docs/analytics/privacy.md`

- [ ] **Step 1: Document every V1 event**

Include owner, emission intent, once-per-run versus occurrence classification, exact fields, ID
rule, time unit, null-time rule, context-at-emission behavior, and prohibited interpretations.

- [ ] **Step 2: Document versioning and dimensions**

Include exact bucket boundaries, declared-aspect precedence, timing/numeric limits, cross-field
invariants, rotation-used semantics, assistance-mode derivation, `reference_used.referenceMode`,
API-origin fallback, and the rule that changed fields/boundaries/enum meanings require V2.

- [ ] **Step 3: Document delivery**

State that ledger mark happens before enqueue and does not guarantee delivery. Document queue
constants, overflow/drop/failure behavior, configurable endpoint selection, production
same-origin/default and local cross-origin/CORS behavior, non-blocking completion/PB flushes,
lossless downstream `eventId` preservation/query deduplication, and HPA-533/HPA-534 ownership.

- [ ] **Step 4: Document privacy**

Record data minimization, excluded fields, run-ID run scope, local ledger retention, and the
production privacy-policy/consent gate and mandatory no-op transport before approval. State that
this engineering record is not legal advice.

- [ ] **Step 5: Run formatting and verification**

```bash
bunx prettier --check packages/types/src/completion.ts packages/types/src/puzzle-limits.ts \
	packages/types/src/analytics.ts packages/types/src/analytics.test.ts \
	apps/web/src/lib/services/analytics docs/analytics
bun run --cwd packages/types test:unit
bun run --cwd apps/web check
bun run --cwd apps/web lint
bun run --cwd apps/web test:unit
bun run check
bun run lint
```

HPA-532 requires no E2E run because no route or application-runtime wiring changes.

- [ ] **Step 6: Commit with `docs: define analytics semantics and privacy gate`**

---

## Final Self-Review Gate

- [ ] Every HPA-532 acceptance criterion maps to a task above.
- [ ] `completion.ts`, `puzzle-limits.ts`, and `analytics.ts` are leaf modules; none imports the root
  barrel.
- [ ] Existing `@perseus/types` completion imports remain source-compatible.
- [ ] No event includes puzzle/player identity or uncontrolled text.
- [ ] Runtime validators reject extra keys at every nesting level.
- [ ] Once-per-run IDs and ledger keys are deterministic and versioned.
- [ ] The grouped ledger retains 90 days and up to 1,000 runs / six V1 marks per run.
- [ ] Gallery and incomplete-exit occurrence events use fresh canonical UUIDs.
- [ ] Exit is explicitly per-pagehide occurrence and not an exact abandonment measure.
- [ ] Ledger marking is documented as at-most-once emission, not delivery acknowledgment.
- [ ] Future ledger versions are preserved and never overwritten.
- [ ] API puzzle content origin safely defaults to `unknown`.
- [ ] Personal-best semantics match device-local `recordLocalCompletion`.
- [ ] Context is documented as an event-time snapshot.
- [ ] Mode/result/timing/assistance/rotation cross-field invariants and numeric limits are explicit.
- [ ] Assistance `mixed` semantics, `referenceMode`, declared-aspect precedence, and time units are
  explicit.
- [ ] Completion data contains no redundant `placedPieceCount`.
- [ ] Client construction requires an explicit `strictValidation` choice.
- [ ] HTTP endpoint configuration supports production same-origin and local cross-origin use.
- [ ] Pre-consent wiring uses the no-op transport and completion/PB flushes remain non-blocking.
- [ ] HPA-533 preserves `eventId` losslessly and HPA-535 deduplicates it in queries.
- [ ] Storage and transport failures cannot escape into gameplay code.
- [ ] No route/component imports analytics yet and no request is sent automatically.
- [ ] HPA-533 can consume `AnalyticsBatchV1` and `isAnalyticsBatchV1` without web imports and map
  `timingQuality`, `rotationUsed`, and `eventId` without semantic drift.
- [ ] HPA-534 can construct one client and emit events without queue/storage internals.
- [ ] Documentation contains no incomplete placeholders or conflicting definitions.

## Recommended PR Scope

One implementation PR with seven commits matching the tasks above. Keep it limited to the shared
contract, browser client foundation, tests, and documentation. Do not opportunistically add the
Worker endpoint or route instrumentation; those belong to HPA-533 and HPA-534.
