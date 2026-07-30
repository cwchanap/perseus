# HPA-372 PuzzleSession and Client Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After HPA-371 is deployed, extract the puzzle route's run state into a pure,
framework-independent `PuzzleSession`, migrate device-local progress/stat records to versioned
schemas, submit immutable sealed completion facts to the v1 API, and preserve the current
gameplay experience.

**Architecture:** Put the domain contract, transition engine, versioned persistence codec, and
thin Svelte readable wrapper under `apps/web/src/lib/services/gameplay/session/`. The route
loads puzzle/source context, adapts DOM input to typed actions, handles transient presentation,
and executes typed local/server effects. The engine owns lifecycle, one injected clock,
placements, tray order, rotation/history, assistance facts, completion sealing, and effect
state. Persist only an allowlisted linear projection to the existing progress key.

**Tech Stack:** TypeScript, Svelte 5, Svelte stores, SvelteKit, Vitest browser mode, Playwright,
Web Crypto random bytes, `@noble/hashes`, Bun, HPA-371 shared completion types

## Global Constraints

- Approved design baseline:
  `docs/superpowers/specs/2026-07-25-puzzle-session-foundation-design.md`.
- Linear delivery issue:
  `https://linear.app/cwchanap/issue/HPA-372/foundation-extract-puzzlesession-and-migrate-client-persistence`.
- This plan is blocked until the HPA-371 server contract and additive migration are deployed.
- The HPA-371 deployment gate includes the deletion-fence/quota corrective plan. Do not enable
  this plan's v1 caller until HPA-371 returns typed tombstone 404 and quota 429 outcomes.
- Import `ResultClass`, `TimingQuality`, `RecordPuzzleCompletionV1`, response types, and run-ID
  validation from `@perseus/types`; do not fork a client-only copy.
- Classify `completion_quota_exceeded` and a deleted-puzzle `not_found` as terminal and
  non-retryable. Neither hydration nor manual background retry may resubmit them indefinitely.
- Preserve the current puzzle route's visible behavior. HPA-372 adds no setup screen, pause
  button, new toolbar, mobile tray, staging UI, or completion-report redesign.
- The pure engine imports no Svelte, DOM, local storage, fetch client, or analytics provider.
- Use one injected clock/scheduler for engine time and timer presentation. Remove the route's
  independent timer from the gameplay path.
- Live known time may display `00:00`; clamp to at least one second only in the sealed
  completion/request.
- Legacy progress remains `legacy_unknown` and untimed for the rest of that run. Do not start a
  partial timer after migration.
- A completion seal is immutable and once per run. Undo/redo/re-completion never creates a
  second seal or changes request facts.
- Active reference mode, selection, history, DOM state, hint highlight, rejection animation,
  modal state, and clock handles are never serialized.
- Enabling rotation immediately makes the run rotation-timed and sets monotonic
  `rotationUsed`, even if disabled before any placement. Rotation toggle does not start time.
- `isResumable` is exported for future HPA-218 consumers, but this ticket adds no current
  gallery/Continue Mission consumer.
- Keep the existing `puzzle-progress-${puzzleId}` and `puzzle-stats-${puzzleId}` storage keys.
- Tabs for indentation, single quotes, no trailing commas, 100-character line width.
- Use `rtk` for shell commands. Use `apply_patch` for edits.
- Every behavior change begins with a focused failing test and ends with a commit.

---

## File Structure

### New production files

| File                                                        | Responsibility                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/web/src/lib/services/gameplay/session/types.ts`       | Runtime/persisted state, actions, outcomes, events, clock/factory/adapter contracts    |
| `apps/web/src/lib/services/gameplay/session/session.ts`     | Pure transition engine, clock ownership, history, invariants, completion sealing       |
| `apps/web/src/lib/services/gameplay/session/persistence.ts` | Schema v1 codec, legacy migration, canonical JSON/SHA-256, validation, storage adapter |
| `apps/web/src/lib/services/gameplay/session/store.ts`       | Thin Svelte `Readable` wrapper around one engine instance                              |

### New tests

| File                                                             | Responsibility                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/web/src/lib/services/gameplay/session/session.test.ts`     | Lifecycle, clock, gameplay, history, result class, seal/effect matrices           |
| `apps/web/src/lib/services/gameplay/session/persistence.test.ts` | ID generation, v1 codec, deterministic v0 migration, validation, storage failures |
| `apps/web/src/lib/services/gameplay/session/store.test.ts`       | Svelte subscription/dispatch/disposal behavior                                    |

### Main modified files

| File                                                               | Change                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `apps/web/package.json`                                            | Add `@noble/hashes`                                                       |
| `bun.lock`                                                         | Lock the new browser-compatible hash dependency                           |
| `apps/web/src/lib/services/stats.ts`                               | Local stats schema v1, migration, run-id idempotency                      |
| `apps/web/src/lib/services/__tests__/stats.test.ts`                | Local stats class/best/idempotency matrix                                 |
| `apps/web/src/lib/services/__tests__/stats-errors.test.ts`         | Read/write failure behavior                                               |
| `apps/web/src/lib/services/api.ts`                                 | Submit `RecordPuzzleCompletionV1` and preserve structured API error codes |
| `apps/web/src/lib/services/__tests__/api.test.ts`                  | V1 body and response/transport behavior                                   |
| `apps/web/src/lib/types/puzzle.ts`                                 | Remove obsolete unversioned progress type after route migration           |
| `apps/web/src/lib/components/PuzzlePiece.svelte`                   | Receive selection state/callbacks instead of global store                 |
| `apps/web/src/lib/components/PuzzleBoard.svelte`                   | Receive selection cancellation through props                              |
| `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts` | Callback selection behavior                                               |
| `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts` | Callback cancellation behavior                                            |
| `apps/web/src/routes/puzzle/[id]/+page.svelte`                     | Construct the session and adapt all current UI actions/effects            |
| `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`              | Route parity and effect/hydration regression coverage                     |
| `apps/web/e2e/puzzle-solving.spec.ts`                              | User-visible resume/action/completion regression                          |
| `apps/web/src/lib/services/progress.ts`                            | Remove compatibility service after final route cutover                    |
| `apps/web/src/lib/services/__tests__/progress.test.ts`             | Remove superseded tests after codec coverage exists                       |
| `apps/web/src/lib/services/__tests__/progress-errors.test.ts`      | Remove superseded tests after storage coverage exists                     |
| `apps/web/src/lib/stores/pieceSelection.ts`                        | Remove global selection state after component cutover                     |
| `apps/web/src/lib/stores/__tests__/pieceSelection.test.ts`         | Remove superseded global-store tests                                      |

