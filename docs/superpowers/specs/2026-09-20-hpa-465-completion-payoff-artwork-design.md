# HPA-465: Completion Payoff and Artwork Viewing — Design

**Linear:** HPA-465  
**Status:** Design for implementation  
**Date:** 2026-09-20

## Context

HPA-465 is the next actionable Perseus ticket after HPA-467: it is the only remaining Todo issue in the Perseus project, has no blockers, and there are no other started Perseus issues or open pull requests.

The ticket is deliberately presentation-only. Finishing a puzzle already has the important domain and persistence behavior:

- `PuzzleSession` accepts the final placement, stops/seals the run, and transitions to `completed`.
- Completion effect requests for local statistics and server submission are emitted after the seal and already run independently of the completion dialog.
- The puzzle route restores a persisted `completed` session by opening the existing completion dialog immediately.
- `PuzzleCompletionDialog.svelte` already owns the reference artwork, factual result-class label, time/record summary, run facts, awards, retry-sync action, Play Again, and Back to Arcade.
- The current 1/2/3-star grade is derived only inside `PuzzleCompletionDialog.svelte`; it is not a domain score or persisted value.
- `PuzzleBoardPanel.svelte` already wraps the board canvas, so a subtle settle/glow can be added without changing puzzle geometry or `PuzzleSession`.

The smallest correct slice is therefore to add one route-local presentation phase before the dialog, remove the local star-grade presentation, and let the existing dialog switch between its results view and a focused artwork view.

## Goals

1. Let a live final placement remain visible on the completed board for about 500 ms before results appear.
2. Start local-stat and server-completion effects immediately; the presentation delay must never gate them.
3. Never replay the reveal when loading a session that is already completed.
4. Skip the timed reveal for `prefers-reduced-motion`.
5. Replace the generic star grade with one non-graded `MISSION COMPLETE` treatment while retaining the factual result-class label.
6. Preserve all truthful completion data: time, record, pieces, hints, incorrect attempts, rotation summary, points, achievements, mastery, family rank, and retry state.
7. Add `VIEW ARTWORK` only when a reference image exists.
8. Keep artwork inspection inside the existing modal with one obvious `BACK TO RESULTS` action.
9. Preserve Play Again, Back to Arcade, Escape dismissal, focus containment, and retry-sync behavior from the results view.
10. Keep the entire change on existing web presentation seams with no generated assets.

## Non-goals

- Any change to scoring, points, achievements, mastery, leaderboard eligibility, result classes, personal-best rules, or completion semantics.
- A new persisted flag, session schema version, API contract, endpoint, database migration, or completion service.
- A new route, gallery, image downloader, sharing flow, zoom/pan artwork viewer, screenshot tool, or export flow.
- Confetti, particles, audio, haptics, or generated celebration artwork.
- NativeScript/mobile parity.
- A generic animation framework, modal framework, presentation state machine, or completion controller.
- Refactoring unrelated puzzle-route lifecycle or the existing completion-effect retry system.

## Existing event ordering

The current game-core ordering is already sufficient and must remain unchanged.

For a final accepted placement, `PuzzleSession` currently does:

1. mutate the placed-piece state;
2. emit `placement_accepted` with `completed: true`;
3. enter completion handling;
4. stop/seal the run and transition lifecycle to `completed`;
5. emit `completion_sealed`;
6. notify subscribers;
7. emit pending `completion_effect_request` events for local stats and, when applicable, server submission.

That ordering provides the exact presentation seam HPA-465 needs:

- `placement_accepted(completed: true)` identifies a **live final-piece completion** before the lifecycle/seal events arrive;
- the route may remember that fact locally;
- the seal event may schedule a UI timer and return immediately;
- game-core then continues to emit completion-effect requests without waiting for the timer.

No new game-core event is needed.

## Selected design

### 1. Treat the final-board reveal as route-local presentation state

Keep `showCelebration` as the existing “results dialog is open” state and add only the state needed for the short pre-results presentation:

- `completionRevealActive`: reactive boolean used by the route/board presentation;
- `liveCompletionRevealPending`: route-local coordination flag set only by a live `placement_accepted(completed: true)`;
- one replaceable `completionRevealTimeout`;
- a `COMPLETION_REVEAL_DURATION_MS = 500` constant.

