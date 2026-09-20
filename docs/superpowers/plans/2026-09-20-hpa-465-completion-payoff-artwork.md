# HPA-465 Completion Payoff and Artwork Viewing — Implementation Plan

> Continue implementation on this same branch/PR. One Linear ticket -> one PR.

**Goal:** Add a short live final-board reveal, remove the misleading star grade, and let players inspect the existing finished artwork without changing completion semantics or progression.

**Architecture:** Keep all new state in existing presentation owners. The puzzle route coordinates one live-completion reveal timer using existing session events; `PuzzleBoardPanel` receives one optional presentation flag for a restrained settle/glow; `PuzzleCompletionDialog` owns a local `results | artwork` view toggle and removes its local star-grade derivation. Game-core, persistence, scoring, APIs, and assets stay unchanged.

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
- Only a live final-piece placement gets the reveal. Restored completed sessions and redo/re-completion do not replay it.
- Missing reference artwork keeps the current fallback and never exposes a broken `VIEW ARTWORK` action.

## File map

**Modify**

- `apps/web/src/routes/puzzle/[id]/+page.svelte`
- `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleBoardPanel.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts`
- `apps/web/src/lib/components/PuzzleCompletionDialog.svelte`
- `apps/web/src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`

**Do not modify by default**

- `packages/game-core/**`
- `packages/types/**`
- `apps/web/src/lib/services/api.ts`
- completion/statistics business rules
- session persistence/codecs
- backend/workflows/database
- `apps/mobile/**`
- image/audio assets

---

## Task 1: Add the live final-board reveal at the route event boundary

### Files

- Modify: `apps/web/src/routes/puzzle/[id]/+page.svelte`
- Modify: `apps/web/src/routes/puzzle/[id]/page.svelte.test.ts`

### 1.1 Add a reduced-motion test helper before changing production behavior

The route suite already has many tests that finish puzzles and expect the completion dialog immediately. They test completion semantics, not animation latency.

Add a small helper for `window.matchMedia('(prefers-reduced-motion: reduce)')`.

Default the existing integration suite to reduced motion so unrelated completion tests keep their immediate behavior and do not each wait 500 ms.

Dedicated HPA-465 reveal tests will explicitly switch to normal motion.

Do not add a production media-query store just to make tests injectable.

### 1.2 Write the failing normal-motion ordering test

Use fake timers.

Arrange a normal-motion environment, render the two-piece fixture, place the first piece, then place the final piece.

Immediately after final placement assert:

- the results dialog is absent;
- the board/reveal presentation state is active;
- `recordLocalCompletion` has already been called once;
- `recordCompletion` has already been called once for API-backed fixtures.

Advance to 499 ms:

- results still absent;
- reveal still active.

Advance the final 1 ms:

- results visible;
- reveal state cleared.

This test is the hard guardrail: presentation timing must never delay completion effects.

### 1.3 Add route-local reveal state

Near the existing `showCelebration` and presentation timers add:

`const COMPLETION_REVEAL_DURATION_MS = 500;`

and route-local state equivalent to:

- `completionRevealActive`;
- `liveCompletionRevealPending`;
- `completionRevealTimeout`.

Keep `showCelebration` as the existing result-dialog flag.

Do not add these fields to `PuzzleSession` or serialized snapshots.

### 1.4 Add one cleanup helper

Add a small helper that:

- clears the timeout if present;
- nulls the timeout;
- clears `liveCompletionRevealPending`;
- clears `completionRevealActive`.

Call it from:

- route teardown before loading another puzzle;
- `restartWithCurrentChoices()`;
- `onDestroy()`.

The helper must **not** touch completion facts or effect state.

### 1.5 Mark only a live final placement

In `handleSessionEvent`:

- on `placement_accepted`, preserve current hint clearing/announcement;
- when `event.completed === true`, first set `liveCompletionRevealPending = true`.

Do not start the timer from `placement_accepted`; the seal event owns the presentation decision so the completed session snapshot already exists.