`apps/web/src/lib/stores/timer.ts` remains for `formatTime` and the `TimerState` presentation
shape, but `createTimerStore()` is no longer constructed by the puzzle route.

---

## Task 1: Add Session Contracts, Canonical Run IDs, and the Hash Dependency

**Files:**

- Create: `apps/web/src/lib/services/gameplay/session/types.ts`
- Create: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Create: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Modify: `apps/web/package.json`
- Modify: `bun.lock`

**Core public contracts:**

```ts
export type SessionLifecycle = 'setup' | 'active' | 'paused' | 'completed' | 'disposed';
export type SessionMode = 'timed' | 'relaxed';
export type PuzzleSourceType = 'api' | 'local';
export type SessionOrigin = 'new' | 'resumed';
export type ReferenceMode = 'hold' | 'toggle' | 'ghost';
export type CompletionEffect = 'local_stats' | 'server_submission';
export type CompletionFailureCode =
	| 'storage_error'
	| 'network_error'
	| 'bad_request'
	| 'unauthorized'
	| 'not_found'
	| 'run_id_conflict'
	| 'completion_quota_exceeded'
	| 'internal_error';

export interface RunIdFactory {
	create(): string;
}

export interface Clock {
	monotonicNow(): number;
	wallNow(): number;
	setInterval(callback: () => void, milliseconds: number): unknown;
	clearInterval(handle: unknown): void;
}

export type InventoryFilter = 'all' | 'corners' | 'edges' | 'center';
export type TrayOrganizationUpdate =
	| { type: 'reorder'; trayId: string; pieceIds: number[] }
	| { type: 'set_filter'; filter: InventoryFilter }
	| { type: 'set_active_tray'; trayId: string }
	| { type: 'move_piece'; pieceId: number; toTrayId: string }
	| { type: 'rename_tray'; trayId: string; name: string }
	| { type: 'remove_tray'; trayId: string };

export type PuzzleSessionAction =
	| { type: 'start' }
	| { type: 'pause' }
	| { type: 'resume' }
	| { type: 'restart' }
	| { type: 'dispose' }
	| { type: 'select_piece'; pieceId: number }
	| { type: 'cancel_selection' }
	| { type: 'set_rotation_mode'; enabled: boolean }
	| { type: 'rotate_piece'; pieceId: number }
	| { type: 'attempt_placement'; pieceId: number; x: number; y: number }
	| { type: 'complete' }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'use_hint' }
	| { type: 'set_reference_mode'; mode: ReferenceMode | null }
	| { type: 'update_tray_organization'; update: TrayOrganizationUpdate }
	| {
			type: 'acknowledge_completion_effect';
			runId: string;
			effect: CompletionEffect;
			result:
				| { status: 'succeeded' }
				| {
						status: 'failed';
						code: CompletionFailureCode;
						retryable: boolean;
				  };
	  }
	| { type: 'retry_completion_effects' };
```

- [ ] **Step 1: Add the dependency**

Run:

```bash
rtk bun add --cwd=apps/web @noble/hashes
```

Expected: `apps/web/package.json` and `bun.lock` add the current workspace-compatible
`@noble/hashes` version.

- [ ] **Step 2: Write run-ID and canonical-JSON red tests**

In `persistence.test.ts`, cover:

- `crypto.randomUUID()` path;
- fallback path using injected deterministic `getRandomValues` bytes;
- correct version nibble `4` and variant nibble `8`–`b`;
- lowercase canonical UUID output accepted by `isPuzzleRunId`;
- canonical JSON recursively sorting object keys, preserving array order, omitting undefined
  object properties, and preserving the original `lastUpdated`;
- SHA-256 vectors for `''` and `'abc'`;
- legacy IDs formatted as `legacy-${64LowercaseHex}`;
- hashing works when `crypto.subtle` is absent.

Inject the crypto surface; never monkey-patch global `crypto` in production code.

- [ ] **Step 3: Run the red persistence test**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/persistence.test.ts
```

Expected: FAIL because the session types and ID helpers do not exist.

- [ ] **Step 4: Define the full bounded type surface**

In `types.ts`, define:

- lifecycle/mode/source/origin/reference types;
- placement, rotations, tray organization, counters, monotonic facts, optional viewport and
  organization fields;
- `CompletionFailureCode` and `CompletionEffectState`;
- immutable `SealedCompletion`;
- `PuzzleSessionState`, `PersistedPuzzleSessionV1`, and validation context;
- the complete action union from the approved design;
- accepted/rejected/no-op outcomes and rejection reasons;
- typed lifecycle/gameplay/completion/effect events;
- `Clock`, `RunIdFactory`, and event callback interfaces.

Import shared `ResultClass` and `TimingQuality` from `@perseus/types`.

- [ ] **Step 5: Implement synchronous ID helpers in `persistence.ts`**

Use:

```ts
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
```

Export:

```ts
export function canonicalJson(value: unknown): string;
export function legacyRunId(rawLegacyValue: unknown): string;
export function createBrowserRunIdFactory(cryptoSource?: Crypto): RunIdFactory;
```

The fallback copies 16 random bytes, sets UUID version/variant bits, and formats the canonical
8-4-4-4-12 shape. It must never use `Math.random`.

- [ ] **Step 6: Run green tests and type check**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/persistence.test.ts
rtk bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/web/package.json bun.lock apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/persistence.ts apps/web/src/lib/services/gameplay/session/persistence.test.ts
rtk git commit -m "feat(web): define PuzzleSession contracts and run IDs"
```

