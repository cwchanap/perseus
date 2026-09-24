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

For the **first** accepted placement that completes a run, `PuzzleSession` currently does:

1. mutate the placed-piece state;
2. emit `placement_accepted` with `completed: true`;
3. enter completion handling;
4. stop/seal the run and transition lifecycle to `completed`;
5. emit `completion_sealed`;
6. notify subscribers;
7. emit pending `completion_effect_request` events for local stats and, when applicable, server submission.

The retained-seal path is different and is the reason HPA-465 must not coordinate three events with a pending flag. After a completed run is undone and the final piece is placed again, `handleBoardCompletion()` sees the existing `sealedCompletion`, transitions lifecycle back to `completed`, and returns without emitting `completion_sealed` or completion-effect requests again.

That makes `completion_sealed` itself the precise presentation seam:

- it fires only when a new completion seal is created;
- redo and undo-then-replace retained-seal completions do not emit it;
- retry/resume effect paths re-emit effect requests, not a new seal;
- lifecycle remains the immediate results path for retained-seal recompletion.

On a first seal, lifecycle sets `showCelebration = true` before `completion_sealed`. The `completion_sealed` handler can synchronously set it back to false and start the reveal before game-core calls `notify()`; the transient true -> false state therefore never needs to paint. Game-core then continues into completion-effect requests without waiting for the presentation timer.

No new game-core event or route-level pending coordinator is needed.

## Selected design

### 1. Treat the final-board reveal as route-local presentation state

Keep `showCelebration` as the existing “results dialog is open” state and add only:

- `completionRevealActive`: reactive boolean used by the route/board presentation;
- one replaceable `completionRevealTimeout`;
- a `COMPLETION_REVEAL_DURATION_MS = 500` constant.

Do **not** add a `liveCompletionRevealPending` flag. The engine's first-seal-only `completion_sealed` event already distinguishes the one completion path that should receive the reveal.

Do not serialize any reveal state.

Add one small cleanup helper beside the existing placement-feedback timeout/cleanup pattern. It owns cancellation/reset of the reveal timeout and `completionRevealActive`. Call it when the route tears down/reloads a puzzle, when the run restarts, and from `onDestroy` so a stale timeout cannot open results for a later puzzle/run.

Do not fold this into `PuzzleSession` or persistence.

### 2. Schedule the reveal only from `completion_sealed`

Keep the route's current lifecycle behavior: a transition into `completed` opens results immediately.

That immediate lifecycle path is required for retained-seal completions:

- redo of the final move;
- dismiss -> undo -> place the final piece again.

Neither creates a new completion seal, so neither should schedule the reveal or duplicate completion writes.

When `completion_sealed` arrives for the first seal:

- reduced motion: leave/open results immediately and do not activate the reveal;
- normal motion: synchronously set `showCelebration = false`, set `completionRevealActive = true`, and schedule the 500 ms timer;
- timer expiry: clear the reveal state/timer and set `showCelebration = true`.

Never await in this event branch.

This works with the existing engine ordering: lifecycle has just set results true, but `completion_sealed` runs synchronously before `notify()`, so the route suppresses the first results paint while still allowing game-core to continue directly into local/server `completion_effect_request` events.

### 3. Completed-session restore stays immediate

Keep the existing hydration behavior:

`showCelebration = restored?.lifecycle === 'completed'`

A restored completed snapshot does not emit a new `completion_sealed` event during hydration, so it has no reveal timer. It opens results immediately and then resumes/retries persisted completion effects exactly as it does today.

This also means the reveal is intentionally not persisted or replayed after refresh/relaunch.

### 4. Reduced motion is checked only when a new completion seals

Use the platform preference directly at the presentation boundary:

`window.matchMedia('(prefers-reduced-motion: reduce)').matches`

No store or media-query abstraction is needed. The user preference only needs to be sampled when deciding whether to insert the short first-seal reveal delay.

If the API is unavailable, normal-motion behavior is the fallback.

The board CSS should also disable the reveal treatment under `prefers-reduced-motion: reduce` as a defensive presentation safeguard.

The E2E harness needs the same treatment, scoped to paused-clock runs. Several existing smoke tests install and pause Playwright's clock before navigation; under a paused clock, a normal `setTimeout(500)` reveal never expires unless the test advances the clock. Rather than coupling unrelated completion tests to this presentation duration, `GameplayPage.gotoFixture` calls `page.emulateMedia({ reducedMotion: 'reduce' })` whenever it installs a paused clock, so those tests keep immediate results while real-clock lanes keep normal motion (and still exercise the reveal end to end).

