# HPA-224: Truthful Completion Summary — Design

**Linear:** HPA-224  
**Status:** Design for implementation  
**Date:** 2026-08-11

## Context

Perseus currently presents every timed completion with a large hard-coded `S RANK`, even though the game has no ranking formula. HPA-557 has already extracted that presentation into `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`, and HPA-556 removed the pre-release completion compatibility paths, so HPA-224 is now unblocked.

The current gameplay domain already contains the facts needed for an honest completion summary:

- `PuzzleSessionState.resultClass` distinguishes `standard_timed`, `rotation_timed`, `assisted_timed`, and `relaxed`;
- `PuzzleSessionState.pieceCount` is the canonical puzzle size;
- `PuzzleSessionState.counters` contains `hintsUsed` and `incorrectAttempts`;
- `PuzzleSessionState.rotationEnabled` describes the final rotation-mode state;
- `PuzzleSessionState.facts.rotationUsed` is the monotonic eligibility fact set once rotation mode has been used/enabled during the run;
- `SealedCompletion.resultClass` and `elapsedActiveSeconds` provide the immutable result class and final timed duration;
- local statistics already treat only `standard_timed` as eligible for `standardBestTime`.

The Linear issue predates the current extracted component and says to show values when they already exist in the completion seal. Counters and rotation facts are intentionally not part of `SealedCompletion`; they already live in the completed session state and persisted session snapshot. Expanding the completion/API contract only for presentation would create unnecessary schema work.

## Goals

1. Remove the hard-coded `S RANK` with no replacement ranking system.
2. Show one truthful result label derived from the existing `ResultClass`.
3. Show final active time for timed results and no competitive time for Relaxed results.
4. Keep the existing standard-timed personal-best semantics exactly as they are.
5. Show existing run context: piece count, hints used, incorrect attempts, and rotation state/use.
6. Preserve completion effect behavior, retry UI, modal focus/Escape behavior, Play Again, and Back to Arcade.
7. Keep the change local to the existing completion component and route wiring.

## Non-goals

- no rank, score, grade, points, stars, or achievement system;
- no new personal-best category for rotation, assisted, or Relaxed results;
- no historical comparisons, charts, share cards, or Next Mission logic;
- no new completion view-model/store/controller;
- no `SealedCompletion`, persistence-schema, API, D1, or server changes;
- no analytics instrumentation;
- no profile/gallery statistics redesign;
- no compatibility handling for removed pre-release formats.

## Options considered

### Option A — Pass existing completion/session facts directly to the extracted dialog (recommended)

Evolve `PuzzleCompletionDialog` from a `timed: boolean` interface to an explicit result-oriented interface. The route passes the sealed result/time plus the completed `PuzzleSessionState` counters and rotation facts.

**Pros**

- smallest change and reuses the exact feature boundary created by HPA-557;
- no duplicated domain or persistence model;
- the dialog remains a presentational component with explicit props/callbacks;
- standard-best eligibility stays owned by the existing stats service/result class contract;
- easy to test as a pure presentation matrix plus a small route-wiring integration.

**Cons**

- the dialog has several factual scalar props, but they are explicit and stable.

### Option B — Add a route-level `CompletionSummary` view model/helper

Build a new object or helper that translates session state into display fields, then pass that object to the dialog.

**Rejected:** there is one consumer and the mapping is tiny. A view-model abstraction would add another type and ownership layer without reducing meaningful duplication.

### Option C — Expand `SealedCompletion` with counters and rotation context

Add piece count, counters, and rotation facts to the immutable completion seal and update persistence validation around it.

**Rejected:** those facts already exist in the completed session snapshot. Expanding the seal would turn a presentation ticket into a domain/persistence contract change and would not improve current behavior.

## Decision

Use **Option A**.

HPA-224 is a presentation change over existing canonical state. `PuzzleSession` remains the sole gameplay state owner; `recordLocalCompletion` remains the sole local-best decision point; the route remains the completion-effect coordinator; `PuzzleCompletionDialog` only renders facts and invokes callbacks.

## Component contract

Replace the current `timed` boolean with the authoritative result class and make elapsed time nullable:

```ts
import type { ResultClass } from '@perseus/types';

interface Props {
  puzzleName: string;
  resultClass: ResultClass;
  elapsedSeconds: number | null;
  pieceCount: number;
  hintsUsed: number;
  incorrectAttempts: number;
  rotationEnabled: boolean;
  rotationUsed: boolean;
  bestTime: number | null;
  isNewBest: boolean;
  localStatsFailed: boolean;
  serverSubmissionRetryable: boolean;
  onRetryServerSubmission: () => void;
  onPlayAgain: () => void;
  onBackToArcade: () => void;
  onDismiss: () => void;
}
```

Do not introduce a grouped summary/view-model prop.

## Result labels and competitive presentation

The component maps the existing result classes directly:

| Result class | Label | Final time | Standard personal best |
| --- | --- | --- | --- |
| `standard_timed` | `STANDARD TIMED` | yes | yes |
| `rotation_timed` | `ROTATION TIMED` | yes | no |
| `assisted_timed` | `ASSISTED TIMED` | yes | no |
| `relaxed` | `RELAXED` | no | no |

The label is factual context, not a rank. It should use the existing compact display/mono visual language and must not replace `S RANK` with another oversized achievement-like treatment.