---

## Task 2: Implement Lifecycle and the Single Injected Clock

**Files:**

- Create: `apps/web/src/lib/services/gameplay/session/session.ts`
- Create: `apps/web/src/lib/services/gameplay/session/session.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`

**Engine boundary:**

```ts
export interface PuzzleSession {
	getState(): Readonly<PuzzleSessionState>;
	dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome;
	setDocumentHidden(hidden: boolean): void;
	checkpointTime(): void;
	dispose(): void;
}

export function createPuzzleSession(options: CreatePuzzleSessionOptions): PuzzleSession;
```

- [ ] **Step 1: Build a deterministic test clock**

In `session.test.ts`, define a local `ManualClock` that controls monotonic time, wall time, and
scheduled ticks. Do not use real sleeps.

- [ ] **Step 2: Write the lifecycle/timing red matrix**

Cover:

- fresh `setup` to `active` via `start`;
- repeat start no-op;
- active pause/resume;
- invalid pause/resume lifecycle combinations;
- `disposed` terminal behavior;
- restored active, paused, and completed lifecycle not overwritten;
- no time before a counted action;
- placement attempt starts known timed clock;
- accepted piece rotation starts known timed clock;
- rotation toggle, hint, and reference do not start it;
- explicit pause checkpoints elapsed and does not auto-resume;
- hidden document suspends without changing lifecycle;
- visibility restore resumes only an active already-started timed run;
- relaxed and legacy-unknown elapsed stays null;
- whole-second display may remain zero;
- serializer-facing state never reports `disposed` as restorable.

- [ ] **Step 3: Run the red engine test**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts
```

Expected: FAIL because `createPuzzleSession` does not exist.

- [ ] **Step 4: Implement construction and clock ownership**

Construction validates immutable puzzle metadata:

- unique numeric piece IDs;
- finite integer canonical coordinates;
- coordinates inside the grid;
- exactly one canonical target per piece.

Store runtime-only:

- last monotonic start time;
- scheduled tick handle;
- hidden/suspended fact;
- listeners/event callback;
- history container.

`checkpointTime()` computes whole active seconds from the injected monotonic clock. It only
advances `known` + `timed` + `active` + `timerStarted` sessions. Tick publication and sealing
must call the same checkpoint function.

- [ ] **Step 5: Run green engine tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts
rtk bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/session.ts apps/web/src/lib/services/gameplay/session/session.test.ts
rtk git commit -m "feat(web): implement PuzzleSession lifecycle and clock"
```

---

## Task 3: Move Selection, Placement, Rotation, and History into the Engine

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Reuse: `apps/web/src/lib/services/gameplay/history.ts`
- Reuse: `apps/web/src/lib/services/gameplay/rotation.ts`

**Placement outcome:**

```ts
export type PlacementOutcome =
	| { status: 'accepted'; completed: boolean }
	| { status: 'rejected'; reason: 'wrong_slot' | 'non_upright'; counted: true }
	| {
			status: 'noop';
			reason:
				| 'lifecycle_disallows_gameplay'
				| 'unknown_piece'
				| 'duplicate_piece'
				| 'invalid_coordinates';
	  };
```

- [ ] **Step 1: Write selection and placement red tests**

Cover:

- select known unplaced piece;
- cancel selection;
- unknown/already-placed/disallowed selection no-op;
- correct placement accepted once;
- wrong slot and non-upright rotation rejected and counted once;
- unknown piece, non-integer/out-of-bounds coordinate, duplicate, and disabled lifecycle
  rejected/no-op without increment;
- mouse/keyboard-equivalent repeated placement cannot create duplicates;
- accepted placement clears matching selection;
- final placement delegates to guarded complete;
- direct `complete` before a valid full board is a no-op.

- [ ] **Step 2: Write rotation/history red tests**

Cover:

- rotation mode can change only in active lifecycle with zero placed pieces;
- enabling creates initial rotations through injected deterministic rotation generation;
- enabling immediately sets `rotationUsed` and `rotation_timed`;
- toggle on then off never restores standard class and does not start time;
- placed/unknown pieces cannot rotate;
- accepted rotation starts time and records history;
- undo/redo restores placements, per-piece rotations, and rotation-mode state;
- undo does not restore selection, counters, `rotationUsed`, result class, or a completion seal;
- history boundaries return typed no-ops.

- [ ] **Step 3: Run the red engine tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts
```

Expected: FAIL for unimplemented actions and outcomes.

- [ ] **Step 4: Implement one invariant-preserving dispatch path**

Use `attempt_placement` as the only placement mutation. It must:

1. validate lifecycle/piece/coordinates/uniqueness/rotation;
2. start time for a real placement attempt;
3. return a bounded rejected outcome without partial mutation;
4. push history only after accepted state;
5. emit typed acceptance/rejection events;
6. call the guarded completion transition after an accepted final placement.

Reuse `createPlacementHistory` and rotation helpers internally; do not expose the mutable
history object in state.

- [ ] **Step 5: Run green engine and helper suites**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts gameplay/history.test.ts gameplay/rotation.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/web/src/lib/services/gameplay/session apps/web/src/lib/services/gameplay/history.ts apps/web/src/lib/services/gameplay/rotation.ts
rtk git commit -m "feat(web): centralize PuzzleSession gameplay transitions"
```