Do not set a top-level config default instead: Playwright 1.57 silently ignores a bare `use.reducedMotion` key (the working config key is `use.contextOptions.reducedMotion`, passed through to `browser.newContext()`), and a global default disables every animation and transition the app CSS gates on `prefers-reduced-motion` for every lane.

That keeps existing E2E completion semantics immediate across all projects while preserving normal-motion reveal coverage in focused route unit tests and manual browser smoke. Do not add `page.clock.runFor(500)` to every completion spec.

### 5. Block gameplay input without hiding the reveal

The board should remain visible and accessible during the half-second reveal, but gameplay mutations must be blocked.

Do **not** fold `completionRevealActive` into `hasSessionModal`. That derived also drives `inert` and `aria-hidden` on the entire `.puzzle-page`; widening it would hide the completed board from assistive technology during the very presentation beat HPA-465 is adding, with no dialog open to receive focus.

Keep `hasSessionModal` for actual dialog/focus-containment surfaces only, and add one narrower derived:

`const gameplayInputBlocked = $derived(hasSessionModal || completionRevealActive);`

Use `gameplayInputBlocked` for:

- the global gameplay-shortcut guard in `handleWindowKeyDown`, so Ctrl/Cmd+Z cannot undo the final piece while the reveal timer is pending;
- `PuzzleBoardPanel interactionBlocked`, so board pan/input stays inert during the reveal.

Keep `.puzzle-page inert={hasSessionModal} aria-hidden={hasSessionModal}` unchanged.

Add a regression proving Ctrl/Cmd+Z during the reveal does not make the board incomplete while the timer still opens results.

### 6. Put a glow/filter treatment on `PuzzleBoardPanel`

Add one optional prop to `PuzzleBoardPanel.svelte`:

`completionRevealActive?: boolean`

Default it to false so existing component call sites/tests remain unchanged.

Apply a class/data state to the existing `.board-canvas` wrapper. Use a restrained box-shadow/filter glow for roughly the 500 ms reveal window.

Do not animate `transform: scale(...)`: `ZoomableBoardFrame` already owns translate/scale for the user's zoom/pan, and a second scale would read as an unwanted zoom bump.

Requirements:

- no full-screen overlay;
- no large flash over the artwork;
- no per-piece VFX;
- no JS animation loop;
- reduced-motion disables the glow fade (it snaps to its settled opacity).

`PuzzleBoard.svelte` does not need to change.

### 7. Make the completion dialog visibly non-graded

Delete the local `completionStarCount` derivation, star markup, and star-only CSS.

The current full-screen layout clips `.completion-identity` to screen-reader-only content while the stars own grid row 1. Removing stars without reclaiming that slot would leave the visual header empty.

Move/unclip the completion identity into the former star header slot and render one consistent treatment for every result class:

- visible `MISSION COMPLETE`;
- one simple clear/check visual;
- the existing factual result label: `STANDARD TIMED`, `ROTATION TIMED`, `ASSISTED TIMED`, or `RELAXED`;
- puzzle name.

The clear treatment is celebratory but not a score, rank, tier, or quality judgment.

Do not change any domain fields or award calculations.

### 8. Keep results/artwork switching local and preserve focus/layout contracts

Add one local closed union/state inside `PuzzleCompletionDialog`:

`'results' | 'artwork'`

It is reset naturally when the component unmounts and is never stored in the route/session.

Pass the view as the existing focus action key:

`use:modalFocus={completionView}`

`modalFocus.update()` already refocuses the first visible focusable whenever the key changes, matching the existing pause-dialog confirmation pattern.

#### Results view

Keep the current truthful results content and actions.

Preserve the two primary actions and their focus order:

1. `PLAY AGAIN`
2. `BACK TO ARCADE`

When `referenceImageUrl` is non-null, add `VIEW ARTWORK` **after** those primaries as a tertiary ghost action. On the small-screen two-column action grid, make it span both columns so the third action does not create an awkward half-row and Play Again remains the initial focus target.

When the URL is null, retain the existing unavailable fallback and do not render the artwork action.

#### Artwork view

Reuse the same `referenceImageUrl`; do not fetch another resource or introduce another image model.

