# HPA-465 Completion Payoff and Artwork Viewing — Implementation Plan

> Continue implementation on this same branch/PR. One Linear ticket -> one PR.

**Goal:** Add a short live final-board reveal, remove the misleading star grade, and let players inspect the existing finished artwork without changing completion semantics or progression.

**Architecture:** Keep all new state in existing presentation owners. The puzzle route uses the engine's first-seal-only `completion_sealed` event to schedule one reveal timer while lifecycle completion remains the immediate path for retained-seal redo/re-placement; `PuzzleBoardPanel` receives one optional presentation flag for a restrained glow; `PuzzleCompletionDialog` owns a local `results | artwork` view toggle, visible non-graded header, and focus-key update. Game-core, persistence, scoring, APIs, and assets stay unchanged.

**Tech stack:** Svelte 5, TypeScript, existing `@perseus/game-core` events, Vitest + vitest-browser-svelte.

## Global constraints

- One HPA-465 implementation PR; keep all implementation on this planning branch/PR.
- Presentation-only: no `@perseus/game-core` behavior/schema changes.
- No completion persistence, API, D1, workflow, or scoring changes.
- No new result tier/rank/hidden quality score after stars are removed.
- No animation framework, modal framework, state machine, generic media-query store, or artwork viewer package.
- No generated images, audio, haptics, particles, or confetti.
- No NativeScript/mobile parity.
- The reveal may delay only the **dialog presentation**. Timer finalization, sealing, local stats, server submission, awards, retries, and persistence must remain immediate.
- Only the first live completion that creates a new completion seal gets the reveal. Restored completed sessions and retained-seal redo/undo-then-replace completions open results immediately.
- Missing reference artwork keeps the current fallback and never exposes a broken `VIEW ARTWORK` action.

## File map

**Modify**

- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- `apps/web/e2e/gameplay-interactions.spec.ts`
- `apps/web/playwright.config.ts`

**Do not modify by default**

- `packages/game-core/**`
- `packages/types/**`
- `apps/web/src/lib/services/api.ts`
- completion/statistics business rules
- session persistence/codecs
- backend/workflows/database
- `apps/mobile/**`
- image/audio assets

## Risks

- **Paused Playwright clock:** multiple smoke tests freeze browser timers before navigation; the reveal timer would never expire unless E2E defaults to reduced motion.
- **Modal containment vs reveal:** `hasSessionModal` also drives page `inert`/`aria-hidden`; do not reuse it for reveal-only blocking. Use the narrower `gameplayInputBlocked`.
- **Stale reveal timeout:** direct puzzle-to-puzzle route reuse/restart can outlive a timer; cleanup must run before constructing the next session and on restart/destroy.

---

## Task 1: Add the first-seal final-board reveal at the route event boundary