Do not stage unchanged helper files.

---

## Task 4: Add Assistance Facts, Reference Semantics, Activity, and Restart

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`

- [ ] **Step 1: Write the assistance/reference red tests**

Cover:

- hint increments its counter and makes timed runs `assisted_timed`;
- `null -> hold` and `null -> toggle` increment reference count but do not change result class;
- `null -> ghost` increments once and makes timed runs assisted;
- repeated same active mode/key-repeat does not increment;
- active mode change without first setting null does not double-count activation;
- setting null ends activation without increment;
- active reference mode is runtime-only;
- result class only becomes less competitive;
- relaxed remains relaxed.

- [ ] **Step 2: Write activity and organization red tests**

`hasUserActivity` becomes true for:

- counted placement attempts;
- accepted piece rotation;
- accepted rotation-mode change;
- hint or reference activation;
- valid tray-organization update.

It remains false for start, visibility, duplicate placement, malformed action, repeated
reference activation, or rejected organization update.

Test recognized organization updates preserve piece uniqueness and cannot lose/duplicate
pieces across trays.

- [ ] **Step 3: Write restart/disposal red tests**

Restart must:

- work from active, paused, and completed;
- create a new injected UUID;
- clear placements/selection/history/counters/assistance/seal;
- reset rotation state and `hasUserActivity`;
- generate a fresh canonical tray order;
- retain mode and recognized organization preferences;
- return to setup;
- no-op with `nothing_to_restart` from setup;
- no-op from disposed.

- [ ] **Step 4: Run the red engine tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Implement monotonic classification and restart**

Keep `rotationUsed` and assistance facts outside history snapshots. Expose
`set_reference_mode` exactly as the approved action with `ReferenceMode | null`. Apply
organization changes through a validating reducer, not by assigning caller objects.

- [ ] **Step 6: Run the green engine tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/session.ts apps/web/src/lib/services/gameplay/session/session.test.ts
rtk git commit -m "feat(web): track PuzzleSession eligibility and activity"
```

---

## Task 5: Seal Completion Once and Coordinate Typed Effects

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.test.ts`

**Seal:**

```ts
export type CompletionEffectState =
	| { status: 'pending' }
	| { status: 'succeeded' }
	| { status: 'failed'; code: CompletionFailureCode; retryable: boolean }
	| { status: 'not_applicable' };

export interface SealedCompletion {
	readonly runId: string;
	readonly resultClass: ResultClass;
	readonly timingQuality: TimingQuality;
	readonly elapsedActiveSeconds: number | null;
	readonly completedAt: number;
	readonly localStats: CompletionEffectState;
	readonly serverSubmission: CompletionEffectState;
}
```

- [ ] **Step 1: Write once-per-run sealing red tests**

Cover:

- final valid placement seals before emitting completion;
- known timed time is checkpointed and clamped to at least one second in the seal only;
- relaxed and legacy-unknown seals use null elapsed;
- local effect starts pending;
- API source server effect starts pending;
- local source server effect is `not_applicable`;
- undo can reactivate board/lifecycle but cannot alter seal;
- redo and a fresh final placement emit no second completion;
- advancing time after undo cannot alter sealed request facts;
- direct complete on a full board is idempotent.

- [ ] **Step 2: Write effect-state red tests**

Cover:

- acknowledgement requires the active sealed run ID;
- pending to succeeded;
- pending to structured failed;
- stale prior-run acknowledgement ignored;
- terminal effect acknowledgement ignored;
- retry re-emits pending or retryable failures and resets them to pending first;
- network/internal/storage failures retryable;
- bad-request/not-found/conflict/completion-quota-exceeded terminal;
- unauthorized is retryable only through an explicit retry after a newly authenticated
  transition and is skipped by hydration auto-retry;
- one-shot hydration retry emits each eligible effect at most once;
- no periodic/background retry;
- failed local write leaves the transient in-memory new-best presentation available without
  claiming persistence success.

- [ ] **Step 3: Run the red engine tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement immutable sealing and effect events**

Project the server request only from the seal:

```ts
export function completionRequestFromSeal(seal: SealedCompletion): RecordPuzzleCompletionV1 {
	return {
		version: 1,
		runId: seal.runId,
		resultClass: seal.resultClass,
		timingQuality: seal.timingQuality,
		elapsedActiveSeconds: seal.elapsedActiveSeconds
	};
}
```

Never read mutable state during first submission or retry. Emit separate typed requests for
`local_stats` and `server_submission`.

- [ ] **Step 5: Run the green engine tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/session.ts apps/web/src/lib/services/gameplay/session/session.test.ts
rtk git commit -m "feat(web): seal completion facts and effects once"
```

---

## Task 6: Finish the Versioned Session Codec, Legacy Migration, and Storage Adapter

**Files:**

- Modify: `apps/web/src/lib/services/gameplay/session/persistence.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/persistence.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`

**Persisted projection:**

