# HPA-224: Truthful Completion Summary — Design

**Linear:** HPA-224  
**Status:** Design for implementation  
**Date:** 2026-08-11

## Context

Perseus currently presents every timed completion with a large hard-coded `S RANK`, even though the game has no ranking formula. HPA-557 has already extracted that presentation into `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`, and HPA-556 removed the pre-release completion compatibility paths, so HPA-224 is now unblocked.

The current gameplay domain already contains the facts needed for an honest completion summary:

- `PuzzleSessionState.resultClass` distinguishes `standard_timed`, `rotation_timed`, `assisted_timed`, and `relaxed`;
- `PuzzleSessionState.pieceCount` is the canonical puzzle size;
- `PuzzleSessionState.counters` contains `hintsUsed`, `incorrectAttempts`, and `referenceActivations`;
- `PuzzleSessionState.rotationEnabled` describes the final rotation-mode state;
- `PuzzleSessionState.facts.rotationUsed` is the monotonic rotation-eligibility fact;
- `PuzzleSessionState.facts.hintUsed` and `ghostReferenceUsed` drive assisted eligibility;
- `SealedCompletion.resultClass` and `elapsedActiveSeconds` provide the immutable result class and final timed duration;
- local statistics already treat only `standard_timed` as eligible for `standardBestTime`.

The Linear issue predates the current extracted component and says to show values when they already exist in the completion seal. Counters and rotation facts were originally not part of `SealedCompletion`; they lived in the completed session state and persisted session snapshot. During implementation, a completion-boundary divergence bug was discovered: after complete → dismiss → undo → hint → redo, the outer session counters/facts diverge from the values that held at the original completion boundary, while `sealedCompletion` is retained across undo/redo without resealing. Presenting the outer counters would therefore show facts that contradict the recorded run (e.g. `STANDARD TIMED` with `HINTS USED = 1`). The fix expands `SealedCompletion` with the four summary facts (`hintsUsed`, `incorrectAttempts`, `rotationEnabled`, `rotationUsed`) captured at the sealing instant, and tightens persistence validation to require them. The API/D1/server completion contract (`RecordPuzzleCompletionV1`) is unchanged — the new fields are client-only presentation facts.

## Goals

1. Remove the hard-coded `S RANK` with no replacement ranking system.
2. Show one truthful result label derived from the existing `ResultClass`.
3. Show final active time for timed results and no competitive time for Relaxed results.
4. Keep standard-timed **personal-best eligibility** unchanged while expanding personal-best **visibility** to any standard-timed completion with a known standard best.
5. Show existing run context: piece count, hints used, incorrect attempts, and rotation state/use.
6. Preserve completion effect behavior, retry UI, modal focus/Escape behavior, Play Again, and Back to Arcade.
7. Keep the change local to the existing completion component, route wiring, and session sealing/persistence (the `SealedCompletion` summary facts and their persistence validation).

## Non-goals

- no rank, score, grade, points, stars, or achievement system;
- no new personal-best category for rotation, assisted, or Relaxed results;
- no historical comparisons, charts, share cards, or Next Mission logic;
- no new completion view-model/store/controller;
- no API, D1, or server completion-contract changes (`RecordPuzzleCompletionV1` is unchanged; the new seal fields are client-only);
- no analytics instrumentation;
- no profile/gallery statistics redesign;
- no compatibility handling for removed pre-release formats;
- no new reference-mode UI or reference metric solely for a future ghost-mode feature.

## Options considered

### Option A — Pass existing completion/session facts directly to the extracted dialog (recommended)

Evolve `PuzzleCompletionDialog` from a `timed: boolean` interface to an explicit result-oriented interface. The route passes the sealed result/time plus the completed `PuzzleSessionState` counters and rotation facts.

**Pros**

- smallest change and reuses the exact feature boundary created by HPA-557;
- no duplicated domain or persistence model;
- the dialog remains a presentational component with explicit props/callbacks;
- standard-best eligibility stays owned by the existing stats service/result class contract;
- easy to test as a pure presentation matrix plus small route-wiring integrations.

**Cons**

- the dialog has several factual scalar props, but they are explicit and stable.

### Option B — Add a route-level `CompletionSummary` view model/helper

Build a new object or helper that translates session state into display fields, then pass that object to the dialog.