The artwork subview should have its own viewport-bounded image class using `object-fit: contain`. Do not reuse the current results preview class, which is capped and uses cover-fit presentation.

Render:

- the finished image as the primary content;
- accessible puzzle/artwork naming;
- one obvious `BACK TO RESULTS` action.

Because `completionView` is the `modalFocus` update key, switching into artwork refocuses `BACK TO RESULTS`; switching back refocuses the first results action, `PLAY AGAIN`.

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

1. on the first live completion seal, results are suppressed while local/server completion effects have already started;
2. at 499 ms results are still closed;
3. at 500 ms results open;
4. reduced motion opens results immediately without a timed reveal;
5. a restored `completed` snapshot opens results immediately and does not activate the reveal;
6. redo of the final move reopens results immediately, does not replay the reveal, and does not duplicate completion writes;
7. dismiss -> undo -> place the final piece again also reopens results immediately, does not replay the reveal, and still has only one local/server completion write;
8. Ctrl/Cmd+Z during the first-seal reveal is blocked so the timer cannot later open results over an incomplete board;
9. route teardown/restart cancels any pending reveal timer so it cannot reopen stale results.

Task 1 does not depend on the Task 2 board marker or the Task 3 artwork button. The reveal timing test should use the route-observable contract — results absent/present plus immediate completion-effect calls — so Task 1 ends green on its own.

Fake-timer reveal tests should not assert modal focus on the exact 500 ms tick: `modalFocus` schedules its own `setTimeout(..., 0)`. Focus assertions stay in the reduced-motion/non-fake-timer dialog tests, or explicitly advance one additional zero-delay tick if a fake-timer focus assertion is ever added.

Keep the existing completion retry, stale-effect, navigation, and undo/redo coverage intact.

### Board presentation

Extend `PuzzleBoardPanel.svelte.test.ts` with a focused prop/state test:

- default -> no completion-reveal marker;
- active prop -> marker/class is present;
- `PuzzleBoard` still renders normally.

Do not test CSS animation frames pixel-by-pixel.

### Completion dialog

Replace the star-grade assertions in `PuzzleCompletionDialog.svelte.test.ts`.

Cover:

- standard, rotation, assisted, and relaxed all render the same visible non-graded `MISSION COMPLETE` framing;
- each retains the correct factual result-class label;
- no completion-star markup or star aria label remains;
- all existing result facts/awards/retry actions remain visible when applicable;
- Play Again is still the first results focusable;
- reference URL present -> tertiary `VIEW ARTWORK` exists after the two primaries;
- on the small-screen action grid, the artwork action spans the full row;
- clicking it shows a separate contain-fit focused-art image using the same source;
- switching to artwork focuses `BACK TO RESULTS`;
- `BACK TO RESULTS` restores results and focus returns to Play Again;
- missing reference URL -> fallback stays visible and `VIEW ARTWORK` is absent;
- modal focus containment and Escape dismissal remain intact.

### E2E / accessibility contracts

Reduce motion only for paused-clock fixture loads — `page.emulateMedia({ reducedMotion: 'reduce' })` inside `GameplayPage.gotoFixture`'s clock branch — so existing E2E completion tests that run with a paused Playwright clock bypass the presentation timer, while real-clock specs keep normal motion and wait out the reveal via auto-waiting locators.

`apps/web/e2e/gameplay-interactions.spec.ts` currently asserts three completion stars. Replace that assertion with the new visible non-graded completion framing and keep the existing initial-focus assertion on Play Again.

Run the **full smoke lane**, not only the touched interaction spec, because the timing behavior affects every E2E that completes a puzzle. The accessibility completion test should also continue to pass with Play Again first focusable.

## Risks

- **Paused E2E clock:** existing smoke tests can freeze browser timers; default E2E contexts to reduced motion so the 500 ms presentation timer is never a hidden CI dependency.
- **Dialog blocking vs reveal accessibility:** `hasSessionModal` owns `inert`/`aria-hidden`; keep reveal-only blocking in `gameplayInputBlocked` so the glowing board remains accessible while keyboard mutations are blocked.
- **Stale timeout across route reuse/restart:** the puzzle route component is reused across puzzle ids, so reveal cleanup must run on route teardown, restart, and destroy before an old timer can reopen results.

## File scope

Expected production/config changes:

- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- `apps/web/playwright.config.ts`

Expected test changes:

- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- `apps/web/e2e/gameplay-interactions.spec.ts`

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