```ts
export interface PersistedPuzzleSessionV1 {
	schemaVersion: 1;
	puzzleId: string;
	source: PuzzleSourceType;
	lifecycle: Exclude<SessionLifecycle, 'disposed'>;
	mode: SessionMode;
	runId: string;
	origin: SessionOrigin;
	elapsedActiveSeconds: number | null;
	timingQuality: TimingQuality;
	timerStarted: boolean;
	placedPieces: PlacedPiece[];
	trayOrder: number[];
	rotationEnabled: boolean;
	pieceRotations: Record<number, Rotation>;
	counters: {
		incorrectAttempts: number;
		hintsUsed: number;
		referenceActivations: number;
	};
	facts: {
		rotationUsed: boolean;
		hintUsed: boolean;
		ghostReferenceUsed: boolean;
	};
	hasUserActivity: boolean;
	resultClass: ResultClass;
	sealedCompletion: SealedCompletion | null;
	viewport?: PersistedViewport;
	organization?: PersistedTrayOrganization;
	lastUpdated: number;
}
```

**Load result:**

```ts
export type SessionLoadResult =
	| { status: 'missing' }
	| { status: 'loaded'; snapshot: PersistedPuzzleSessionV1 }
	| { status: 'migrated'; snapshot: PersistedPuzzleSessionV1 }
	| { status: 'invalid'; reason: string }
	| { status: 'incompatible'; schemaVersion: number };
```

- [ ] **Step 1: Write v1 round-trip and allowlist red tests**

Cover:

- complete schema v1 round trip;
- selection, history, active reference, clock handles, pointers, modal, hint target, rejection
  animation, and arbitrary extra properties excluded;
- recognized optional organization fields preserved;
- 225-piece snapshot round trip with serialized size growing linearly and no history;
- `disposed` rejected/not serialized;
- future schema version returns incompatible and storage read-only;
- malformed JSON/fields return invalid without partial hydration;
- puzzle/source mismatch;
- placement/tray/rotation/counter/activity/result/seal cross-field validation;
- invalid effect states, including local `not_applicable` and API server
  `not_applicable`.

- [ ] **Step 2: Write deterministic v0 migration red tests**

Starting from the actual unversioned `GameProgress` shape, prove:

- `mode: 'timed'`, `origin: 'resumed'`, and supplied resolved source;
- `timingQuality: 'legacy_unknown'`, null elapsed, and `timerStarted: false`;
- numeric piece IDs sorted before deterministic shuffle;
- UTF-8 FNV-1a seed + Mulberry32 + Fisher-Yates has a pinned expected tray order;
- legacy run ID hashes the original canonical raw JSON including original `lastUpdated`;
- retry after failed write yields the same run ID/tray;
- placements/rotation state determine `hasUserActivity`;
- all valid unique placements produce completed lifecycle and a seal; otherwise active;
- rotation state produces rotation-timed class, otherwise standard-timed;
- valid ISO `lastUpdated` converts to epoch milliseconds; invalid/missing becomes `0`;
- migrated unknown-time completion cannot become a standard best.

- [ ] **Step 3: Write storage failure/read-only red tests**

Cover:

- no-window/server path;
- storage get/set/remove exceptions reported through an injected error hook;
- quota failure does not block the in-memory snapshot;
- migrated writeback best-effort;
- incompatible future record is never overwritten by save/checkpoint/clear from the older
  codec;
- `isResumable` true only for active/paused + activity + no seal.

- [ ] **Step 4: Run the red codec test**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/persistence.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Implement the allowlisted codec**

Export:

```ts
export function serializeSession(state: PuzzleSessionState): PersistedPuzzleSessionV1 | null;

export function loadPersistedSession(
	raw: string | null,
	context: SessionValidationContext
): SessionLoadResult;

export function isResumable(snapshot: PersistedPuzzleSessionV1): boolean;

export function createSessionStorageAdapter(options?: {
	storage?: Storage;
	onError?: (error: SessionPersistenceError) => void;
}): SessionStorageAdapter;
```

The serializer explicitly constructs the persisted object field-by-field. It must not spread
runtime state.

- [ ] **Step 6: Implement deterministic migration helpers**

Keep these pure and tested:

```ts
export function fnv1aUtf8(value: string): number;
export function mulberry32(seed: number): () => number;
export function deterministicLegacyTrayOrder(pieceIds: number[], puzzleId: string): number[];
```

Hash the raw legacy object before normalizing any field.

- [ ] **Step 7: Run green codec tests and a complexity sanity check**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/persistence.test.ts
rtk bun run check --filter=@perseus/web
```

Expected: PASS. The 225-piece serialized snapshot contains one placement/tray/rotation
projection and no duplicated history arrays.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/persistence.ts apps/web/src/lib/services/gameplay/session/persistence.test.ts
rtk git commit -m "feat(web): version and migrate PuzzleSession persistence"
```

---

## Task 7: Version Local Statistics and the V1 API Client

**Files:**

- Modify: `apps/web/src/lib/services/stats.ts`
- Modify: `apps/web/src/lib/services/__tests__/stats.test.ts`
- Modify: `apps/web/src/lib/services/__tests__/stats-errors.test.ts`
- Modify: `apps/web/src/lib/services/api.ts`
- Modify: `apps/web/src/lib/services/__tests__/api.test.ts`

**Local schema:**

```ts
export interface PuzzleStatsV1 {
	schemaVersion: 1;
	puzzleId: string;
	standardBestTime: number | null;
	standardBestCompletedAt: number | null;
	totalCompletions: number;
	lastCompletedAt: number;
	lastRecordedRunId: string | null;
	recordedRunIds: string[];
}
```

- [ ] **Step 1: Write local-stat migration red tests**

Cover:

- valid old `{ bestTime, completedAt, totalCompletions }` becomes schema v1;
- ISO timestamp becomes epoch milliseconds for standard-best and last-completed;
- invalid/missing timestamp becomes `0`;
- malformed/future records fail safely;
- `getBestTime` returns `standardBestTime`;
- no standard best returns null and never manufactures zero.

- [ ] **Step 2: Write sealed-run recording red tests**