**Rejected:** there is one consumer and the mapping is tiny. A view-model abstraction would add another type and ownership layer without reducing meaningful duplication.

### Option C — Expand `SealedCompletion` with counters and rotation context (adopted for fact capture)

Add `hintsUsed`, `incorrectAttempts`, `rotationEnabled`, and `rotationUsed` to the immutable completion seal, captured at the sealing instant, and update persistence validation to require them.

**Adopted (for fact capture):** the original design expected the outer session counters/facts to equal the sealed values at presentation time. They do not: `sealedCompletion` is retained across undo/redo without resealing, so after complete → dismiss → undo → hint → redo the outer counters diverge from the completion boundary. Capturing the facts in the seal at completion time is the only way to present truthful summary facts that match the recorded run. The new fields are client-only; the API/D1/server completion contract is unchanged.

**Cons**

- expands a domain/persistence type and its validation;
- old snapshots persisted before the fields were added are invalidated (acceptable: HPA-556 already removed pre-release compatibility, and back-filling from outer state is unsafe for exactly the divergence case above).

## Decision

Use **Option A** for the dialog contract and **Option C** for fact capture.

The dialog is a presentational component that receives explicit props (Option A). The summary facts themselves are captured in `SealedCompletion` at the completion boundary (Option C) so that an undo/redo cycle after completion cannot present counters that contradict the recorded run. `PuzzleSession` remains the sole gameplay state owner; `recordLocalCompletion` remains the sole local-best decision point; the route remains the completion-effect coordinator; `PuzzleCompletionDialog` only renders facts and invokes callbacks. The route prefers sealed facts and falls back to outer state only when no seal exists.

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

| Result class     | Label            | Final time | Standard personal best |
| ---------------- | ---------------- | ---------- | ---------------------- |
| `standard_timed` | `STANDARD TIMED` | yes        | yes, when known        |
| `rotation_timed` | `ROTATION TIMED` | yes        | no                     |
| `assisted_timed` | `ASSISTED TIMED` | yes        | no                     |
| `relaxed`        | `RELAXED`        | no         | no                     |

The label is factual context, not a rank. It should use the existing compact display/mono visual language and must not replace `S RANK` with another oversized achievement-like treatment.

### Standard personal-best behavior

Eligibility does not change: only `standard_timed` may create or overwrite `standardBestTime`.

Visibility intentionally expands. For any standard-timed completion with a known `bestTime`, show `PERSONAL BEST`, even when the current run did not set a record or the page restored an already-completed session. Do not infer a record from equality.

For a new best:

- show `FINAL TIME` from the sealed elapsed time;
- when the local-stats result supplies the updated best, show it with `NEW RECORD`;
- when `isNewBest === true` but `bestTime === null`, preserve the existing elapsed-time fallback for the best-value presentation;
- show `UNSAVED` instead of `NEW RECORD` when the same new-best verdict exists but the local stats write failed.

At the instant the modal first opens, `bestTime` may still be the pre-run best loaded on route entry. `recordLocalCompletion` runs asynchronously and can then replace it with the current result. A new-record run may therefore briefly show the old standard best before updating to the new value/badge. That transient is acceptable for this hobby-project slice; do not add loading state, duplicate completion state, or another orchestration layer to hide it.

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
  - `ON · NOT USED` is accepted defensively if supplied, although current active-run behavior normally marks rotation used as soon as it is enabled.

This deliberately reports existing semantics rather than inventing a new definition of “used” based on the number of piece-rotation button presses.

### Result-label explainability invariant

A result label must remain explainable by visible completion context that the current UI can actually produce.

Today the route only activates reference mode as `hold`/`null`; it does not expose `ghost`. Therefore `assisted_timed` is currently reachable through Hint usage, and `HINTS USED` explains the assisted label. Although the domain also treats `ghostReferenceUsed` as assisted, adding a `REFERENCE` summary row now would be premature: ordinary hold-reference activations already increment `referenceActivations` without making the run assisted, so that row would not uniquely explain the classification and is outside HPA-224's requested summary.

If a later feature makes ghost reference reachable from the UI, that same feature must extend the completion summary with visible context that distinguishes the assistance cause. Do not ship a reachable `ASSISTED TIMED` path whose summary shows no assistance reason.

## Route data flow

The celebration surface should only render once a live `sessionState` exists. Prefer the immutable completion seal for result/time, then fall back only to the already-authoritative current session fields. Never fabricate a `standard_timed` result when session facts are absent.