For standard timed results:

- show `FINAL TIME` from the sealed elapsed time;
- when `bestTime !== null`, show the existing standard personal-best value;
- show `NEW RECORD` only when `isNewBest === true` and the local stats write succeeded;
- show `UNSAVED` instead when the same new-best verdict exists but the local stats write failed;
- on a restored completed session, `isNewBest` remains false, so the dialog shows the stored best without inferring a new record from equal times.

For `rotation_timed` and `assisted_timed`, show final time but never show a personal-best comparison, even if the route has a standard best loaded for the puzzle.

For `relaxed`, show neither final time nor personal best.

## Run-context summary

Show a compact factual summary for every result:

- `PIECES` — the puzzle's canonical `pieceCount`;
- `HINTS USED` — `counters.hintsUsed`;
- `INCORRECT ATTEMPTS` — `counters.incorrectAttempts`;
- `ROTATION` — combine final configuration and the monotonic usage fact:
  - `OFF · NOT USED` when rotation is disabled and was never used;
  - `ON · USED` when enabled at completion and the run used rotation mode;
  - `OFF · USED` when rotation was enabled/used earlier but later disabled;
  - `ON · NOT USED` is allowed defensively if such a state is ever supplied, but current `PuzzleSession` normally marks rotation used as soon as it is enabled.

This deliberately reports existing semantics rather than inventing a new definition of “used” based on the number of piece-rotation button presses.

## Route data flow

The route should prefer the immutable completion seal for result/time and use current completed session state for the existing context facts:

```svelte
<PuzzleCompletionDialog
  puzzleName={puzzle?.name ?? ''}
  resultClass={sessionState?.sealedCompletion?.resultClass ?? sessionState?.resultClass ?? 'standard_timed'}
  elapsedSeconds={sessionState?.sealedCompletion?.elapsedActiveSeconds ?? sessionState?.elapsedActiveSeconds ?? null}
  pieceCount={sessionState?.pieceCount ?? puzzle?.pieceCount ?? 0}
  hintsUsed={sessionState?.counters.hintsUsed ?? 0}
  incorrectAttempts={sessionState?.counters.incorrectAttempts ?? 0}
  rotationEnabled={sessionState?.rotationEnabled ?? false}
  rotationUsed={sessionState?.facts.rotationUsed ?? false}
  {bestTime}
  {isNewBest}
  {localStatsFailed}
  {serverSubmissionRetryable}
  ...
/>
```

Do not copy these values into additional route-local state when completion occurs. The modal already makes the page inert, and restored completed sessions already reconstruct the same `PuzzleSessionState` from persistence.

## Completion-effect invariants

HPA-224 does not change effect orchestration:

- `completion_sealed` / completed lifecycle events still open the modal;
- `recordLocalCompletion` still executes once per sealed run and decides standard-best eligibility;
- server submission still projects from `SealedCompletion` and retries through `retry_completion_effects`;
- late/stale async completion responses remain fenced by puzzle ID and run ID;
- dismissing the modal still does not cause local-stat resolution to reopen it;
- Play Again still clears/restarts the current session through the existing route flow.

The summary component must not dispatch `PuzzleSession` actions or call persistence/API services directly.

## Testing strategy

### Component tests

Expand the focused `PuzzleCompletionDialog` browser-component tests to cover the presentation matrix directly:

1. standard timed with an existing best — final time + personal best, no rank and no new-record badge;
2. standard timed new best — `NEW RECORD`;
3. standard timed new best with local storage failure — `UNSAVED`;
4. rotation timed — final time + rotation result/context, no personal best;
5. assisted timed — final time + assistance counters, no personal best;
6. Relaxed — noncompetitive summary with no final-time/best fields;
7. existing focus, Escape, retry, Play Again, and Back to Arcade callbacks remain covered.

### Route tests

Reuse the existing puzzle-route helpers and tests rather than introducing a new harness:

- strengthen the existing new-best completion test to verify the standard result label;
- strengthen the existing Relaxed completion test to verify the new noncompetitive summary;
- add one assisted-timed completion flow that uses a hint and one rejected placement before solving, then verifies result class and counters from real `PuzzleSession` state;
- retain the existing retry test and once-per-run completion-effect assertions unchanged as regression fences.

Rotation result presentation is sufficiently covered in the component matrix because the session engine already has focused result-class tests; the route does not need another long rotation solve solely to duplicate that domain coverage.

## Risks and mitigations

### Accidentally showing the standard best for nonstandard timed results

**Mitigation:** gate personal-best markup on `resultClass === 'standard_timed'`, not merely on `bestTime !== null`.

### Reconstructing completion facts differently from the domain

**Mitigation:** consume `ResultClass`, counters, and facts from `PuzzleSession`; do not derive an assisted/rotation result in the component.

### Turning the factual result label into another implicit rank

**Mitigation:** remove `.modal-rank` and its animation; render the result label as compact metadata rather than a giant celebratory score.

### Expanding the persistence/API surface for display-only data

**Mitigation:** keep `SealedCompletion`, `RecordPuzzleCompletionV1`, session schema version, stats schema, and server code unchanged.

## Expected file scope

Production/test implementation should remain limited to:

- `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

No new production files are expected.