Add a new function contract:

```ts
export type RecordLocalCompletionResult =
	| { status: 'recorded'; isNewStandardBest: boolean; stats: PuzzleStatsV1 }
	| { status: 'replayed'; isNewStandardBest: boolean; stats: PuzzleStatsV1 }
	| { status: 'failed'; isNewStandardBest: boolean; inMemoryStats: PuzzleStatsV1 };
```

Test:

- every result class increments total once;
- only eligible standard-known-non-null can create/improve standard best;
- rotation, assisted, relaxed, and legacy-unknown leave best null/unchanged;
- same `lastRecordedRunId` is idempotent;
- new run ID increments;
- stale run ID in `recordedRunIds` ring is idempotent (dedup across ring, not just most recent);
- completion timestamp and standard-best timestamp semantics;
- storage failure preserves in-memory new-best result but returns failed.

- [ ] **Step 3: Write API-client red tests**

Change the client contract to:

```ts
recordCompletion(
	puzzleId: string,
	request: RecordPuzzleCompletionV1
): Promise<RecordPuzzleCompletionResponse>;
```

Assert exact v1 JSON, credentials, and structured handling of 400/401/404/409/429/500. Assert a
fetch rejection remains distinguishable as transport/network failure to the route adapter.

- [ ] **Step 4: Run the red service tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- services/__tests__/stats.test.ts services/__tests__/stats-errors.test.ts services/__tests__/api.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Implement stats v1 and compatibility reads**

Replace `saveCompletionTime` with `recordLocalCompletion(seal)`. Keep `getStats`,
`getBestTime`, and `clearStats` as compatibility consumers over v1. Migration writes back
best-effort and never drops a valid in-memory result because storage is unavailable.

- [ ] **Step 6: Implement the v1 API method**

Post the shared request without adding `completedAt`. Return/throw enough structured
information for the route to map:

```text
400 -> bad_request
401 -> unauthorized
404 -> not_found
409 -> run_id_conflict
429 -> completion_quota_exceeded
500 -> internal_error
fetch rejection -> network_error
```

- [ ] **Step 7: Run green service tests**

Run the command from Step 4, then:

```bash
rtk bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/web/src/lib/services/stats.ts apps/web/src/lib/services/__tests__/stats.test.ts apps/web/src/lib/services/__tests__/stats-errors.test.ts apps/web/src/lib/services/api.ts apps/web/src/lib/services/__tests__/api.test.ts
rtk git commit -m "feat(web): version local and server completion clients"
```

---

## Task 8: Add the Thin Svelte Store Wrapper

**Files:**

- Create: `apps/web/src/lib/services/gameplay/session/store.ts`
- Create: `apps/web/src/lib/services/gameplay/session/store.test.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/session.ts`
- Modify: `apps/web/src/lib/services/gameplay/session/types.ts`

**Store boundary:**

```ts
export interface PuzzleSessionStore extends Readable<Readonly<PuzzleSessionState>> {
	dispatch(action: PuzzleSessionAction): PuzzleSessionOutcome;
	setDocumentHidden(hidden: boolean): void;
	checkpointTime(): void;
	dispose(): void;
}

export function createPuzzleSessionStore(options: CreatePuzzleSessionOptions): PuzzleSessionStore;
```

- [ ] **Step 1: Write the red store tests**

Cover:

- immediate current-state subscription;
- one notification per accepted transition;
- no notification for a true no-op;
- tick notification from the same engine clock;
- dispatch return value forwarded;
- visibility forwarded;
- unsubscribe does not dispose the engine;
- explicit dispose publishes terminal state once and stops clock callbacks;
- Svelte wrapper contains no persistence or fetch behavior.

- [ ] **Step 2: Run the red store test**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/store.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add engine subscription and implement the wrapper**

The engine exposes a framework-neutral `subscribe(listener)` or an injected state-change
callback. `store.ts` adapts it to Svelte's `Readable`; it does not clone/reimplement
transitions.

- [ ] **Step 4: Run green store and engine tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- gameplay/session/session.test.ts gameplay/session/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/web/src/lib/services/gameplay/session/types.ts apps/web/src/lib/services/gameplay/session/session.ts apps/web/src/lib/services/gameplay/session/store.ts apps/web/src/lib/services/gameplay/session/store.test.ts
rtk git commit -m "feat(web): expose PuzzleSession as a Svelte readable"
```

---

## Task 9: Remove Global Selection from Puzzle Components

**Files:**

- Modify: `apps/web/src/lib/components/PuzzlePiece.svelte`
- Modify: `apps/web/src/lib/components/PuzzleBoard.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

**Component inputs:**

```ts
// PuzzlePiece
selected: boolean;
onSelect: (pieceId: number) => void;
onCancelSelection: () => void;

// PuzzleBoard
selectedPieceId: number | null;
onCancelSelection: () => void;
```

- [ ] **Step 1: Rewrite component tests first**

Replace mocks of `$lib/stores/pieceSelection` with props and callbacks. Prove:

- click/keyboard select calls `onSelect(piece.id)`;
- activating an already-selected piece calls `onCancelSelection`;
- disabled/placed pieces do not select;
- board cancellation calls the supplied callback;
- drag and keyboard behavior stays otherwise unchanged.