Presence matters for elapsed time because a sealed Relaxed completion legitimately stores `elapsedActiveSeconds: null`. Prefer the seal by checking whether the seal exists, not by null-coalescing the elapsed field:

```svelte
{#if showCelebration && sessionState}
	<PuzzleCompletionDialog
		puzzleName={puzzle?.name ?? ''}
		resultClass={sessionState.sealedCompletion?.resultClass ?? sessionState.resultClass}
		elapsedSeconds={sessionState.sealedCompletion
			? sessionState.sealedCompletion.elapsedActiveSeconds
			: sessionState.elapsedActiveSeconds}
		pieceCount={sessionState.pieceCount}
		hintsUsed={sessionState.sealedCompletion?.hintsUsed ?? sessionState.counters.hintsUsed}
		incorrectAttempts={sessionState.sealedCompletion?.incorrectAttempts ??
			sessionState.counters.incorrectAttempts}
		rotationEnabled={sessionState.sealedCompletion?.rotationEnabled ?? sessionState.rotationEnabled}
		rotationUsed={sessionState.sealedCompletion?.rotationUsed ?? sessionState.facts.rotationUsed}
		{bestTime}
		{isNewBest}
		{localStatsFailed}
		{serverSubmissionRetryable}
		...
	/>
{/if}
```

Prefer the sealed facts and fall back to outer state only when no seal exists. The seal captures the counters/rotation at the completion boundary; the outer state may have diverged via undo/redo after completion. Do not copy these values into additional route-local state when completion occurs. The modal already makes the page inert, and restored completed sessions already reconstruct the same `PuzzleSessionState` from persistence. Gating on `sessionState` makes missing state an absence of UI rather than silently inventing a competitive result.

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

### Test selectors

Place completion value test IDs on the value nodes, not on label/value wrappers. This avoids substring-weak assertions and disambiguates final time from a best-time fallback that may render the same formatted value.

Use:

- `completion-final-time` on the final-time value;
- `completion-best-time` on the personal-best value;
- `completion-piece-count` on the piece-count value;
- `completion-hints-used` on the hint-count value;
- `completion-incorrect-attempts` on the incorrect-attempt count value;
- `completion-rotation` on the rotation summary value.

### Component tests

Expand the focused `PuzzleCompletionDialog` browser-component tests to cover the presentation matrix directly:

1. standard timed with an existing best — final time + personal best, no rank and no new-record badge;
2. standard timed new best — `NEW RECORD`;
3. standard timed new best with `bestTime === null` — assert `completion-best-time` equals the final elapsed value and still show `NEW RECORD`;
4. standard timed new best with local storage failure — `UNSAVED`;
5. rotation timed with a known standard best — final time + rotation context, no personal best;
6. assisted timed with a known standard best — final time + assistance counters, no personal best;
7. Relaxed — noncompetitive summary with no final-time/best fields;
8. existing focus, Escape, retry, Play Again, and Back to Arcade callbacks remain covered, but the focus/actions test should assert the new result label rather than retain the removed rank or duplicate the dedicated new-best assertion.

### Route tests

Reuse the existing puzzle-route helpers and tests rather than introducing a new harness:

- add a standard-timed non-record completion with a known existing best and assert that `completion-best-time` is wired through while `NEW RECORD` remains absent;
- strengthen the existing new-best completion test to verify the standard result label;
- strengthen the existing Relaxed completion test to verify the new noncompetitive summary;
- add one assisted-timed completion flow that starts with a known standard best, keeps that best in the mocked local-stats result, uses a hint and one rejected placement, then verifies the assisted result/counters and that the standard PB remains hidden;
- retain the existing retry test and once-per-run completion-effect assertions unchanged as regression fences.

The nonstandard route test must keep `bestTime` non-null through the async local-stats resolution; setting only `getBestTime` is not sufficient if the mocked `recordLocalCompletion` result later overwrites it with `null`.

Rotation result presentation is sufficiently covered in the component matrix because the session engine already has focused result-class tests; the route does not need another long rotation solve solely to duplicate that domain coverage.

## Implementation sequencing

The dialog prop change and route wiring must land as one typecheckable implementation change set. Do not commit an intermediate tree where `PuzzleCompletionDialog` has the new props while `+page.svelte` still passes `timed`, and do not add temporary dual-prop compatibility solely to make an intermediate commit compile.