### 1.6 Prevent the lifecycle event from opening results too early

The engine transitions lifecycle to `completed` before emitting `completion_sealed`.

Keep the current lifecycle fallback for non-live completion transitions, but change it to:

- open results immediately when there is no live pending reveal;
- do nothing when `liveCompletionRevealPending` is true.

This preserves immediate results for redo/re-completion and any non-final-placement completion transition.

### 1.7 Start or skip the reveal from `completion_sealed`

On `completion_sealed`:

1. if there is no live pending reveal, open results immediately;
2. otherwise consume the pending flag once;
3. check `prefers-reduced-motion`;
4. reduced motion -> open results immediately;
5. normal motion -> set `completionRevealActive = true`, keep `showCelebration = false`, and schedule the 500 ms timeout;
6. timeout -> clear active/timer state and set `showCelebration = true`.

Never `await` in this event branch.

The engine must be free to continue synchronously into its `completion_effect_request` emissions.

### 1.8 Include the reveal in existing input blocking

Extend the route’s current dialog/interaction blocking expression to treat `completionRevealActive` as blocked presentation time.

Do not perform a broad rename/refactor of every `hasSessionModal` use solely because the legacy name becomes slightly wider in meaning.

The completed board remains visible but inert for the half-second.

### 1.9 Preserve completed-session hydration

Add a focused test that restores:

- lifecycle `completed`;
- all pieces placed;
- a valid sealed completion.

Assert:

- results are visible immediately after route load;
- reveal presentation is not active;
- no 500 ms advancement is required;
- pending completion effects still follow the existing resume/retry path.

Do not change the production hydration assignment that already opens results from `restored?.lifecycle === 'completed'`.

### 1.10 Prove reduced motion skips the timer

With the test helper returning `matches: true`:

- finish the live puzzle;
- assert results are visible without advancing timers;
- assert the board reveal marker is not active;
- assert completion effect calls still happened once.

### 1.11 Keep redo and stale-timer behavior pinned

Update/extend the existing undo/redo completion test so redo:

- reopens results immediately;
- does not activate the live reveal;
- does not call local/server completion writes a second time.

Add one cleanup regression covering restart or direct puzzle navigation while a reveal timer exists; after advancing past 500 ms, the stale timer must not open results for the new run/puzzle.

### 1.12 Run the focused route suite

`bun run --cwd apps/web test:unit -- 'src/routes/puzzle/[id]/page.svelte.test.ts'`

Expected: pass.

---

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

Use one restrained CSS animation/state, for example:

- tiny settle scale;
- modest accent/gold glow around the board;
- roughly the same 500 ms duration.

Requirements:

- image remains fully readable;
- no covering overlay;
- no particle nodes;
- no JS animation loop.

Add a `prefers-reduced-motion: reduce` rule that disables the transform/animation defensively.

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

### 3.1 Replace the star-count matrix with non-graded result tests

Delete the tests that expect 1/2/3 stars.

Add a parameterized matrix for:

- `standard_timed` -> `STANDARD TIMED`;
- `rotation_timed` -> `ROTATION TIMED`;
- `assisted_timed` -> `ASSISTED TIMED`;
- `relaxed` -> `RELAXED`.

For every row assert:

- the same `MISSION COMPLETE` clear framing is present;
- the factual label is correct;
- no completion-star markup/aria label exists.

Do not invent a replacement grade assertion.

### 3.2 Delete the local star derivation and star markup

Remove:

- `completionStarCount`;
- star SVG loop;
- star-specific sizing/layout rules that become dead.

Keep `competitiveTimedResult` if it is still needed by record presentation.

### 3.3 Add one consistent clear header

Use the space formerly owned by stars for a simple celebratory clear treatment:

- visible `MISSION COMPLETE`;
- simple existing-theme CSS/SVG clear/check mark;
- factual result label;
- puzzle name.

Do not add a numeric score, letter grade, medal tier, or quality wording.