Do not serialize any of these values.

A small cleanup helper owns cancellation/reset of the pending flag, active flag, and timeout. Call it when the route tears down/reloads a puzzle, when the run restarts, and from `onDestroy` so a stale timeout cannot open results for a later puzzle/run.

Do not fold this into `PuzzleSession` or persistence.

### 2. Consume existing events without delaying completion effects

Update the current route event handling rather than introducing a second controller.

#### Live final placement

When `placement_accepted` arrives with `completed: true`:

- set `liveCompletionRevealPending = true`;
- keep the existing completion announcement;
- do not open the results dialog yet.

#### Lifecycle transition

The engine emits lifecycle `completed` before `completion_sealed`.

- If `liveCompletionRevealPending` is true, the lifecycle event must **not** open the dialog; the seal handler owns the reveal decision.
- If it is false, preserve the existing immediate-dialog behavior. This covers completion transitions such as redo/re-completion that are not a fresh final-piece placement and therefore must not replay the reveal.

#### Completion seal

When `completion_sealed` arrives:

- if there is no live pending flag, open results immediately as today;
- if there is a live pending flag, consume it exactly once;
- if reduced motion is requested, open results immediately;
- otherwise set `completionRevealActive = true`, keep results closed, and schedule the 500 ms timer;
- when the timer fires, clear the reveal state and open results.

The handler only schedules presentation work and returns. It never awaits anything, so the subsequent `completion_effect_request` events run immediately.

### 3. Completed-session restore stays immediate

Keep the existing hydration behavior:

`showCelebration = restored?.lifecycle === 'completed'`

A restored completed snapshot is not created through a live `placement_accepted` event, so it has no pending live reveal and no timer. It opens results immediately and then resumes/retries persisted completion effects exactly as it does today.

This also means the reveal is intentionally not persisted or replayed after refresh/relaunch.

### 4. Reduced motion is checked only when a live completion seals

Use the platform preference directly at the presentation boundary:

`window.matchMedia('(prefers-reduced-motion: reduce)').matches`

No store or media-query abstraction is needed. The user preference only needs to be sampled when deciding whether to insert the short reveal delay.

If the API is unavailable, normal-motion behavior is the fallback.

The board CSS should also disable the settle animation under `prefers-reduced-motion: reduce` as a defensive presentation safeguard, even though the route will not activate the timed reveal in that mode.

### 5. Block interactions during the short reveal

The board should remain visible, but the half-second is a presentation beat, not an extra gameplay state.

Include `completionRevealActive` in the route’s existing interaction/shortcut blocking condition so:

- no toolbar shortcut or board interaction competes with the reveal;
- the completed board remains inert while it settles;
- completion effect handlers still run because they are event-driven and unrelated to input blocking.

Do not broadly rename/refactor the existing dialog-blocking infrastructure for this ticket.

### 6. Put the settle/glow on `PuzzleBoardPanel`, not game-core or piece geometry

Add one optional prop to `PuzzleBoardPanel.svelte`:

`completionRevealActive?: boolean`

Default it to false so existing component call sites/tests remain unchanged.

Apply a class/data state to the existing `.board-canvas` wrapper. The treatment should be restrained:

- a small settle scale or glow around the completed board;
- no full-screen overlay;
- no large flash over the artwork;
- no per-piece particle system;
- duration aligned with the route’s roughly 500 ms reveal window.

`PuzzleBoard.svelte` does not need to change unless implementation proves the wrapper cannot produce the intended visual treatment. Prefer the panel-only seam.

### 7. Make the completion dialog explicitly non-graded

Delete the local `completionStarCount` derivation, star markup, and star-only CSS.

Replace that area with one consistent completion mark/header for every result class:

- visible `MISSION COMPLETE`;
- one simple clear/check visual treatment;
- the existing factual result label: `STANDARD TIMED`, `ROTATION TIMED`, `ASSISTED TIMED`, or `RELAXED`;
- puzzle name.

The clear treatment is celebratory but not a score, rank, tier, or quality judgment.

Relaxed and assisted runs use the same completion framing as standard/rotation runs.

Do not change any domain fields or award calculations.

### 8. Keep results/artwork switching local to `PuzzleCompletionDialog`