TDD still proceeds in logical stages: add failing component tests, implement the dialog, add/strengthen failing route tests, wire the route, then run the combined focused tests and package typecheck before committing the implementation.

## Risks and mitigations

### Accidentally showing the standard best for nonstandard timed results

**Mitigation:** gate personal-best markup on `resultClass === 'standard_timed'`, not merely on `bestTime !== null`; component and route tests both exercise nonstandard results with a non-null standard best.

### Personal-best visibility changes asynchronously

**Mitigation:** document and accept the existing-best → updated-best transition while `recordLocalCompletion` resolves. Do not add loading/orchestration state solely to suppress the brief transition.

### A future assisted trigger is not explained in the summary

**Mitigation:** current UI reaches `assisted_timed` through hints and displays `HINTS USED`. Any feature that exposes ghost reference must add distinguishing assistance context in the same change; do not pre-add an ambiguous reference-activation row now.

### Fabricating a competitive result while state is missing

**Mitigation:** render the dialog only when `showCelebration && sessionState`; prefer the seal and fall back only to `sessionState.resultClass` / `sessionState.elapsedActiveSeconds`.

### Treating sealed Relaxed null time as “missing”

**Mitigation:** choose elapsed time based on whether `sealedCompletion` exists, not with `sealedCompletion?.elapsedActiveSeconds ?? ...`.

### Reconstructing completion facts differently from the domain

**Mitigation:** consume `ResultClass`, counters, and facts from `SealedCompletion` (falling back to `PuzzleSession` only when no seal exists); do not derive an assisted/rotation result in the component.

### Turning the factual result label into another implicit rank

**Mitigation:** remove `.modal-rank` and its animation; render the result label as compact metadata rather than a giant celebratory score.

### Presenting outer counters that diverge from the completion boundary

**Mitigation:** capture `hintsUsed`, `incorrectAttempts`, `rotationEnabled`, and `rotationUsed` in `SealedCompletion` at the sealing instant. The route prefers sealed facts and falls back to outer state only when no seal exists. Persistence validation requires the four fields on the seal; old snapshots lacking them are invalidated rather than back-filled, because back-filling from outer state is unsafe for exactly the divergence case this mitigates (complete → dismiss → undo → hint → redo before the snapshot is loaded).

### Expanding the persistence surface for display-only data

**Mitigation:** the new seal fields are client-only; `RecordPuzzleCompletionV1`, the session schema version, stats schema, and server code are unchanged. The `SealedCompletion` expansion is limited to the four presentation facts and does not alter the API request shape projected by `completionRequestFromSeal`.

## Expected file scope

Production/test implementation touches:

- `apps/web/src/lib/components/PuzzleCompletionDialog.svelte` — factual result/time/best/run-context presentation.
- `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts` — result matrix with unambiguous value selectors.
- `apps/web/src/routes/puzzle/[id]/+page.svelte` — pass sealed/session facts into the dialog, preferring the seal.
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts` — route integration tests for the new wiring.
- `apps/web/src/lib/services/gameplay/session/types.ts` — expand `SealedCompletion` with the four summary facts.
- `apps/web/src/lib/services/gameplay/session/session.ts` — capture counters/rotation at the sealing instant.
- `apps/web/src/lib/services/gameplay/session/persistence.ts` — require the four seal fields in `validateSeal`; reject old snapshots that lack them.
- `apps/web/src/lib/services/gameplay/session/persistence.test-fixtures.ts` — update the `seal()` fixture to include the four fields.
- `apps/web/src/lib/services/gameplay/session/persistence.validation-completion.test.ts` — invalidation test for old seals lacking the fields; diverged-seal regression test.
- `apps/web/src/lib/services/gameplay/session/persistence.test.ts` — update round-trip fixtures to include the four seal fields.
- `apps/web/src/lib/services/gameplay/session/persistence.validation-storage.test.ts` — update storage round-trip fixtures.
- `apps/web/src/lib/services/gameplay/session/session.test.ts` — seal capture and divergence tests.
- `apps/web/src/lib/services/gameplay/session/session.edge.test.ts` — edge-case seal tests.
- `apps/web/src/lib/services/__tests__/stats.test.ts` — unchanged behavior, updated fixtures if needed.

No new production files are expected.