Make sure the result identity is actually visible in the current full-screen results layout rather than remaining only screen-reader text.

### 3.4 Add local `results | artwork` state

Inside `PuzzleCompletionDialog.svelte` only:

`let completionView = $state<'results' | 'artwork'>('results');`

No route prop and no persisted field.

### 3.5 Add `VIEW ARTWORK` only for a real reference URL

In the results actions:

- when `referenceImageUrl !== null`, render `VIEW ARTWORK`;
- clicking it sets `completionView = 'artwork'`;
- when the URL is null, render no artwork action.

Keep the existing reference fallback in results.

### 3.6 Render the focused artwork view

When `completionView === 'artwork'` and the URL exists:

- keep the same modal/backdrop/focus action;
- render the same image source as the primary content;
- use `object-fit: contain` / viewport-bounded sizing so the full art can be inspected;
- retain an accessible title/alt tied to `puzzleName`;
- render one prominent `BACK TO RESULTS` button.

Do not render Play Again, Back to Arcade, awards, run summary, or retry controls in the artwork subview; they return unchanged when switching back.

Do not add zoom/pan/download/share controls.

### 3.7 Preserve modal dismissal/focus semantics

Keep:

- `role="dialog"`;
- `aria-modal="true"`;
- `modalFocus`;
- existing backdrop Escape -> `onDismiss`.

`BACK TO RESULTS` is explicit subview navigation. Escape remains whole-modal dismissal rather than becoming a second back-navigation rule.

### 3.8 Extend dialog tests

Cover:

- all result facts and awards remain truthful in results view;
- reference URL -> `VIEW ARTWORK` visible;
- click -> focused image uses the same `src` and accessible name;
- result controls are absent while focused art is shown;
- `BACK TO RESULTS` restores results, Play Again, Back to Arcade, and retry action;
- null URL -> fallback visible and no `VIEW ARTWORK`;
- Escape, focus containment, and callback tests continue passing.

### 3.9 Run focused dialog tests

`bun run --cwd apps/web test:unit -- src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`

Expected: pass.

---

## Task 4: Integration gate and scope review

### 4.1 Run focused HPA-465 suites together

`bun run --cwd apps/web test:unit -- 'src/routes/puzzle/[id]/page.svelte.test.ts' src/lib/components/__tests__/PuzzleBoardPanel.svelte.test.ts src/lib/components/__tests__/PuzzleCompletionDialog.svelte.test.ts`

Expected: pass.

### 4.2 Run the full web unit suite

`bun run --cwd apps/web test:unit`

Expected: pass.

### 4.3 Run repository type/lint checks

`bun run check`

Expected: pass.

If this repository’s current main has a known unrelated failure, record the exact baseline and prove HPA-465’s focused suites remain green rather than broadening scope.

### 4.4 Manual browser smoke

Using an existing puzzle/reference asset:

1. normal motion: place final piece -> completed board visibly settles -> results;
2. confirm results data and awards appear;
3. confirm there is no 1/2/3-star grade;
4. open `VIEW ARTWORK` -> full artwork is primary;
5. `BACK TO RESULTS` -> same results/actions remain;
6. Play Again still restarts;
7. complete/restore a persisted completed run -> results immediately, no reveal replay;
8. reduced-motion mode -> results immediately;
9. puzzle with unavailable reference -> fallback only, no artwork button;
10. retry-sync state remains actionable.

No new image or audio asset verification is needed.

### 4.5 Final scope check

The implementation diff should stay within the six planned source/test files plus these planning documents.

Reject scope creep into:

- game-core/session schema;
- scoring/progression;
- API/backend;
- generic animation/viewer infrastructure;
- mobile parity;
- generated art/SFX;
- unrelated puzzle-route cleanup.

### 4.6 Keep the same PR

After planning review, continue Tasks 1-4 on this branch and update this same draft PR’s description/checklist as implementation lands.

Do not open a second HPA-465 implementation PR.