### Files

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/playwright.config.ts`

### 1.1 Add a reduced-motion test helper before changing production behavior

The route suite already has many tests that finish puzzles and expect the completion dialog immediately. They test completion semantics, not animation latency.

Add a small helper for `window.matchMedia('(prefers-reduced-motion: reduce)')`.

Default the paused-clock harness path to reduced motion so unrelated completion tests keep their immediate behavior and do not each wait 500 ms.

Dedicated HPA-465 reveal tests explicitly opt into normal motion.

Do not add a production media-query store just to make tests injectable.

In the same Task 1 setup, make `GameplayPage.gotoFixture` call `page.emulateMedia({ reducedMotion: 'reduce' })` whenever it installs a paused clock — **before** the production reveal timer lands. Several existing smoke tests pause Playwright's clock, under which a `setTimeout(500)` reveal never expires; this keeps Task 1/CI green without teaching unrelated tests the 500 ms presentation duration. Real-clock tests keep normal motion and simply wait out the reveal. Do NOT add a top-level `reducedMotion` config default: Playwright 1.57 silently ignores a bare `use.reducedMotion` key (the working key is `use.contextOptions.reducedMotion`), and any global default also disables every animation/transition the app CSS gates on `prefers-reduced-motion`.

### 1.2 Write the failing first-seal ordering test

Use fake timers and normal motion.

Render the two-piece fixture and place the final piece.

Immediately after the first completion seal assert:

- the results dialog is absent;
- `recordLocalCompletion` has already been called once;
- `recordCompletion` has already been called once for API-backed fixtures.

Advance to 499 ms:

- results are still absent.

Advance the final 1 ms:

- results are visible.

Task 1 deliberately does not assert the panel-level reveal class/marker; Task 2 owns that UI seam. This keeps Task 1 independently green.

This is the hard guardrail: presentation timing must never delay completion effects.

Do not add a focus assertion to this fake-timer test at the exact 500 ms boundary. `modalFocus` schedules a separate zero-delay timeout when the dialog mounts; focus behavior is covered later under reduced-motion/non-fake-timer tests.

### 1.3 Add only the route-local reveal state the engine does not already provide

Near `showCelebration` and the existing presentation timers add:

`const COMPLETION_REVEAL_DURATION_MS = 500;`

plus:

- `completionRevealActive`;
- `completionRevealTimeout`.

Do **not** add `liveCompletionRevealPending`.

`completion_sealed` already fires only when a new seal is created. The retained-seal undo/re-complete path intentionally does not emit it.

Keep `showCelebration` as the existing results-dialog flag.

### 1.4 Add one reveal cleanup helper beside the existing placement-feedback cleanup

Follow the existing `placementFeedbackTimeout` / `clearPlacementFeedback()` teardown shape without sharing the timer itself.

The reveal helper:

- clears `completionRevealTimeout` if present;
- nulls the timeout;
- clears `completionRevealActive`.

Call it from:

- route teardown before loading another puzzle;
- `restartWithCurrentChoices()`;
- `onDestroy()`.

It must not touch completion facts/effects.

### 1.5 Leave lifecycle completion opening results immediately

Do not gate the lifecycle handler with a pending flag.

Keep the current behavior for `event.type === 'lifecycle' && event.to === 'completed'`:

- open results immediately.

This is required for:

- redo of the final move;
- dismiss -> undo -> place the final piece again.

Those paths retain the existing seal and emit lifecycle completion without a new `completion_sealed`.

### 1.6 Schedule or skip the reveal only from `completion_sealed`

On `completion_sealed`:

1. sample `prefers-reduced-motion`;
2. reduced motion -> leave/open results immediately and do not activate the reveal;
3. normal motion -> synchronously set `showCelebration = false`, set `completionRevealActive = true`, and schedule the 500 ms timeout;
4. timeout -> clear reveal/timer state and set `showCelebration = true`.

Never `await` in this branch.

Why the true -> false sequence is safe: the engine has just emitted lifecycle completed but has not called `notify()` yet. `completion_sealed` runs in the same synchronous event turn, so the intermediate dialog-open state does not paint. Game-core then calls `notify()` and emits the existing completion-effect requests; nothing waits on the timer.

### 1.7 Split dialog containment from reveal-time gameplay blocking

Do not widen `hasSessionModal`: it also drives `inert` and `aria-hidden` on the whole puzzle page, which must remain visible/accessibility-exposed during the reveal.

Add:

`const gameplayInputBlocked = $derived(hasSessionModal || completionRevealActive);`

Use `gameplayInputBlocked` for:

- the `handleWindowKeyDown` early return;
- `PuzzleBoardPanel interactionBlocked`.

Leave:

`<div class="puzzle-page" inert={hasSessionModal} aria-hidden={hasSessionModal}>`

unchanged.

Add a regression: during a normal-motion reveal, dispatch Ctrl/Cmd+Z before 500 ms and prove the final placement remains intact; after 500 ms the results dialog opens over a still-complete board.

### 1.8 Preserve completed-session hydration

Add a focused restored-completion test with:

- lifecycle `completed`;
- all pieces placed;
- a valid sealed completion.

Assert:

- results are visible immediately;
- reveal state is not active;
- no timer advancement is required;
- existing resume/retry completion-effect behavior is unchanged.

Do not change the production hydration assignment that already opens results from `restored?.lifecycle === 'completed'`.

### 1.9 Prove reduced motion skips the reveal

With `matchMedia` returning reduced motion:

- finish a fresh puzzle;
- results are immediately visible;
- reveal state is not active;
- local/server effects were each started once.

### 1.10 Pin both retained-seal completion paths

Keep/update the existing redo test:

- dismiss results;
- undo final piece;
- redo;
- results reopen immediately;
- no reveal state;
- still one local/server write.

Add a distinct **undo-then-replace** regression:

- dismiss results;
- undo the final piece;
- place that final piece again through normal placement;
- results reopen immediately;
- no reveal state/timer;
- still one local/server write.

This is required because normal re-placement emits `placement_accepted(completed: true)` but no new `completion_sealed`.

### 1.11 Pin stale-timer cleanup

Start a normal-motion first-seal reveal, then restart or navigate directly to another puzzle before 500 ms.

Advance beyond 500 ms and assert the stale timeout cannot open results for the new run/puzzle.

### 1.12 Run the focused route suite

`bun run --cwd apps/web test:unit -- 'src/routes/puzzle/[id]/page.svelte.test.ts'`

Expected: pass.

## Task 2: Add the restrained completed-board settle treatment

### Files

- Modify: `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`

### 2.1 Write the failing panel-state test

Extend the existing board-panel test fixture with the optional reveal prop.

Cover:

- omitted/false -> no completion-reveal marker/class;
- true -> completion-reveal marker/class is present;
- the `PuzzleBoard` still renders normally.

No screenshot/pixel assertions and no animation-clock test are needed at component level.

### 2.2 Add one optional panel prop

Add:

`completionRevealActive?: boolean`

Default: `false`.

Do not add another callback, event, or board model.

### 2.3 Apply the treatment to the existing board canvas wrapper

Apply the state to `.board-canvas`, not individual puzzle pieces.

Use one restrained CSS glow/filter state:

- modest accent/gold box-shadow and/or filter;
- roughly the same 500 ms duration;
- no transform/scale animation because `ZoomableBoardFrame` already owns translate/scale and a second scale would look like a zoom bump.

Requirements:

- image remains fully readable;
- no covering overlay;
- no particle nodes;
- no JS animation loop.

Add a `prefers-reduced-motion: reduce` rule that disables the glow/filter transition defensively.

### 2.4 Pass the route state into the panel

From the existing puzzle route call site:

`completionRevealActive={completionRevealActive}`

No `PuzzleBoard.svelte` change unless the panel wrapper proves insufficient during implementation.

### 2.5 Run focused board tests

`bun run --cwd apps/web test:unit -- src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts 'src/routes/puzzle/[id]/page.svelte.test.ts'`

Expected: pass.

---

## Task 3: Remove star grading and add the local artwork view

### Files

- Modify: `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- Modify: `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- Modify: `apps/web/e2e/gameplay-interactions.spec.ts`

### 3.1 Replace the star-count matrix with non-graded result tests

Delete the tests that expect 1/2/3 stars.

Add a parameterized matrix for:

- `standard_timed` -> `STANDARD TIMED`;
- `rotation_timed` -> `ROTATION TIMED`;
- `assisted_timed` -> `ASSISTED TIMED`;
- `relaxed` -> `RELAXED`.

For every row assert:

- the same visible `MISSION COMPLETE` framing is present;
- the factual label is correct;
- no completion-star markup/aria label exists.

Do not invent a replacement grade.

### 3.2 Delete the local star derivation and reclaim its visual slot

Remove:

- `completionStarCount`;
- star SVG loop;
- star-specific sizing/layout rules that become dead.

The current full-screen layout hides `.completion-identity` with screen-reader-only clipping while `.completion-stars` owns the first grid row.

Move/unclip the completion identity into that former header slot; otherwise star removal leaves the results screen with no visible completion header.

Keep `competitiveTimedResult` if it remains needed by record presentation.

### 3.3 Render one consistent visible completion header

The reclaimed header slot contains:

- visible `MISSION COMPLETE`;
- a simple clear/check visual using existing theme/CSS;
- the factual result label;
- puzzle name.

Do not add a numeric score, letter grade, medal tier, or quality wording.

### 3.4 Add local `results | artwork` state and use it as the focus key

Inside `PuzzleCompletionDialog.svelte`:

`let completionView = $state<'results' | 'artwork'>('results');`

Change the existing action to:

`use:modalFocus={completionView}`

`modalFocus.update()` already refocuses the first visible focusable when the key changes; no new focus helper is needed.

### 3.5 Preserve the two primary actions and add View Artwork as tertiary

Results action DOM/focus order must be:

1. `PLAY AGAIN`
2. `BACK TO ARCADE`
3. optional `VIEW ARTWORK`

Only render `VIEW ARTWORK` when `referenceImageUrl !== null`.

Style it as a tertiary ghost action. Scope `grid-column: 1 / -1` to the existing narrow-viewport media block where `.modal-actions` actually becomes a two-column CSS grid. Do not add the span rule at base flex layout.

This preserves Play Again as initial focus in unit/E2E/a11y tests.

### 3.6 Render a dedicated contain-fit artwork view

When `completionView === 'artwork'` and the URL exists:

- keep the same modal/backdrop/focus action;
- render the same URL as the primary image;
- use a **separate** artwork-view class with viewport-bounded sizing and `object-fit: contain`;
- retain accessible puzzle/artwork naming;
- render one `BACK TO RESULTS` action.

Do not reuse the current `.completion-reference-art` results-preview class, which is capped and uses cover-fit presentation.

Do not render Play Again, Back to Arcade, awards, run summary, or retry controls in the artwork subview; they return unchanged after Back to Results.

No zoom/pan/download/share controls.

### 3.7 Preserve dismissal and explicitly refocus on view changes

Keep:

- `role="dialog"`;
- `aria-modal="true"`;
- backdrop Escape -> `onDismiss`.

Because `completionView` is the modal-focus update key:

- results -> artwork focuses `BACK TO RESULTS`;
- artwork -> results focuses `PLAY AGAIN`.

Escape still dismisses the whole completion modal; it is not an alternate Back action.

### 3.8 Extend dialog and route focus tests

Dialog component tests cover:

- all result facts/awards remain truthful;
- Play Again is the first results focusable;
- reference URL -> View Artwork exists after the primaries;
- switch -> focused artwork uses the same `src` with contain-view marker/class;
- Back to Results receives focus on artwork entry;
- returning restores results and focus returns to Play Again;
- null URL -> fallback visible and View Artwork absent;
- Escape and focus containment remain intact.

Update the route's existing two-button Tab-wrap test here, after the artwork action exists:

- Play Again remains first/initial focus;
- Back to Arcade remains the second primary;
- View Artwork is the tertiary last action for the default reference fixture;
- Tab from View Artwork wraps to Play Again;
- Shift+Tab from Play Again wraps to View Artwork.

This is the single owner of that route focus-contract update.

### 3.9 Update the interaction E2E that asserts stars

`apps/web/e2e/gameplay-interactions.spec.ts` currently expects exactly three `completion-star` nodes.

Replace that assertion with the new visible `MISSION COMPLETE` framing.

Keep the existing initial-focus assertion on Play Again. This is not optional/manual coverage; the old assertion will fail on this PR once stars are removed.

### 3.10 Run focused dialog and route tests

`bun run --cwd apps/web test:unit -- src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts 'src/routes/puzzle/[id]/page.svelte.test.ts'`

Expected: pass.

## Task 4: Integration gate and scope review

### 4.1 Run focused HPA-465 unit suites together

`bun run --cwd apps/web test:unit -- 'src/routes/puzzle/[id]/page.svelte.test.ts' src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`

Expected: pass.

### 4.2 Run the full web unit suite

`bun run --cwd apps/web test:unit`

Expected: pass.

### 4.3 Run the full smoke lane, changed interaction spec, and accessibility lane

Run:

`bun run --cwd apps/web test:e2e:smoke`

then the changed completion-interaction spec:

`bun run --cwd apps/web test:e2e -- e2e/gameplay-interactions.spec.ts`

and:

`bun run --cwd apps/web test:e2e:a11y`

The full smoke lane is required because reveal timing affects multiple existing specs, including paused-clock completion tests. Those keep immediate results via the harness's scoped `page.emulateMedia({ reducedMotion: 'reduce' })` on the paused-clock path; real-clock specs keep normal motion and wait out the 500 ms reveal via auto-waiting locators.

The targeted interaction run is still required because its completion-dialog test owns the star -> MISSION COMPLETE assertion and is tagged `@webkit-critical`, not `@smoke`; the smoke grep does not exercise that assertion. The a11y completion scan must also remain green.

### 4.4 Run repository type/lint checks

`bun run check`

Expected: pass.

If current `main` has a known unrelated failure, record the exact baseline and prove HPA-465's focused suites remain green rather than broadening scope.

### 4.5 Manual browser smoke

Keep the manual pass only for visual behavior automated tests cannot judge well:

1. normal motion: the completed-board glow is restrained, readable, and does not feel like a zoom bump;
2. at a phone-sized viewport, View Artwork is a clear full-width tertiary row below the two primary actions;
3. the focused artwork uses contain-fit sizing so the full image remains inspectable without obvious cropping at small and desktop viewports;
4. the visible MISSION COMPLETE header has a sensible hierarchy after the stars are removed.

Restore/reduced-motion/undo-replace/retry behavior stays automated rather than duplicated manually.

No new image or audio asset verification is needed.

### 4.6 Final scope check

The implementation diff should stay within the planned web source/test files plus these planning documents.

Reject scope creep into:

- game-core/session schema;
- scoring/progression;
- API/backend;
- generic animation/viewer infrastructure;
- mobile parity;
- generated art/SFX;
- unrelated puzzle-route cleanup.

### 4.7 Keep the same PR

After planning review, continue Tasks 1-4 on this branch and update this same draft PR’s description/checklist as implementation lands.

Do not open a second HPA-465 implementation PR.