- [ ] **Step 2: Run the red component tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- PuzzlePiece.svelte.test.ts PuzzleBoard.svelte.test.ts
```

Expected: FAIL because components still own the global store.

- [ ] **Step 3: Convert components to controlled selection**

Remove all imports/subscriptions to `pieceSelection`. Render from props and emit callbacks.
Temporarily adapt the route's existing selection value to those props; the next task replaces
that route value with session state.

- [ ] **Step 4: Run component and route regression tests**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- PuzzlePiece.svelte.test.ts PuzzleBoard.svelte.test.ts puzzle/'[id]'/page.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/web/src/lib/components/PuzzlePiece.svelte apps/web/src/lib/components/PuzzleBoard.svelte apps/web/src/lib/components/__tests__/PuzzlePiece.svelte.test.ts apps/web/src/lib/components/__tests__/PuzzleBoard.svelte.test.ts apps/web/src/routes/puzzle/'[id]'/+page.svelte apps/web/src/routes/puzzle/'[id]'/page.svelte.test.ts
rtk git commit -m "refactor(web): make puzzle selection component-controlled"
```

---

## Task 10: Migrate Route Hydration, Gameplay, Timing, and Persistence

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/src/lib/types/puzzle.ts`

- [ ] **Step 1: Add route hydration red tests**

Prove:

- source resolves before progress migration;
- fresh session is created then immediately started;
- valid active/paused/completed snapshots are not overwritten by auto-start;
- legacy progress migrates deterministically and remains untimed;
- invalid record starts in-memory fresh and may later checkpoint;
- future record starts in-memory but remains persistence-read-only;
- API/local source mismatch is rejected;
- saved tray/placements/rotation restore into rendered state;
- completion-sealed hydration does not reopen celebration.

- [ ] **Step 2: Add route action-parity red tests**

Prove DOM/component events dispatch:

- selection/cancel;
- correct, wrong-slot, and non-upright placement;
- rotation toggle and piece rotation;
- undo/redo buttons and shortcuts;
- hint;
- hold reference down/up and keyboard repeat;
- restart/Play Again;
- visibility suspension.

Retain Zoom/Fit tests as route-owned viewport behavior. Rotation toggle must not start the
timer; placement attempt and piece rotation must.

- [ ] **Step 3: Add route persistence red tests**

Assert immediate checkpoint after meaningful gameplay, visibility suspension, completion,
and restart; periodic timer checkpoint; best-effort checkpoint before disposal/page exit; and
no write for silent no-op actions. Assert serialized storage excludes route transients.

- [ ] **Step 4: Run the red route suite**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- puzzle/'[id]'/page.svelte.test.ts
```

Expected: FAIL because the route still owns unversioned state.

- [ ] **Step 5: Construct one session after source load**

The load flow becomes:

1. load `LoadedPuzzleSource`;
2. load/migrate/validate the progress key with puzzle/source context;
3. construct `PuzzleSessionStore` from loaded snapshot or fresh defaults;
4. immediately dispatch `start` only for a fresh setup session;
5. subscribe once for render state and persistence;
6. register visibility/page-exit cleanup;
7. dispose old session/source on puzzle navigation and component unmount.

Use a load generation token so a late prior puzzle load cannot replace the active session.

- [ ] **Step 6: Replace route-owned gameplay state**

Derive from session state:

- lifecycle/completed;
- placed pieces and IDs;
- canonical tray order;
- selected piece;
- rotation enabled/per-piece rotations;
- undo/redo availability;
- counters/result facts;
- timer display.

Map all current handlers to `dispatch(...)`. Keep only transient presentation state in the
route: loading/errors, viewport/gesture/focus, reference overlay visibility, hint highlight,
rejection animation, and celebration modal.

- [ ] **Step 7: Keep one temporary completion side-effect adapter**

Until Task 11 replaces completion I/O, trigger the route's existing local-stat/legacy-API
callbacks from the session's once-only completion event. Retain the existing completion
guards only inside this adapter so the intermediate commit preserves user-visible completion
behavior. Do not retain a second source of placements, time, result classification, or board
completion state.

- [ ] **Step 8: Replace the route timer**

Remove `createTimerStore()` construction/subscription. Build `TimerState` presentation from the
session snapshot so `GameTimer` continues using the current props/formatting. The session
clock drives updates.

- [ ] **Step 9: Replace route progress writes**

Use the session storage adapter and allowlisted serializer. Checkpoint periodically, after
meaningful state changes, on visibility suspension, completion, restart, and best-effort page
exit. Do not write every timer tick.