Add one local closed union/state inside the component:

`'results' | 'artwork'`

It is reset naturally when the component unmounts and is never stored in the route/session.

#### Results view

Keep the current truthful results content and actions:

- result class;
- final time where applicable;
- personal best/record;
- pieces/hints/incorrect attempts/rotation;
- points, achievements, mastery, family rank;
- retry-sync banner/action;
- Play Again;
- Back to Arcade;
- reference-art preview/fallback.

When `referenceImageUrl` is non-null, add `VIEW ARTWORK`.

When it is null, retain the existing unavailable fallback and do not render the action.

#### Artwork view

Reuse the same `referenceImageUrl`; do not fetch another resource or introduce another image model.

The modal switches to a simple focused presentation:

- finished image is the primary content;
- use contain-style sizing so the whole image can be inspected within the viewport;
- retain accessible puzzle/artwork naming;
- render one obvious `BACK TO RESULTS` action.

Play Again, Back to Arcade, awards, and retry-sync remain in the results view and reappear unchanged when the user returns.

Keep the existing modal focus trap and backdrop Escape dismissal. Escape continues to dismiss the completion modal; `BACK TO RESULTS` is the explicit in-modal navigation action.

### 9. Do not add image-failure infrastructure

The route already resolves `referenceImageUrl` and the dialog already has a null fallback.

HPA-465 should continue using that contract:

- URL present -> preview and `VIEW ARTWORK`;
- URL absent -> existing fallback, no artwork action.

Do not add a generalized image loading/error state, retries, or prefetching solely for this ticket.

## Testing strategy

### Route behavior

Extend `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`.

The existing suite has many completion tests that are unrelated to animation timing. To keep it fast and deterministic:

- provide a small `matchMedia` test helper;
- default unrelated route tests to reduced-motion behavior so their existing immediate-result expectations do not each pay a real 500 ms delay;
- add dedicated HPA-465 tests that explicitly opt into normal motion and use fake timers.

The dedicated route tests must prove:

1. after the live final piece, results are still closed during the reveal;
2. the board exposes the reveal state;
3. `recordLocalCompletion` and `recordCompletion` have already started before the reveal timer advances;
4. at 499 ms results are still closed;
5. at 500 ms results open and the reveal state clears;
6. reduced motion opens results immediately without a timed reveal;
7. a restored `completed` snapshot opens results immediately and does not activate the reveal;
8. redo/re-completion does not replay the live final-piece reveal and does not duplicate completion writes;
9. route teardown/restart cancels any pending reveal timer so it cannot reopen stale results.

Keep the existing completion retry, stale-effect, Play Again, navigation, and undo/redo coverage intact.

### Board presentation

Extend `PuzzleBoardPanel.svelte.test.ts` with a focused prop/state test:

- default -> no completion-reveal marker;
- active prop -> marker/class is present;
- interaction/board rendering remains unchanged.

Do not test CSS animation frames pixel-by-pixel.

### Completion dialog

Replace the star-grade assertions in `PuzzleCompletionDialog.svelte.test.ts`.

Cover:

- standard, rotation, assisted, and relaxed all render the same non-graded `MISSION COMPLETE` framing;
- each retains the correct factual result-class label;
- no completion-star markup or star aria label remains;
- all existing result facts/awards/retry actions remain visible when applicable;
- reference URL present -> `VIEW ARTWORK` exists;
- clicking it shows the focused art using the same source and hides result controls;
- `BACK TO RESULTS` restores the unchanged results/actions;
- missing reference URL -> fallback stays visible and `VIEW ARTWORK` is absent;
- modal focus containment, Escape dismissal, Play Again, Back to Arcade, and retry callbacks remain intact.

## File scope

Expected production changes:

- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`

Expected test changes:

- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`

Do not modify by default:

- `packages/game-core/**`
- `packages/types/**`
- completion API/services
- session codecs/persistence
- database/workflows
- NativeScript/mobile
- image/SFX assets

## Delivery shape

One Linear ticket -> one pull request.

This planning branch/PR remains the HPA-465 implementation PR. After review of this design/plan, implementation commits continue on the same branch; do not open a second implementation PR.

No separate art/SFX ticket is required because the selected design reuses the existing finished artwork and CSS-only presentation.