- [ ] **Step 10: Run green route and component suites**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- puzzle/'[id]'/page.svelte.test.ts PuzzlePiece.svelte.test.ts PuzzleBoard.svelte.test.ts gameplay/session
rtk bun run check --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
rtk git add apps/web/src/routes/puzzle/'[id]'/+page.svelte apps/web/src/routes/puzzle/'[id]'/page.svelte.test.ts apps/web/src/lib/types/puzzle.ts
rtk git commit -m "refactor(web): drive puzzle route from PuzzleSession"
```

---

## Task 11: Wire Completion Effects and Remove Compatibility State

**Files:**

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Delete: `apps/web/src/lib/services/progress.ts`
- Delete: `apps/web/src/lib/services/__tests__/progress.test.ts`
- Delete: `apps/web/src/lib/services/__tests__/progress-errors.test.ts`
- Delete: `apps/web/src/lib/stores/pieceSelection.ts`
- Delete: `apps/web/src/lib/stores/__tests__/pieceSelection.test.ts`

- [ ] **Step 1: Add completion adapter red tests**

Cover:

- completion event records local stats once and submits API source once;
- Quick Puzzle records local only and acknowledges server `not_applicable`;
- API request equals `completionRequestFromSeal` and excludes client `completedAt`;
- local/server success acknowledged independently;
- local failure does not block celebration and keeps transient new-best presentation;
- transport/500 failures retryable;
- 400/404/409/429 terminal;
- 401 waits for a transition from anonymous/loading to newly authenticated before retry;
- hydration retries pending/retryable eligible effects once;
- hydration does not retry unauthorized before new authentication;
- retry reuses the same run ID and request facts;
- delayed acknowledgement from a prior run after Play Again is ignored;
- completed snapshot does not automatically reopen the modal;
- undo/final-place after seal never repeats local or server totals.

- [ ] **Step 2: Run the red route suite**

Run:

```bash
rtk bun run test:unit --filter=@perseus/web -- puzzle/'[id]'/page.svelte.test.ts
```

Expected: FAIL because the route still uses `completionRecorded`, `activeCompletionId`,
`saveCompletionTime`, and legacy API arguments.

- [ ] **Step 3: Execute effects from typed session events**

For `local_stats`:

1. call `recordLocalCompletion(seal)`;
2. compute transient modal/new-best presentation from its result;
3. dispatch matching success or `storage_error` failure acknowledgement.

For `server_submission`:

1. skip local source (`not_applicable` is already sealed);
2. call `recordCompletion(puzzle.id, completionRequestFromSeal(seal))`;
3. map HTTP/transport failure to the approved failure code/retryability, including
   `not_found`/404 and `completion_quota_exceeded`/429 as terminal `retryable: false`;
4. acknowledge using the captured `seal.runId`.

Subscribe to `playerAuth` only to detect a new authenticated transition and dispatch the
explicit retry for an unauthorized sealed effect.

- [ ] **Step 4: Remove obsolete route state**

Delete route-owned:

- timer store and timer-started boolean;
- global selection subscription;
- placement history instance;
- completion token/boolean;
- placements/rotations/tray canonical state;
- run counters and result-eligibility booleans.

Keep only transient UI state listed in Global Constraints.

- [ ] **Step 5: Delete superseded compatibility modules**

After `rtk rg` proves no production import remains, delete the old progress service/tests and
global piece-selection store/tests. Do not delete `stats.ts`, `history.ts`, `rotation.ts`, or
`timer.ts`; they still provide the new stats adapter, reusable pure helpers, or presentation
formatting.

- [ ] **Step 6: Run focused green suites and dead-code search**

Run:

```bash
rtk rg -n "createTimerStore|completionRecorded|activeCompletionId|services/progress|stores/pieceSelection|saveCompletionTime" apps/web/src
rtk bun run test:unit --filter=@perseus/web -- puzzle/'[id]'/page.svelte.test.ts gameplay/session services/__tests__/stats.test.ts services/__tests__/api.test.ts
rtk bun run check --filter=@perseus/web
```

Expected: the search finds no obsolete gameplay-path reference; tests/check pass.

- [ ] **Step 7: Commit**

```bash
rtk git add -A apps/web/src
rtk git commit -m "feat(web): coordinate sealed PuzzleSession completion"
```

Before committing, inspect `rtk git diff --cached --stat` and ensure `-A` staged only
HPA-372-owned web files.

---

## Task 12: Run Full Regression, E2E, and HPA-372 Acceptance Verification

**Files:**

- Modify: `apps/web/e2e/puzzle-solving.spec.ts`
- Modify only other files required by verified regressions.

- [ ] **Step 1: Extend E2E at the user boundary**

Add or retain scenarios for:

- loading a saved active puzzle and continuing;
- mouse placement;
- keyboard selection/placement;
- touch-oriented component action path where the existing suite supports it;
- Undo/Redo;
- Hint and hold Reference;
- Zoom/Fit;
- rotation toggle/rotation without starting the timer on toggle;
- completion modal;
- Play Again creating a distinct run;
- Quick Puzzle completion remaining local-only.

Do not assert internal store implementation in E2E.

- [ ] **Step 2: Run all web unit tests**

```bash
rtk bun run test:unit --filter=@perseus/web
```

Expected: PASS.

- [ ] **Step 3: Run shared and API contract regression**

HPA-372 consumes the HPA-371 contract, so rerun:

```bash
rtk bun run test:unit --filter=@perseus/types
rtk bun run test --filter=@perseus/shared
rtk bun run test --filter=@perseus/api
```

Expected: PASS.

- [ ] **Step 4: Run gameplay E2E**

```bash
rtk bun run test:e2e --filter=@perseus/web -- puzzle-solving.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run repository-wide validation**

```bash
rtk bun run check
rtk bun run lint
rtk bun run build
rtk git diff --check
```

Expected: PASS.

- [ ] **Step 6: Audit the final persisted and runtime boundaries**

Confirm with focused searches and tests:

- `PuzzleSession` production files import no Svelte/DOM/storage/fetch except `store.ts` for
  Svelte and `persistence.ts` for the injected storage adapter;
- serialized schema contains no selection/history/reference/DOM/clock transient;
- every completion request comes from the immutable seal;
- legacy progress hashing includes original `lastUpdated`;
- future schema versions are read-only;
- `isResumable` has no new current gallery consumer;
- route no longer owns canonical gameplay state;
- no old progress/selection module import remains.

- [ ] **Step 7: Resolve acceptance failures at their owning task**

If acceptance found a defect, return to the task that owns that behavior, add a focused
failing test, make the smallest fix, rerun its green command, and use that task's exact staging
list. Use commit message `fix(web): close HPA-372 acceptance gap`. Do not create a catch-all
acceptance commit or stage unrelated workspace changes. If no files changed, do not create an
empty commit.

- [ ] **Step 8: Declare HPA-372 ready**

HPA-372 is ready only when:

- HPA-371 is already deployed;
- HPA-371's typed tombstone 404 and quota 429 contract is covered by the web API and effect
  tests;
- all unit, API/shared regression, E2E, check, lint, and build commands pass;
- current visible gameplay remains unchanged;
- progress and completion retries are versioned/idempotent;
- obsolete route-owned canonical state is gone.
